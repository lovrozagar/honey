import type { WSReadyState } from "../types.ts"

export type WSContext<T = unknown> = {
	close(code?: number, reason?: string): void
	raw: T
	readyState: WSReadyState
	send(data: ArrayBuffer | Uint8Array | object | string): void
}

export type WSHandler<TCtx = unknown> = {
	onClose?(ctx: TCtx, ws: WSContext, code: number, reason: string): Promise<void> | void
	onError?(ctx: TCtx, ws: WSContext, error: unknown): Promise<void> | void
	onMessage?(ctx: TCtx, ws: WSContext, data: ArrayBuffer | string): Promise<void> | void
	onOpen?(ctx: TCtx, ws: WSContext): Promise<void> | void
	onReconnect?(ctx: TCtx, ws: WSContext, token: string): Promise<void> | void
}

export type WSAdapter = {
	upgrade(
		req: Request,
		env: unknown,
		handler: WSHandler<unknown>,
	): Promise<{ response: Response; socket: WSContext }> | { response: Response; socket: WSContext }
}

export type RawSocket = {
	close(code?: number, reason?: string): void
	readyState: number
	send(data: ArrayBuffer | Uint8Array | string): void
}

export class WSContextImpl<T extends RawSocket = RawSocket> implements WSContext<T> {
	raw: T

	constructor(raw: T) {
		this.raw = raw
	}

	get readyState(): WSReadyState {
		return this.raw.readyState as WSReadyState
	}

	close(code?: number, reason?: string): void {
		this.raw.close(code, reason)
	}

	send(data: ArrayBuffer | Uint8Array | object | string): void {
		if (typeof data === "string" || data instanceof ArrayBuffer || data instanceof Uint8Array) {
			this.raw.send(data)
		} else {
			this.raw.send(JSON.stringify(data))
		}
	}
}

/**
 * Cloudflare Workers WebSocket adapter.
 * Uses WebSocketPair + server.accept() + addEventListener.
 */
export function cfWebSocket(): WSAdapter {
		return {
			upgrade(_req: Request, _env: unknown, handler: WSHandler<unknown>) {
				type CFWebSocket = RawSocket & { accept(): void }
				const Ctor = (globalThis as Record<string, unknown>)["WebSocketPair"] as new () => [
					CFWebSocket,
					CFWebSocket,
				]
			const [client, server] = new Ctor()
			server.accept()
			const socket = new WSContextImpl(server)

			const raw = server as unknown as EventTarget & RawSocket
			if ("addEventListener" in raw) {
				raw.addEventListener("message", (evt: Event) => {
					const data = (evt as MessageEvent).data
					handler.onMessage?.(undefined, socket, data)
				})
				raw.addEventListener("close", (evt: Event) => {
					const closeEvt = evt as CloseEvent
					handler.onClose?.(undefined, socket, closeEvt.code, closeEvt.reason)
					/* echo close frame so the client handshake completes */
					try {
						server.close(closeEvt.code, closeEvt.reason)
					} catch {
						/* already closed */
					}
				})
				raw.addEventListener("error", (evt: Event) => {
					handler.onError?.(undefined, socket, evt)
				})
			}
			handler.onOpen?.(undefined, socket)

				return {
					response: new Response(null, {
						headers: { upgrade: "websocket" },
						status: 101,
						webSocket: client,
					} as unknown as ResponseInit),
					socket,
				}
			},
	}
}
