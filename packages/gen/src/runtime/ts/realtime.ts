/**
 * The realtime resume protocol's client side (H8): the frames a server sends, the errors a
 * connection ends with, the transport adapters a consumer plugs in, the keepalive loop and the
 * fallback chain that picks the first transport to answer `ready`.
 */

export type ServerFrame =
	| { data: unknown; id: number; t: "msg" }
	| { t: "pong" }
	| { reason: string; t: "bye" }
	| { reconnectToken: string; t: "ready" }

export class RealtimeError extends Error {
	readonly reason: string

	constructor(message: string, reason: string) {
		super(message)
		this.reason = reason
		this.name = "RealtimeError"
	}
}

export class RealtimeConnectError extends RealtimeError {
	override name = "RealtimeConnectError"
}

export class RealtimeKickedError extends RealtimeError {
	override name = "RealtimeKickedError"
}

export class RealtimeAbortError extends RealtimeError {
	override name = "RealtimeAbortError"
}

export type Transport = "longpoll" | "sse" | "ws"

export type ConnectionState = "closed" | "connected" | "connecting" | "draining" | "idle" | "reconnecting"

export type TransportOpts = {
	headers?: Record<string, string>
	lastId?: number
	reconnectToken?: string
	signal?: AbortSignal
}

/** One live transport: the adapter calls `onFrame`, `onClose` and `onError`; the client replaces them. */
export type TransportConnection = {
	close(): void
	onClose: (reason: string) => void
	onError: (err: unknown) => void
	onFrame: (frame: ServerFrame) => void
	send(data: string): void
}

export type TransportAdapter = {
	connect(url: string, opts: TransportOpts): TransportConnection
}

/** The transport the adapter at `index` of a chain stands for: WebSocket, then SSE, then long polling. */
export function transportAt(index: number): Transport {
	if (index === 0) return "ws"
	return index === 1 ? "sse" : "longpoll"
}

export type KeepaliveOptions = {
	interval?: number
	onDead: () => void
	sendPing: () => void
	timeout?: number
	transport: Transport
}

export type KeepaliveLoop = { onFrame(): void; onPong(): void; start(): void; stop(): void }

/**
 * A connection's liveness: over WebSocket a ping every `interval` and dead after `timeout` without
 * a pong; over SSE dead after `timeout` without a frame; long polling needs none.
 */
class Keepalive implements KeepaliveLoop {
	readonly #opts: KeepaliveOptions
	#ping: ReturnType<typeof setInterval> | null = null
	#dead: ReturnType<typeof setTimeout> | null = null

	constructor(opts: KeepaliveOptions) {
		this.#opts = opts
	}

	#armDead(): void {
		if (this.#dead !== null) clearTimeout(this.#dead)
		this.#dead = setTimeout(() => this.#opts.onDead(), this.#opts.timeout ?? 60_000)
	}

	start(): void {
		this.stop()
		const { transport } = this.#opts
		if (transport === "longpoll") return
		if (transport === "ws") this.#ping = setInterval(() => this.#opts.sendPing(), this.#opts.interval ?? 25_000)
		this.#armDead()
	}

