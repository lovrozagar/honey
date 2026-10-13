export {
	type RawSocket,
	type WSAdapter,
	type WSAdapterOptions,
	type WSContext,
	type WSPreUpgrade,
	WSContextImpl,
	type WSHandler,
} from "./cloudflare.ts"

import type { WSAdapter, WSHandler, WSPreUpgrade } from "./cloudflare.ts"
import { fireHandler, WSContextImpl } from "./cloudflare.ts"
import {
	CLOSE_POLICY,
	CLOSE_TOO_BIG,
	exceedsPayload,
	type ResolvedWSOptions,
	resolveWSOptions,
	selectProtocol,
	type WSAdapterOptions,
} from "./shared.ts"

type DenoUpgradeOptions = { idleTimeout?: number; protocol?: string }

type DenoNs = {
	Deno: {
		upgradeWebSocket(
			req: Request,
			opts?: DenoUpgradeOptions,
		): {
			response: Response
			socket: DenoSocket
		}
	}
}

type DenoRawSocket = {
	binaryType: string
	bufferedAmount: number
	close(code?: number, reason?: string): void
	readyState: number
	send(data: ArrayBuffer | Uint8Array | string): void
}

type DenoSocket = {
	addEventListener(type: string, listener: (...args: never[]) => void): void
} & DenoRawSocket

/** Events that arrive before the route's handler is bound (the `preUpgrade` path). */
const EARLY_EVENTS_MAX = 64

type DenoEvent =
	| { data: ArrayBuffer | string; type: "message" }
	| { code: number; reason: string; type: "close" }
	| { error: unknown; type: "error" }
	| { type: "open" }

/**
 * Listen on a Deno socket right away and deliver events to a handler bound later. Until then up
 * to 64 events wait (frames the client sends between the 101 and the end of the middleware
 * chain); more close the connection with 1008.
 */
function listen(raw: DenoSocket, socket: WSContextImpl<DenoRawSocket>, options: ResolvedWSOptions) {
	let handler: WSHandler<unknown> | null = null
	let early: DenoEvent[] | null = []

	const deliver = (evt: DenoEvent, h: WSHandler<unknown>): void => {
		switch (evt.type) {
			case "open":
				fireHandler("open", () => h.onOpen?.(undefined, socket))
				return
			case "message":
				fireHandler("message", () => h.onMessage?.(undefined, socket, evt.data))
				return
			case "close":
				fireHandler("close", () => h.onClose?.(undefined, socket, evt.code, evt.reason))
				return
			case "error":
				fireHandler("error", () => h.onError?.(undefined, socket, evt.error))
		}
	}

	const push = (evt: DenoEvent): void => {
		if (handler !== null) {
			deliver(evt, handler)
			return
		}
		if (early === null) return
		if (early.length >= EARLY_EVENTS_MAX && evt.type === "message") {
			early = null
			socket.close(CLOSE_POLICY, "too many messages before the handler was ready")
			return
		}
		early.push(evt)
	}

	raw.addEventListener("open", () => push({ type: "open" }))
	raw.addEventListener("message", (evt: { data: ArrayBuffer | string }) => {
		if (exceedsPayload(evt.data, options.maxPayload)) {
			socket.close(CLOSE_TOO_BIG, "message too big")
			return
		}
		push({ data: evt.data, type: "message" })
	})
	raw.addEventListener("close", (evt: { code: number; reason: string }) =>
		push({ code: evt.code, reason: evt.reason, type: "close" }),
	)
	raw.addEventListener("error", (evt: unknown) => push({ error: evt, type: "error" }))

	return {
		bind(h: WSHandler<unknown>): void {
			handler = h
			const queued = early ?? []
			early = null
			for (const evt of queued) deliver(evt, h)
		},
	}
}

/**
 * Deno WebSocket adapter.
 * Uses Deno.upgradeWebSocket() and addEventListener for event binding.
 * Deno pings idle sockets itself (`idleTimeout`, whole seconds); there is no `keepalive` option.
 *
 * `preUpgrade` calls `Deno.upgradeWebSocket` in the same turn as the serve
 * callback (Deno rejects upgrades performed after the first await).
 */
export function denoWebSocket(opts?: WSAdapterOptions): WSAdapter {
	const options = resolveWSOptions(opts)
	const pending = new WeakMap<Request, { bind(h: WSHandler<unknown>): void; pre: WSPreUpgrade }>()
	const open = new Set<WSContextImpl<DenoRawSocket>>()

	const start = (req: Request) => {
		const denoNs = globalThis as unknown as DenoNs
		const protocol = selectProtocol(req, options)
		const upgradeOpts: DenoUpgradeOptions = {}
		if (protocol !== null) upgradeOpts.protocol = protocol
		if (options.idleTimeout > 0) upgradeOpts.idleTimeout = Math.max(Math.ceil(options.idleTimeout / 1000), 1)
		const { response, socket: rawSocket } = denoNs.Deno.upgradeWebSocket(req, upgradeOpts)
		/* binary frames arrive as ArrayBuffer, as on every other runtime (Deno's default is Blob) */
		rawSocket.binaryType = "arraybuffer"
		const socket = new WSContextImpl(rawSocket as DenoRawSocket, options)
		open.add(socket)
		rawSocket.addEventListener("close", () => open.delete(socket))
		const listener = listen(rawSocket, socket, options)
		return { listener, rawSocket, response, socket }
	}

	return {
		closeAll(code: number, reason: string) {
			for (const socket of open) {
				try {
					socket.close(code, reason)
				} catch {
					/* already closing */
				}
			}
		},
		options,
		preUpgrade(req: Request): WSPreUpgrade {
			const { listener, rawSocket, response, socket } = start(req)
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
			pending.set(req, { bind: listener.bind, pre })
			return pre
		},
		upgrade(req: Request, _env: unknown, handler: WSHandler<unknown>) {
			const held = pending.get(req)
			if (held) {
				pending.delete(req)
				held.bind(handler)
				return held.pre
			}
			const { listener, response, socket } = start(req)
			listener.bind(handler)
			return { response, socket }
		},
	}
}
