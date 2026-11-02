/**
 * The Bun WebSocket adapter: `server.upgrade(req)` with the connection's handler stored on the
 * socket, and the `websocket` callbacks `Bun.serve` takes at creation (`serve(app)` passes them).
 * Bun pings idle sockets itself (`idleTimeout`, whole seconds, at most 960) and has no error
 * event. Bun creates the socket lazily, so the context is made on its first event, whichever it is.
 */
import {
	fireHandler,
	switchingProtocols,
	type WSAdapter,
	type WSContext,
	WSContextImpl,
	type WSHandler,
} from "./contract.ts"
import { resolveWSOptions, selectProtocol, toArrayBuffer, type WSAdapterOptions } from "./shared.ts"

/**
 * Per-connection data Bun keeps on the socket: the route's handler, and the `WSContext` once the first event created
 * it.
 */
type BunSocketData = {
	/** The route's handler for this connection. */
	readonly handler: WSHandler<unknown>
	/** The context handed to the handler; created on the connection's first event. */
	socket?: WSContext
}

/** The slice of Bun's `ServerWebSocket` the adapter uses. */
type BunSocket = {
	/** Close the connection with an optional code and reason. */
	close(code?: number, reason?: string): void
	/** The per-connection data given to `server.upgrade`: the handler, then the context from the first event on. */
	readonly data: BunSocketData
	/** Outbound bytes Bun holds unsent; read for the backpressure limit. */
	getBufferedAmount?(): number
	/** Connection state: 0 connecting, 1 open, 2 closing, 3 closed. */
	readonly readyState: number
	/** Send one frame. Returns the bytes written, `-1` when queued under backpressure, `0` when dropped; honey ignores it. */
	send(data: ArrayBufferLike | ArrayBufferView | string): number
}

type BunServer = { upgrade(req: Request, options: { data: BunSocketData; headers?: HeadersInit }): boolean }

/** The `websocket` callbacks `Bun.serve` takes; `bunWebSocket()` builds them, and `serve(app)` passes them for you. */
export type BunWebSocketHandlers = {
	/**
	 * Queued bytes past which Bun drops further sends without closing the socket. Set from the adapter's
	 * `backpressureLimit`, at least 1.
	 */
	readonly backpressureLimit: number
	/** Bun calls this when a connection closes; it runs the handler's `onClose`. */
	close(ws: BunSocket, code: number, reason: string): void
	/** Always `false`: honey applies its own backpressure policy instead of Bun closing the socket. */
	readonly closeOnBackpressureLimit: boolean
	/**
	 * Seconds of silence before Bun closes the connection, or 0 for never. The adapter's millisecond `idleTimeout`
	 * rounded up to whole seconds and kept within 1 to 960.
	 */
	readonly idleTimeout: number
	/** Largest inbound message in bytes, from the adapter's `maxPayload`; Bun enforces it. */
	readonly maxPayloadLength: number
	/**
	 * Bun calls this for each inbound message. It runs the handler's `onMessage` with text as a string and binary as an
	 * `ArrayBuffer` holding exactly its bytes.
	 */
	message(ws: BunSocket, data: ArrayBufferView | string): void
	/** Bun calls this when a connection opens; it runs the handler's `onOpen`. */
	open(ws: BunSocket): void
}

/** The adapter `bunWebSocket()` returns: a `WSAdapter` plus the `websocket` handlers for `Bun.serve`. */
export type BunWSAdapter = WSAdapter & {
	/** For `Bun.serve({ websocket })`; `serve(app)` passes it. */
	readonly websocket: BunWebSocketHandlers
}

/** Bun's server: the env itself (`Bun.serve({ fetch: app.fetch })`) or `env.server` (`serve(app)`). */
function serverOf(env: unknown): BunServer {
	const candidate = env as { server?: unknown; upgrade?: unknown } | null
	if (typeof candidate?.upgrade === "function") return candidate as unknown as BunServer
	const server = candidate?.server as { upgrade?: unknown } | undefined
	if (typeof server?.upgrade === "function") return server as BunServer
	throw new Error("bunWebSocket needs Bun's server: serve(app), or Bun.serve({ fetch: app.fetch, websocket })")
}

/** Bun's idle timeout: whole seconds, 1 to 960; 0 keeps it off. */
function idleSeconds(ms: number): number {
	return ms === 0 ? 0 : Math.min(Math.max(Math.ceil(ms / 1000), 1), 960)
}

/**
 * The Bun WebSocket adapter. Bun enforces `maxPayload` itself (`maxPayloadLength`), so the memory
 * bound holds before honey sees a byte; past it Bun force-closes with 1006 and no close frame,
 * where Node and Workers close with 1009. `serve(app)` uses one with default options when the app
 * sets none. Throws a `TypeError` for an invalid option.
 */
export function bunWebSocket(options?: WSAdapterOptions): BunWSAdapter {
	const resolved = resolveWSOptions(options)
	const open = new Set<BunSocket>()
	const socketOf = (ws: BunSocket): WSContext => (ws.data.socket ??= new WSContextImpl(ws, resolved))
	return {
		closeAll(code, reason) {
			for (const ws of open) {
				try {
					ws.close(code, reason)
				} catch {
					/* already closing */
				}
			}
		},
		options: resolved,
		runtime: "bun",
		upgrade(req, env, handler) {
			const protocol = selectProtocol(req, resolved)
			const headers = protocol === null ? undefined : { "sec-websocket-protocol": protocol }
			if (!serverOf(env).upgrade(req, { data: { handler }, headers })) {
				throw new Error("Bun refused the WebSocket upgrade")
			}
			/* the socket exists once Bun opens it: the callbacks below hand it to the handler */
			return { response: switchingProtocols({ upgrade: "websocket" }), socket: undefined as unknown as WSContext }
		},
		websocket: {
			/* honey applies its own send policy (WSContext); Bun's limit only bounds its queue */
			backpressureLimit: Math.max(resolved.backpressureLimit, 1),
			close(ws, code, reason) {
				open.delete(ws)
				const socket = socketOf(ws)
				fireHandler("close", () => ws.data.handler.onClose?.(undefined, socket, code, reason))
			},
			closeOnBackpressureLimit: false,
			idleTimeout: idleSeconds(resolved.idleTimeout),
			maxPayloadLength: resolved.maxPayload,
			message(ws, data) {
				const socket = socketOf(ws)
				/* Bun passes a Buffer for a binary frame: hand over exactly its bytes */
				const message = typeof data === "string" ? data : toArrayBuffer(data)
				fireHandler("message", () => ws.data.handler.onMessage?.(undefined, socket, message))
			},
			open(ws) {
				open.add(ws)
				const socket = socketOf(ws)
				fireHandler("open", () => ws.data.handler.onOpen?.(undefined, socket))
			},
		},
	}
}
