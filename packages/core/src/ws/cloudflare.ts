/**
 * The Cloudflare Workers WebSocket adapter: a `WebSocketPair`, the server side accepted and wired
 * to the handler, the client side handed back in the 101. `idleTimeout` is not enforced: Workers
 * has no ping API and evicts idle sockets itself. Set it with `app.wsAdapter(cfWebSocket())`.
 */
import {
	fireHandler,
	type RawSocket,
	switchingProtocols,
	type WSAdapter,
	type WSHandler,
	WSContextImpl,
} from "./contract.ts"
import {
	CLOSE_TOO_BIG,
	exceedsPayload,
	resolveWSOptions,
	selectProtocol,
	sendableCloseCode,
	type WSAdapterOptions,
} from "./shared.ts"

type PairSocket = RawSocket & EventTarget & { accept(): void }

/** Wire the accepted server side's events to `handler`. */
function wire(
	server: PairSocket,
	socket: WSContextImpl<PairSocket>,
	handler: WSHandler<unknown>,
	maxPayload: number,
): void {
	server.addEventListener("message", (event) => {
		const data = (event as MessageEvent).data as ArrayBuffer | string
		if (exceedsPayload(data, maxPayload)) return socket.close(CLOSE_TOO_BIG, "message too big")
		fireHandler("message", () => handler.onMessage?.(undefined, socket, data))
	})
	server.addEventListener("close", (event) => {
		const { code, reason } = event as CloseEvent
		fireHandler("close", () => handler.onClose?.(undefined, socket, code, reason))
		/* echo the close so the client's closing handshake completes; 1005 and 1006 are never sent */
		try {
			server.close(sendableCloseCode(code), reason)
		} catch {
			/* already closed */
		}
	})
	server.addEventListener("error", (event) => {
		fireHandler("error", () => handler.onError?.(undefined, socket, event))
	})
}

export function cfWebSocket(options?: WSAdapterOptions): WSAdapter {
	const resolved = resolveWSOptions(options)
	return {
		options: resolved,
		runtime: "workers",
		upgrade(req, _env, handler) {
			const Pair = (globalThis as unknown as { WebSocketPair: new () => [PairSocket, PairSocket] }).WebSocketPair
			const [client, server] = new Pair()
			server.accept()
			const socket = new WSContextImpl(server, resolved)
			wire(server, socket, handler, resolved.maxPayload)
			fireHandler("open", () => handler.onOpen?.(undefined, socket))
			const headers: Record<string, string> = { upgrade: "websocket" }
			const protocol = selectProtocol(req, resolved)
			if (protocol !== null) headers["sec-websocket-protocol"] = protocol
			return { response: switchingProtocols(headers, { webSocket: client }), socket }
		},
	}
}
