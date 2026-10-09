import { invokeUser } from "../invoke-user.ts"
import { truncateUtf8 } from "../realtime/route.ts"
import type { WSReadyState } from "../types.ts"
import {
	bufferedAmountOf,
	CLOSE_TOO_BIG,
	CLOSE_TRY_AGAIN,
	exceedsPayload,
	MAX_CLOSE_REASON,
	type ResolvedWSOptions,
	resolveWSOptions,
	selectProtocol,
	sendableCloseCode,
	type WSAdapterOptions,
} from "./shared.ts"

export type { WSAdapterOptions } from "./shared.ts"

export const WS_SEND_BUFFER_MAX = 32

export type WSContext<T = unknown> = {
	/** Outbound bytes the runtime holds unsent, when it reports them (0 otherwise). Adapters' sockets have it; a hand-written stub may not. */
	readonly bufferedAmount?: number
	/** Close the connection. A reason longer than 123 UTF-8 bytes is cut to fit. */
	close(code?: number, reason?: string): void
	raw: T
	readyState: WSReadyState
	/**
	 * Send a message; objects are sent as JSON. While the socket is still opening, up to 32
	 * messages wait for it; after it closed they are dropped. Over the adapter's backpressure
	 * limit the adapter's policy applies (close with 1013, or drop).
	 */
	send(data: ArrayBuffer | Uint8Array | object | string): void
}

export type WSHandler<TCtx = unknown> = {
	onClose?(ctx: TCtx, ws: WSContext, code: number, reason: string): Promise<void> | void
	onError?(ctx: TCtx, ws: WSContext, error: unknown): Promise<void> | void
	onMessage?(ctx: TCtx, ws: WSContext, data: ArrayBuffer | string): Promise<void> | void
	onOpen?(ctx: TCtx, ws: WSContext): Promise<void> | void
	onReconnect?(ctx: TCtx, ws: WSContext, token: string): Promise<void> | void
}

export type WSPreUpgrade = {
	response: Response
	socket: WSContext
	/** Run `fn` now if the socket is already open, otherwise on the next open. */
	whenOpen(fn: () => void): void
}

export type WSAdapter = {
	upgrade(
		req: Request,
		env: unknown,
		handler: WSHandler<unknown>,
	): Promise<{ response: Response; socket: WSContext }> | { response: Response; socket: WSContext }
	/**
	 * Deno requires `Deno.upgradeWebSocket` in the same turn as the serve
	 * callback. When present, Honey calls this synchronously from `fetch`
	 * and returns `response` before any middleware Promise.
	 */
	preUpgrade?(req: Request): WSPreUpgrade | undefined
	/** Close every open connection (graceful shutdown). */
	closeAll?(code: number, reason: string): void
	/** The adapter's resolved options. */
	readonly options?: ResolvedWSOptions
}

export type RawSocket = {
	close(code?: number, reason?: string): void
	readyState: number
	send(data: ArrayBuffer | Uint8Array | string): void
}

export class WSContextImpl<T extends RawSocket = RawSocket> implements WSContext<T> {
	raw: T
	private sendBuffer: Array<ArrayBuffer | Uint8Array | string> = []
	private readonly limits: Pick<ResolvedWSOptions, "backpressureLimit" | "backpressurePolicy"> | null

	constructor(raw: T, opts?: Pick<ResolvedWSOptions, "backpressureLimit" | "backpressurePolicy">) {
		this.raw = raw
		this.limits = opts ?? null
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

	/** Send what was queued while the socket was opening (adapters without an `open` event call this). */
	flush(): void {
		const queued = this.sendBuffer
		this.sendBuffer = []
		for (const msg of queued) this.send(msg)
	}

	close(code?: number, reason?: string): void {
		this.sendBuffer = []
		this.raw.close(code, reason === undefined ? undefined : truncateUtf8(reason, MAX_CLOSE_REASON))
	}

	send(data: ArrayBuffer | Uint8Array | object | string): void {
		const payload =
			typeof data === "string" || data instanceof ArrayBuffer || data instanceof Uint8Array
				? data
				: JSON.stringify(data)
		const state = this.raw.readyState
		if (state === 1) {
			const limits = this.limits
			if (limits !== null && limits.backpressureLimit > 0 && this.bufferedAmount > limits.backpressureLimit) {
				if (limits.backpressurePolicy === "close") this.close(CLOSE_TRY_AGAIN, "slow consumer")
				return
			}
			this.raw.send(payload)
			return
		}
		/* closing or closed: nothing will ever send it */
		if (state !== 0) return
		if (this.sendBuffer.length >= WS_SEND_BUFFER_MAX) this.sendBuffer.shift()
		this.sendBuffer.push(payload)
	}
}

/** Call an adapter event on the handler; whatever it throws is logged, never thrown into the runtime. */
export function fireHandler(phase: string, fn: () => unknown): void {
	void invokeUser(fn, { phase: `websocket ${phase}` })
}

/**
 * Cloudflare Workers WebSocket adapter.
 * Uses WebSocketPair + server.accept() + addEventListener. `idleTimeout` is not enforced:
 * Workers has no ping API and evicts idle sockets itself.
 */
export function cfWebSocket(opts?: WSAdapterOptions): WSAdapter {
	const options = resolveWSOptions(opts)
	return {
		options,
		upgrade(req: Request, _env: unknown, handler: WSHandler<unknown>) {
			type CFWebSocket = RawSocket & { accept(): void }
			const Ctor = (globalThis as Record<string, unknown>)["WebSocketPair"] as new () => [CFWebSocket, CFWebSocket]
			const [client, server] = new Ctor()
			server.accept()
			const socket = new WSContextImpl(server, options)

			const raw = server as unknown as EventTarget & RawSocket
			if ("addEventListener" in raw) {
				raw.addEventListener("message", (evt: Event) => {
					const data = (evt as MessageEvent).data as ArrayBuffer | string
					if (exceedsPayload(data, options.maxPayload)) {
						socket.close(CLOSE_TOO_BIG, "message too big")
						return
					}
					fireHandler("message", () => handler.onMessage?.(undefined, socket, data))
				})
				raw.addEventListener("close", (evt: Event) => {
					const closeEvt = evt as CloseEvent
					fireHandler("close", () => handler.onClose?.(undefined, socket, closeEvt.code, closeEvt.reason))
					/* echo the close frame so the client's handshake completes; 1005 and 1006 are never sent */
					try {
						server.close(sendableCloseCode(closeEvt.code), closeEvt.reason)
					} catch {
						/* already closed */
					}
				})
				raw.addEventListener("error", (evt: Event) => {
					fireHandler("error", () => handler.onError?.(undefined, socket, evt))
				})
			}
			fireHandler("open", () => handler.onOpen?.(undefined, socket))

			const headers: Record<string, string> = { upgrade: "websocket" }
			const protocol = selectProtocol(req, options)
			if (protocol !== null) headers["sec-websocket-protocol"] = protocol
			return {
				response: new Response(null, {
					headers,
					status: 101,
					webSocket: client,
				} as unknown as ResponseInit),
				socket,
			}
		},
	}
}
