/**
 * The WebSocket contract every adapter and the session share: the socket a handler talks to, the
 * route's handler, the adapter shape, and `WSContextImpl` over a runtime socket. A plain module:
 * importing it registers nothing (H23).
 */
import { invokeUser, type InvokeLogger } from "../realtime/invoke-user.ts"
import { bufferedAmountOf, CLOSE_TRY_AGAIN, MAX_CLOSE_REASON, type ResolvedWSOptions, truncateUtf8 } from "./shared.ts"

/** CONNECTING, OPEN, CLOSING, CLOSED. */
export type WSReadyState = 0 | 1 | 2 | 3

/** Messages kept while a socket is still opening; past this the oldest goes. */
export const WS_SEND_BUFFER_MAX = 32

export type WSContext<T = unknown> = {
	/** Outbound bytes the runtime holds unsent, when it reports them (0 otherwise). */
	readonly bufferedAmount?: number
	/** Close the connection; a reason over 123 UTF-8 bytes is cut to fit. */
	close(code?: number, reason?: string): void
	readonly raw: T
	readonly readyState: WSReadyState
	/**
	 * Send a message; any other value goes as JSON. While the socket opens, the newest 32 wait
	 * for it; after it closed they are dropped. Over the adapter's backpressure limit its policy
	 * applies (close with 1013, or drop).
	 */
	send(data: ArrayBuffer | Uint8Array | object | string): void
}

export type WSHandler<TCtx = unknown> = {
	onClose?(ctx: TCtx, ws: WSContext, code: number, reason: string): Promise<void> | void
	onError?(ctx: TCtx, ws: WSContext, error: unknown): Promise<void> | void
	onMessage?(ctx: TCtx, ws: WSContext, data: ArrayBuffer | string): Promise<void> | void
	onOpen?(ctx: TCtx, ws: WSContext): Promise<void> | void
	/** In place of `onOpen` when the client reconnects with a `reconnect_token`; the token is client data. */
	onReconnect?(ctx: TCtx, ws: WSContext, token: string): Promise<void> | void
}

export type WSAdapter = {
	upgrade(
		req: Request,
		env: unknown,
		handler: WSHandler<unknown>,
	): Promise<{ response: Response; socket: WSContext }> | { response: Response; socket: WSContext }
	/** Close every open connection (graceful shutdown). */
	closeAll?(code: number, reason: string): void
	readonly options?: ResolvedWSOptions
	/** The runtime the adapter upgrades on; `serve(app)` refuses another runtime's adapter. */
	readonly runtime?: "bun" | "node" | "workers"
}

export type RawSocket = {
	close(code?: number, reason?: string): void
	readyState: number
	send(data: ArrayBuffer | Uint8Array | string): void
}

type Limits = Pick<ResolvedWSOptions, "backpressureLimit" | "backpressurePolicy">

/** `WSContext` over a runtime socket: JSON for objects, a queue while opening, the backpressure policy. */
export class WSContextImpl<T extends RawSocket = RawSocket> implements WSContext<T> {
	readonly raw: T
	readonly #limits: Limits | null
	#queue: (ArrayBuffer | Uint8Array | string)[] = []

	constructor(raw: T, limits?: Limits) {
		this.raw = raw
		this.#limits = limits ?? null
		const target = raw as T & { addEventListener?(type: string, listener: () => void): void }
		if (raw.readyState !== 1 && typeof target.addEventListener === "function") {
			target.addEventListener("open", () => this.flush())
		}
	}

	get bufferedAmount(): number {
		return bufferedAmountOf(this.raw)
	}

	get readyState(): WSReadyState {
		return this.raw.readyState as WSReadyState
	}

	/** Send what waited while the socket opened; adapters without an `open` event call this. */
	flush(): void {
		const queued = this.#queue
		this.#queue = []
		for (const message of queued) this.send(message)
	}

	close(code?: number, reason?: string): void {
		this.#queue = []
		this.raw.close(code, reason === undefined ? undefined : truncateUtf8(reason, MAX_CLOSE_REASON))
	}

	send(data: ArrayBuffer | Uint8Array | object | string): void {
		const payload =
			typeof data === "string" || data instanceof ArrayBuffer || data instanceof Uint8Array
				? data
				: JSON.stringify(data)
		const state = this.raw.readyState
		if (state === 1) return this.#sendOpen(payload)
		/* closing or closed: nothing would ever send it */
		if (state !== 0) return
		if (this.#queue.length >= WS_SEND_BUFFER_MAX) this.#queue.shift()
		this.#queue.push(payload)
	}

	#sendOpen(payload: ArrayBuffer | Uint8Array | string): void {
		const limits = this.#limits
		if (limits !== null && limits.backpressureLimit > 0 && this.bufferedAmount > limits.backpressureLimit) {
			if (limits.backpressurePolicy === "close") this.close(CLOSE_TRY_AGAIN, "slow consumer")
			return
		}
		this.raw.send(payload)
	}
}

/**
 * The 101 an adapter answers an upgrade with. Workers builds a real one, carrying its socket in
 * `init`; Fetch elsewhere refuses status 101, so there it is an empty response that reports 101:
 * dispatch passes it on unchanged and the runtime writes the real handshake itself.
 */
export function switchingProtocols(headers: Record<string, string>, init?: Record<string, unknown>): Response {
	try {
		return new Response(null, { ...init, headers, status: 101 })
	} catch {
		const response = new Response(null, { headers })
		Object.defineProperty(response, "status", { value: 101 })
		return response
	}
}

/** Call an adapter event on the handler; what it throws or rejects is logged, never thrown into the runtime. */
export function fireHandler(phase: string, fn: () => unknown, log?: InvokeLogger | null): void {
	void invokeUser(fn, { log, phase: `websocket ${phase}` })
}