	stop(): void {
		if (this.#ping !== null) clearInterval(this.#ping)
		if (this.#dead !== null) clearTimeout(this.#dead)
		this.#ping = null
		this.#dead = null
	}

	onPong(): void {
		if (this.#dead !== null) this.#armDead()
	}

	onFrame(): void {
		if (this.#opts.transport === "sse" && this.#dead !== null) this.#armDead()
	}
}

export function createKeepaliveLoop(opts: KeepaliveOptions): KeepaliveLoop {
	return new Keepalive(opts)
}

/** The keepalive `set` gives `transport` (WebSocket 20 s unless set, SSE none; 0 none), dead an interval after a ping. */
export function keepaliveOf(
	set: number | undefined,
	transport: Transport,
	conn: { send(data: string): void },
	onDead: () => void,
): KeepaliveLoop | null {
	const interval = set ?? (transport === "ws" ? 20_000 : 0)
	if (interval <= 0) return null
	const sendPing = () => conn.send(JSON.stringify({ t: "ping" }))
	return createKeepaliveLoop({ interval, onDead, sendPing, timeout: 2 * interval, transport })
}

/** Dial `adapter` and resolve once it sends `ready`; reject on an error, a close or `timeout`. */
export function dialReady(
	adapter: TransportAdapter,
	target: { opts: TransportOpts; url: string },
	timeout: number,
): Promise<TransportConnection> {
	return new Promise((resolve, reject) => {
		const conn = adapter.connect(target.url, target.opts)
		const timer = setTimeout(() => {
			conn.close()
			reject(new Error("timeout"))
		}, timeout)
		const onFrame = conn.onFrame
		conn.onFrame = (frame) => {
			if (frame.t !== "ready") return onFrame(frame)
			clearTimeout(timer)
			conn.onFrame = onFrame
			resolve(conn)
		}
		conn.onError = (err) => {
			clearTimeout(timer)
			conn.close()
			reject(err)
		}
		conn.onClose = (reason) => {
			clearTimeout(timer)
			reject(new Error(reason))
		}
	})
}

/** The dial statuses no retry changes, most specific highest. */
const RANK: Record<number, number> = { 400: 3, 401: 6, 403: 5, 404: 1, 405: 1, 410: 2, 422: 4 }
const rank = (err: unknown) => RANK[(err as { status?: number } | null)?.status ?? 0] ?? 0
export const refused = (err: unknown): boolean => rank(err) > 0
/** Dial transport 0, 1, … until one opens; else its last transient failure, or every one refused, its most specific. */
export async function walkChain<T>(
	count: number,
	dial: (index: number) => Promise<T>,
	opened: (index: number) => unknown,
): Promise<T> {
	let transient: unknown
	let refusal: unknown
	for (let i = 0; i < count; i++) {
		try {
			const conn = await dial(i)
			opened(i)
			return conn
		} catch (err) {
			if (!refused(err)) transient = err
			else if (rank(err) > rank(refusal)) refusal = err
		}
	}
	throw transient ?? refusal
}

export type FallbackChain = {
	connect(url: string, transportOpts: TransportOpts): Promise<{ conn: TransportConnection; transport: Transport }>
	readonly provenTransport: Transport | null
}

/** Try each transport in order until one is ready; remember the one that worked and try it first next time. */
class Chain implements FallbackChain {
	readonly #transports: TransportAdapter[]
	readonly #timeout: number
	#proven: number | null = null

	constructor(opts: { timeout?: number; transports: TransportAdapter[] }) {
		this.#transports = opts.transports
		this.#timeout = opts.timeout ?? 3000
	}

	get provenTransport(): Transport | null {
		return this.#proven === null ? null : transportAt(this.#proven)
	}

	async #dial(url: string, opts: TransportOpts) {
		const proven = this.#proven
		if (proven !== null && proven < this.#transports.length) {
			try {
				const conn = await dialReady(this.#transports[proven] as TransportAdapter, { opts, url }, this.#timeout)
				return { conn, transport: transportAt(proven) }
			} catch {
				/* the proven transport failed: fall through to the whole chain */
			}
		}
		for (let i = 0; i < this.#transports.length; i++) {
			try {
				const conn = await dialReady(this.#transports[i] as TransportAdapter, { opts, url }, this.#timeout)
				this.#proven = i
				return { conn, transport: transportAt(i) }
			} catch {
				/* try the next one */
			}
		}
		throw new RealtimeConnectError("All transports failed", "all_failed")
	}

	connect(url: string, opts: TransportOpts): Promise<{ conn: TransportConnection; transport: Transport }> {
		const attempt =
			this.#transports.length === 0
				? Promise.reject(new RealtimeConnectError("No transports configured", "no_transports"))
				: this.#dial(url, opts)
		/* a caller that never awaits the attempt must not see an unhandled rejection */
		attempt.catch(() => {})
		return attempt
	}
}

export function createFallbackChain(opts: { timeout?: number; transports: TransportAdapter[] }): FallbackChain {
	return new Chain(opts)
}

export type ResumableConnectionOpts = {
	fallbackTimeout?: number
	/** Each dial's headers; a function is read on every dial, so a rotated token reaches the reconnect. */
	headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>)
	/** Ping every this many ms (WebSocket 20 s, SSE none, unless set; 0: none); one unanswered as long reconnects. */
	keepaliveInterval?: number
	lastId?: number
	/** Reconnects after a drop before the stream ends; 0 retries forever. Default 5. */
	maxReconnectAttempts?: number
	onReconnected?: () => void
	onReconnecting?: (attempt: number, transport: Transport) => void
	reconnectDelayMs?: number
	reconnectToken?: string
	signal?: AbortSignal
	transports: TransportAdapter[]
	url: string
}

export type ResumableConnection = {
	close(reason?: string): void
	readonly provenTransport: Transport | null
	send(data: unknown): void
	readonly state: ConnectionState
	[Symbol.asyncIterator](): AsyncIterableIterator<unknown>
}
