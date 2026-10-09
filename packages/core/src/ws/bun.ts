export {
	type RawSocket,
	type WSAdapter,
	type WSAdapterOptions,
	type WSContext,
	WSContextImpl,
	type WSHandler,
} from "./cloudflare.ts"

import type { WSAdapter, WSContext, WSHandler } from "./cloudflare.ts"
import { fireHandler, WSContextImpl } from "./cloudflare.ts"
import { resolveWSOptions, selectProtocol, toArrayBuffer, type WSAdapterOptions } from "./shared.ts"

type BunRawSocket = {
	close(code?: number, reason?: string): void
	data: BunWSData
	getBufferedAmount?(): number
	readyState: number
	send(data: ArrayBufferLike | ArrayBufferView | string, compress?: boolean): number
}

type BunWSData = {
	handler: WSHandler<unknown>
	socket: WSContext
}

type BunServer = {
	upgrade<T>(req: Request, opts?: { data?: T; headers?: HeadersInit }): boolean
}

export type BunWSAdapter = WSAdapter & {
	/** Pass to `Bun.serve({ websocket })`; honey's `serve()` does. */
	websocket: {
		backpressureLimit: number
		close(ws: BunRawSocket, code: number, reason: string): void
		closeOnBackpressureLimit: boolean
		idleTimeout: number
		maxPayloadLength: number
		message(ws: BunRawSocket, data: ArrayBufferView | string): void
		open(ws: BunRawSocket): void
	}
}

/**
 * Bun WebSocket adapter.
 * Returns adapter + websocket handler object for Bun.serve().
 * Bun has no onError callback (noted limitation). Bun pings idle sockets itself
 * (`idleTimeout`, whole seconds, at most 960); there is no `keepalive` option.
 */
export function bunWebSocket(opts?: WSAdapterOptions): BunWSAdapter {
	const options = resolveWSOptions(opts)
	const open = new Set<BunRawSocket>()
	const socketOf = (ws: BunRawSocket): WSContext => {
		if (!ws.data.socket) ws.data.socket = new WSContextImpl(ws, options)
		return ws.data.socket
	}
	return {
		closeAll(code: number, reason: string) {
			for (const ws of open) {
				try {
					ws.close(code, reason)
				} catch {
					/* already closing */
				}
			}
		},
		options,
		upgrade(req: Request, env: unknown, handler: WSHandler<unknown>) {
			const server = (env as Record<string, unknown>).server as BunServer
			/*
			 * Socket is undefined here — Bun creates it lazily in the open callback.
			 * WSContext cast is safe: actual socket is assigned in open/message/close
			 * before any user code accesses it.
			 */
			const protocol = selectProtocol(req, options)
			const success = server.upgrade<BunWSData>(req, {
				data: { handler, socket: undefined as unknown as WSContext },
				headers: protocol === null ? undefined : { "sec-websocket-protocol": protocol },
			})
			if (!success) {
				return {
					response: new Response("WebSocket upgrade failed", { status: 500 }),
					socket: undefined as unknown as WSContext,
				}
			}
			/* Node's Response rejects status 101 (Fetch spec: 200-599 only).
			   Create a valid Response and override status for the sentinel check. */
			const response = new Response(null)
			Object.defineProperty(response, "status", { value: 101 })
			return {
				response,
				socket: undefined as unknown as WSContext,
			}
		},

		websocket: {
			/* honey applies its own policy on send (WSContext); Bun's limit only bounds its queue */
			backpressureLimit: Math.max(options.backpressureLimit, 1),
			close(ws: BunRawSocket, code: number, reason: string) {
				open.delete(ws)
				const socket = socketOf(ws)
				fireHandler("close", () => ws.data.handler.onClose?.(undefined, socket, code, reason))
			},
			closeOnBackpressureLimit: false,
			idleTimeout: options.idleTimeout === 0 ? 0 : Math.min(Math.max(Math.ceil(options.idleTimeout / 1000), 1), 960),
			maxPayloadLength: options.maxPayload,
			message(ws: BunRawSocket, data: ArrayBufferView | string) {
				const socket = socketOf(ws)
				/* Bun passes a Buffer for binary frames: hand over exactly its bytes, as an ArrayBuffer */
				const normalized = typeof data === "string" ? data : toArrayBuffer(data)
				fireHandler("message", () => ws.data.handler.onMessage?.(undefined, socket, normalized))
			},
			open(ws: BunRawSocket) {
				open.add(ws)
				const socket = socketOf(ws)
				fireHandler("open", () => ws.data.handler.onOpen?.(undefined, socket))
			},
		},
	}
}
