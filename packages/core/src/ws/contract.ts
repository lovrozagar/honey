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

/** The socket a WebSocket handler talks to, the same on Node, Bun and Workers. `T` is the runtime's own socket type. */
export type WSContext<T = unknown> = {
	/** Outbound bytes the runtime holds unsent, when it reports them (0 otherwise). */
	readonly bufferedAmount?: number
	/** Close the connection; a reason over 123 UTF-8 bytes is cut to fit. */
	close(code?: number, reason?: string): void
	/** The runtime's own socket object, for anything `WSContext` does not cover. */
	readonly raw: T
	/** Connection state: 0 connecting, 1 open, 2 closing, 3 closed. */
	readonly readyState: WSReadyState
	/**
	 * Send a message; any other value goes as JSON. While the socket opens, the newest 32 wait
	 * for it; after it closed they are dropped. Over the adapter's backpressure limit its policy
	 * applies (close with 1013, or drop).
	 */
	send(data: ArrayBuffer | Uint8Array | object | string): void
}

/**
 * The callbacks of a WebSocket route. Each receives the route's request context and the socket. They run one at a
 * time, in order: open, then messages, then close. A throw or rejection is passed to `onError`, else logged.
 */
export type WSHandler<TCtx = unknown> = {
	/** Runs once when the connection closes, with the close code and reason. */
	onClose?(ctx: TCtx, ws: WSContext, code: number, reason: string): Promise<void> | void
	/** Runs when the connection reports an error, or when another callback throws or rejects. Its own failure is logged. */
	onError?(ctx: TCtx, ws: WSContext, error: unknown): Promise<void> | void
	/**
	 * Runs for each inbound message: text as a string, binary as an `ArrayBuffer`. A message that finds 1024 waiting for
	 * this callback closes the connection with 1008.
	 */
	onMessage?(ctx: TCtx, ws: WSContext, data: ArrayBuffer | string): Promise<void> | void
	/** Runs once when the connection opens, unless `onReconnect` runs in its place. */
	onOpen?(ctx: TCtx, ws: WSContext): Promise<void> | void
	/** In place of `onOpen` when the client reconnects with a `reconnect_token`; the token is client data. */
	onReconnect?(ctx: TCtx, ws: WSContext, token: string): Promise<void> | void
}

/**
 * What a runtime adapter provides: it upgrades a request to a WebSocket and wires the socket to a handler. Use
 * `nodeWebSocket()`, `bunWebSocket()` or `workersWebSocket()`.
 */
export type WSAdapter = {
	/**
	 * Upgrade `req` to a WebSocket handled by `handler`. Returns the 101 response and the connection's context. Honey
	 * calls this for each WebSocket route; app code does not.
	 */
	upgrade(
		req: Request,
		env: unknown,
		handler: WSHandler<unknown>,
	):
		| Promise<{
				/** The 101 for this request. Only Workers sends it; Node and Bun write the handshake themselves. */
				response: Response
				/** The connection's context. `undefined` on Bun, which opens the socket later and passes it to `handler`. */
				socket: WSContext
		  }>
		| {
				/** The 101 for this request. Only Workers sends it; Node and Bun write the handshake themselves. */
				response: Response
				/** The connection's context. `undefined` on Bun, which opens the socket later and passes it to `handler`. */
				socket: WSContext
		  }
	/** Close every open connection (graceful shutdown). */
	closeAll?(code: number, reason: string): void
	/** The adapter's options with defaults applied. */
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

/**
 * The socket handle the constructor built, on that handle: one derived with `Object.create(ws)` reaches it
 * through its prototype, so its methods use the original's queue and limits rather than throwing for the
 * private fields it lacks.
 */
const SELF: unique symbol = /* @__PURE__ */ Symbol("honey.wsContext")

/** `WSContext` over a runtime socket: JSON for objects, a queue while opening, the backpressure policy. */
export class WSContextImpl<T extends RawSocket = RawSocket> implements WSContext<T> {
	readonly raw: T
	readonly [SELF]: WSContextImpl<T> = this
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
		const self = this[SELF]
		const queued = self.#queue
		self.#queue = []
		for (const message of queued) self.send(message)
	}

	close(code?: number, reason?: string): void {
		const self = this[SELF]
		self.#queue = []
		self.raw.close(code, reason === undefined ? undefined : truncateUtf8(reason, MAX_CLOSE_REASON))
	}

	send(data: ArrayBuffer | Uint8Array | object | string): void {
		const self = this[SELF]
		const payload =
			typeof data === "string" || data instanceof ArrayBuffer || data instanceof Uint8Array
				? data
				: JSON.stringify(data)
		const state = self.raw.readyState
		if (state === 1) return self.#sendOpen(payload)
		/* closing or closed: nothing would ever send it */
		if (state !== 0) return
		if (self.#queue.length >= WS_SEND_BUFFER_MAX) self.#queue.shift()
		self.#queue.push(payload)
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
		/* Fetch refuses 101 outside Workers: expected, not a failure; the runtime writes the real handshake */
		const response = new Response(null, { headers })
		Object.defineProperty(response, "status", { value: 101 })
		return response
	}
}

/** Call an adapter event on the handler; what it throws or rejects is logged, never thrown into the runtime. */
export function fireHandler(phase: string, fn: () => unknown, log?: InvokeLogger | null): void {
	void invokeUser(fn, { log, phase: `websocket ${phase}` })
}
