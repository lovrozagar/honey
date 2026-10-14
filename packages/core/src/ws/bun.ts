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

type BunSocketData = { readonly handler: WSHandler<unknown>; socket?: WSContext }

type BunSocket = {
	close(code?: number, reason?: string): void
	readonly data: BunSocketData
	getBufferedAmount?(): number
	readonly readyState: number
	send(data: ArrayBufferLike | ArrayBufferView | string): number
}

type BunServer = { upgrade(req: Request, options: { data: BunSocketData; headers?: HeadersInit }): boolean }

export type BunWebSocketHandlers = {
	readonly backpressureLimit: number
	close(ws: BunSocket, code: number, reason: string): void
	readonly closeOnBackpressureLimit: boolean
	readonly idleTimeout: number
	readonly maxPayloadLength: number
	message(ws: BunSocket, data: ArrayBufferView | string): void
	open(ws: BunSocket): void
}

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
