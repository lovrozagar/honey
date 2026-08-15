export {
	type RawSocket,
	type WSAdapter,
	type WSContext,
	type WSPreUpgrade,
	WSContextImpl,
	type WSHandler,
} from "./cloudflare.ts"

import type { WSAdapter, WSHandler, WSPreUpgrade } from "./cloudflare.ts"
import { WSContextImpl } from "./cloudflare.ts"

type DenoNs = {
	Deno: {
		upgradeWebSocket(req: Request): {
			response: Response
			socket: {
				addEventListener(type: string, listener: (...args: never[]) => void): void
			} & DenoRawSocket
		}
	}
}

type DenoRawSocket = {
	close(code?: number, reason?: string): void
	readyState: number
	send(data: ArrayBuffer | Uint8Array | string): void
}

type DenoSocket = {
	addEventListener(type: string, listener: (...args: never[]) => void): void
} & DenoRawSocket

function bindHandlers(rawSocket: DenoSocket, socket: WSContextImpl<DenoRawSocket>, handler: WSHandler<unknown>): void {
	rawSocket.addEventListener("open", () => {
		handler.onOpen?.(undefined, socket)
	})
	rawSocket.addEventListener("message", (evt: { data: ArrayBuffer | string }) => {
		handler.onMessage?.(undefined, socket, evt.data)
	})
	rawSocket.addEventListener("close", (evt: { code: number; reason: string }) => {
		handler.onClose?.(undefined, socket, evt.code, evt.reason)
	})
	rawSocket.addEventListener("error", (evt: unknown) => {
		handler.onError?.(undefined, socket, evt)
	})
}

/**
 * Deno WebSocket adapter.
 * Uses Deno.upgradeWebSocket() and addEventListener for event binding.
 * Keepalive is not supported — Deno's WebSocket lacks a ping() method.
 * Use nodeWebSocket() for keepalive support.
 *
 * `preUpgrade` calls `Deno.upgradeWebSocket` in the same turn as the serve
 * callback (Deno rejects upgrades performed after the first await).
 */
export function denoWebSocket(): WSAdapter {
	const pending = new WeakMap<Request, { pre: WSPreUpgrade; raw: DenoSocket }>()

	return {
		preUpgrade(req: Request): WSPreUpgrade {
			const denoNs = globalThis as unknown as DenoNs
			const { response, socket: rawSocket } = denoNs.Deno.upgradeWebSocket(req)
			const socket = new WSContextImpl(rawSocket as DenoRawSocket)
			const pre: WSPreUpgrade = {
				response,
				socket,
				whenOpen(fn: () => void) {
					if (rawSocket.readyState === 1) {
						fn()
						return
					}
					rawSocket.addEventListener("open", () => fn())
				},
			}
			pending.set(req, { pre, raw: rawSocket })
			return pre
		},
		upgrade(req: Request, _env: unknown, handler: WSHandler<unknown>) {
			const held = pending.get(req)
			if (held) {
				pending.delete(req)
				bindHandlers(held.raw, held.pre.socket as WSContextImpl<DenoRawSocket>, handler)
				/* handshake may have completed before listeners were attached */
				if (held.raw.readyState === 1) {
					handler.onOpen?.(undefined, held.pre.socket)
				}
				return held.pre
			}

			/* globalThis cast: Deno namespace only exists at runtime on Deno — no way to type it statically */
			const denoNs = globalThis as unknown as DenoNs
			const { response, socket: rawSocket } = denoNs.Deno.upgradeWebSocket(req)
			const socket = new WSContextImpl(rawSocket as DenoRawSocket)
			bindHandlers(rawSocket, socket, handler)
			return { response, socket }
		},
	}
}
