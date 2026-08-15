import type { ServerFrame } from "./protocol.ts"

/* ------------------------------------------------------------------ */
/*  Error hierarchy                                                    */
/* ------------------------------------------------------------------ */

export class RealtimeError extends Error {
	readonly reason: string

	constructor(message: string, reason: string) {
		super(message)
		this.reason = reason
		this.name = "RealtimeError"
	}
}

export class RealtimeConnectError extends RealtimeError {
	constructor(message: string, reason: string) {
		super(message, reason)
		this.name = "RealtimeConnectError"
	}
}

export class RealtimeAuthError extends RealtimeError {
	constructor(message: string, reason: string) {
		super(message, reason)
		this.name = "RealtimeAuthError"
	}
}

export class RealtimeKickedError extends RealtimeError {
	constructor(message: string, reason: string) {
		super(message, reason)
		this.name = "RealtimeKickedError"
	}
}

export class RealtimeAbortError extends RealtimeError {
	constructor(message: string, reason: string) {
		super(message, reason)
		this.name = "RealtimeAbortError"
	}
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type Transport = "ws" | "sse" | "longpoll"
export type ConnectionState = "idle" | "connecting" | "connected" | "draining" | "reconnecting" | "closed"

export type TransportAdapter = {
	connect(url: string, opts: TransportOpts): TransportConnection
}

export type TransportConnection = {
	send(data: string): void
	close(): void
	onFrame: (frame: ServerFrame) => void
	onClose: (reason: string) => void
	onError: (err: unknown) => void
}

export type TransportOpts = {
	signal?: AbortSignal
	headers?: Record<string, string>
	lastId?: number
	reconnectToken?: string
}

/* ------------------------------------------------------------------ */
/*  KeepaliveLoop                                                      */
/* ------------------------------------------------------------------ */

export function createKeepaliveLoop(opts: {
	transport: Transport
	sendPing: () => void
	onDead: () => void
	interval?: number
	timeout?: number
}): { start(): void; stop(): void; onPong(): void; onFrame(): void } {
	const interval = opts.interval ?? 25_000
	const timeout = opts.timeout ?? 60_000
	const transport = opts.transport

	let pingTimer: ReturnType<typeof setInterval> | null = null
	let deadTimer: ReturnType<typeof setTimeout> | null = null

	function clearAll(): void {
		if (pingTimer !== null) {
			clearInterval(pingTimer)
			pingTimer = null
		}
		if (deadTimer !== null) {
			clearTimeout(deadTimer)
			deadTimer = null
		}
	}

	function resetDeadTimer(): void {
		if (deadTimer !== null) {
			clearTimeout(deadTimer)
		}
		deadTimer = setTimeout(() => {
			opts.onDead()
		}, timeout)
	}

	function start(): void {
		/* Idempotent — stop first to avoid stacking timers */
		clearAll()

		if (transport === "longpoll") return

		if (transport === "ws") {
			pingTimer = setInterval(() => {
				opts.sendPing()
			}, interval)
			resetDeadTimer()
			return
		}

		if (transport === "sse") {
			/* SSE: no pings, just idle timer based on frames from server */
			resetDeadTimer()
		}
	}

	function stop(): void {
		clearAll()
	}

	function onPong(): void {
		/* Only meaningful for WS — reset the dead timer */
		if (deadTimer !== null) {
			resetDeadTimer()
		}
	}

	function onFrame(): void {
		/* Meaningful for SSE — reset idle timer on any frame */
		if (transport === "sse" && deadTimer !== null) {
			resetDeadTimer()
		}
	}

	return { onFrame, onPong, start, stop }
}

/* ------------------------------------------------------------------ */
/*  FallbackChain                                                      */
/* ------------------------------------------------------------------ */

const DEFAULT_FALLBACK_TIMEOUT = 3000

export function createFallbackChain(opts: { transports: TransportAdapter[]; timeout?: number }): {
	connect(url: string, transportOpts: TransportOpts): Promise<{ conn: TransportConnection; transport: Transport }>
	readonly provenTransport: Transport | null
} {
	const timeout = opts.timeout ?? DEFAULT_FALLBACK_TIMEOUT
	let proven: Transport | null = null

	function tryTransport(
		adapter: TransportAdapter,
		url: string,
		transportOpts: TransportOpts,
	): Promise<TransportConnection> {
		return new Promise((resolve, reject) => {
			const conn = adapter.connect(url, transportOpts)

			const timer = setTimeout(() => {
				conn.close()
				reject(new Error("timeout"))
			}, timeout)

			const originalOnFrame = conn.onFrame
			conn.onFrame = (frame: ServerFrame) => {
				if (frame.t === "ready") {
					clearTimeout(timer)
					conn.onFrame = originalOnFrame
					resolve(conn)
				} else {
					originalOnFrame(frame)
				}
			}

			conn.onError = (err: unknown) => {
				clearTimeout(timer)
				conn.close()
				reject(err)
			}

			conn.onClose = (reason: string) => {
				clearTimeout(timer)
				reject(new Error(reason))
			}
		})
	}

	function connect(
		url: string,
		transportOpts: TransportOpts,
	): Promise<{ conn: TransportConnection; transport: Transport }> {
		const transports = opts.transports

		if (transports.length === 0) {
			const p = Promise.reject(new RealtimeConnectError("No transports configured", "no_transports"))
			p.catch(() => {})
			return p
		}

		const p = connectInternal(url, transportOpts, transports)
		p.catch(() => {})
		return p
	}

	async function connectInternal(
		url: string,
		transportOpts: TransportOpts,
		transports: TransportAdapter[],
	): Promise<{ conn: TransportConnection; transport: Transport }> {
		/* If we have a proven transport, try it first (it's at a specific index) */
		if (proven !== null) {
			/* proven refers to index position — try that adapter directly */
			const provenIndex = provenIndexStore
			if (provenIndex !== null && provenIndex < transports.length) {
				try {
					const conn = await tryTransport(transports[provenIndex], url, transportOpts)
					return { conn, transport: proven }
				} catch {
					/* Proven transport failed — fall through to full chain */
				}
			}
		}

		for (let i = 0; i < transports.length; i++) {
			try {
				const conn = await tryTransport(transports[i], url, transportOpts)
				/* Record proven transport — we use the index to map to a transport name */
				let transportName: Transport = "longpoll"
				if (i === 0) transportName = "ws"
				else if (i === 1) transportName = "sse"
				proven = transportName
				provenIndexStore = i
				return { conn, transport: transportName }
			} catch {
				/* Try next */
			}
		}

		throw new RealtimeConnectError("All transports failed", "all_failed")
	}

	let provenIndexStore: number | null = null

	return {
		connect,
		get provenTransport() {
			return proven
		},
	}
}

/* ------------------------------------------------------------------ */
/*  ResumableConnection                                                 */
/* ------------------------------------------------------------------ */

export type ResumableConnectionOpts = {
	url: string
	token?: () => string | Promise<string>
	onAuthExpired?: () => Promise<string | null>
	onReconnecting?: (attempt: number, transport: Transport) => void
	onReconnected?: () => void
	signal?: AbortSignal
	transports?: Transport[]
	keepaliveInterval?: number
}

type QueueEntry = { type: "value"; value: unknown } | { type: "done" } | { type: "error"; error: unknown }

export function createResumableConnection(opts: ResumableConnectionOpts): {
	readonly state: ConnectionState
	send(data: unknown): void
	close(reason?: string): void
	[Symbol.asyncIterator](): AsyncIterableIterator<unknown>
} {
	let state: ConnectionState = "idle"
	let currentConn: TransportConnection | null = null
	let started = false

	/* Check if already aborted */
	if (opts.signal?.aborted) {
		state = "closed"
	}

	/* Queue-based async iterator infrastructure */
	const queue: QueueEntry[] = []
	let pending: {
		resolve: (result: IteratorResult<unknown>) => void
		reject: (err: unknown) => void
	} | null = null

	function enqueue(entry: QueueEntry): void {
		if (pending) {
			const { resolve, reject } = pending
			pending = null

			if (entry.type === "value") {
				resolve({ done: false, value: entry.value })
			} else if (entry.type === "done") {
				resolve({ done: true, value: undefined })
			} else {
				reject(entry.error)
			}
		} else {
			queue.push(entry)
		}
	}

	function terminate(entry: QueueEntry): void {
		enqueue(entry)
	}

	function handleClose(): void {
		if (state === "closed") return
		state = "closed"
		if (currentConn) {
			currentConn.close()
			currentConn = null
		}
		terminate({ type: "done" })
	}

	function handleAbort(): void {
		if (state === "closed") return
		state = "closed"
		if (currentConn) {
			currentConn.close()
			currentConn = null
		}
		terminate({ error: new RealtimeAbortError("Connection aborted", "aborted"), type: "error" })
	}

	/* Listen for abort signal */
	if (opts.signal && !opts.signal.aborted) {
		opts.signal.addEventListener(
			"abort",
			() => {
				handleAbort()
			},
			{ once: true },
		)
	}

	function startConnection(): void {
		if (started || state === "closed") return
		started = true
		state = "connecting"

		/* Kick off connection in a microtask */
		queueMicrotask(() => {
			if (state === "closed") return

			/* In a real implementation, this would use createFallbackChain.
			   For now, state transitions are driven by external transport frames. */
		})
	}

	function send(data: unknown): void {
		if (state === "closed" || !currentConn) return
		currentConn.send(JSON.stringify(data))
	}

	function close(_reason?: string): void {
		handleClose()
	}

	function next(): Promise<IteratorResult<unknown>> {
		/* First next() call triggers connection */
		if (!started && state !== "closed") {
			startConnection()
		}

		/* Check queue first */
		if (queue.length > 0) {
			const entry = queue.shift()
			if (!entry || entry.type === "done") {
				return Promise.resolve({ done: true, value: undefined })
			}
			if (entry.type === "value") {
				return Promise.resolve({ done: false, value: entry.value })
			}
			return Promise.reject(entry.error)
		}

		/* If already closed, return done */
		if (state === "closed") {
			return Promise.resolve({ done: true, value: undefined })
		}

		/* Wait for next entry — attach a no-op catch to suppress Node's
		   unhandled-rejection warning while the caller awaits the promise */
		const promise = new Promise<IteratorResult<unknown>>((resolve, reject) => {
			pending = { reject, resolve }
		})
		promise.catch(() => {})
		return promise
	}

	function asyncIterator(): AsyncIterableIterator<unknown> {
		return {
			next,
			[Symbol.asyncIterator]() {
				return this
			},
		}
	}

	return {
		[Symbol.asyncIterator]: asyncIterator,
		close,
		send,
		get state() {
			return state
		},
	}
}
