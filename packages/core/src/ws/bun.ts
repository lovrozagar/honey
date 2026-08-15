export {
	type RawSocket,
	type WSAdapter,
	type WSContext,
	WSContextImpl,
	type WSHandler,
} from "./cloudflare.ts"

import type { WSAdapter, WSContext, WSHandler } from "./cloudflare.ts"
import { WSContextImpl } from "./cloudflare.ts"

type BunRawSocket = {
	close(code?: number, reason?: string): void
	data: BunWSData
	readyState: number
	send(data: ArrayBufferLike | ArrayBufferView | string, compress?: boolean): number
}

type BunWSData = {
	handler: WSHandler<unknown>
	socket: WSContext
}

type BunServer = {
	upgrade<T>(req: Request, opts?: { data?: T }): boolean
}

export type BunWSAdapter = WSAdapter & {
	websocket: {
		close(ws: BunRawSocket, code: number, reason: string): void
		message(ws: BunRawSocket, data: ArrayBufferView | string): void
		open(ws: BunRawSocket): void
	}
}

/**
 * Bun WebSocket adapter.
 * Returns adapter + websocket handler object for Bun.serve().
 * Bun has no onError callback (noted limitation).
 * Keepalive is not supported — Bun's WS API lacks ping/pong control.
 * Use nodeWebSocket() for keepalive support.
 */
export function bunWebSocket(): BunWSAdapter {
	return {
		upgrade(req: Request, env: unknown, handler: WSHandler<unknown>) {
			const server = (env as Record<string, unknown>).server as BunServer
			/*
			 * Socket is undefined here — Bun creates it lazily in the open callback.
			 * WSContext cast is safe: actual socket is assigned in open/message/close
			 * before any user code accesses it.
			 */
			const success = server.upgrade<BunWSData>(req, {
				data: { handler, socket: undefined as unknown as WSContext },
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
			close(ws: BunRawSocket, code: number, reason: string) {
				if (!ws.data.socket) ws.data.socket = new WSContextImpl(ws)
				ws.data.handler.onClose?.(undefined, ws.data.socket, code, reason)
			},
			message(ws: BunRawSocket, data: ArrayBufferView | string) {
				if (!ws.data.socket) ws.data.socket = new WSContextImpl(ws)
				/* Bun passes Buffer (Uint8Array) for binary — normalize to ArrayBuffer for WSHandler */
				const normalized =
					typeof data === "string" ? data : ((data as Uint8Array).buffer as ArrayBuffer)
				ws.data.handler.onMessage?.(undefined, ws.data.socket, normalized)
			},
			open(ws: BunRawSocket) {
				if (!ws.data.socket) ws.data.socket = new WSContextImpl(ws)
				ws.data.handler.onOpen?.(undefined, ws.data.socket)
			},
		},
	}
}
