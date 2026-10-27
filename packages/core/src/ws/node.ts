/**
 * The Node WebSocket adapter, on the `ws` package (an optional peer dependency, loaded on the first
 * upgrade). The Node bridge's `'upgrade'` listener puts the raw socket on the request view under
 * `NODE_UPGRADE`; the adapter hands it to `ws`, which writes the 101 itself, so the handshake
 * never goes through the Fetch body writer. Keepalive pings and the idle timeout run here.
 */
import { optionalPeer } from "../runtime/optional-peer.ts"
import { fireHandler, switchingProtocols, type WSAdapter, type WSHandler, WSContextImpl } from "./contract.ts"
import { type ResolvedWSOptions, resolveWSOptions, selectProtocol, type WSAdapterOptions } from "./shared.ts"

/** The upgrade the Node bridge hands over on the request view. `upgraded` turns true once `ws` wrote the 101. */
export type NodeUpgrade = { readonly head: Buffer; readonly req: unknown; readonly socket: unknown; upgraded: boolean }

export const NODE_UPGRADE: unique symbol = /* @__PURE__ */ Symbol("honey.nodeUpgrade")

export type NodeWebSocketOptions = WSAdapterOptions & {
	/** Ping every `interval` ms; a pong missing after `timeout` ms terminates the connection. */
	keepalive?: { interval: number; timeout: number }
}

type NodeWS = {
	binaryType: string
	readonly bufferedAmount: number
	close(code?: number, reason?: string): void
	on(event: string, listener: (...args: never[]) => void): void
	ping(): void
	readonly readyState: number
	send(data: ArrayBuffer | Uint8Array | string): void
	terminate(): void
}

type WebSocketServer = {
	handleUpgrade(req: unknown, socket: unknown, head: Buffer, done: (ws: NodeWS) => void): void
}

type WsModule = {
	WebSocketServer: new (options: {
		handleProtocols(protocols: Set<string>): string | false
		maxPayload: number
		noServer: true
		perMessageDeflate: false
	}) => WebSocketServer
}

/** Ping a quiet peer and end one that stays quiet: the keepalive and the idle timeout. */
function watch(ws: NodeWS, options: ResolvedWSOptions, keepalive: NodeWebSocketOptions["keepalive"]): void {
	let lastSeen = Date.now()
	let pongDue: ReturnType<typeof setTimeout> | undefined
	const timers: ReturnType<typeof setInterval>[] = []
	const seen = (): void => {
		lastSeen = Date.now()
	}
	ws.on("pong", () => {
		seen()
		clearTimeout(pongDue)
		pongDue = undefined
	})
	ws.on("ping", seen)
	ws.on("message", seen)
	if (keepalive !== undefined) {
		timers.push(
			setInterval(() => {
				/* one pong outstanding at a time: a slow pong never stacks timers */
				if (ws.readyState !== 1 || pongDue !== undefined) return
				ws.ping()
				pongDue = setTimeout(() => ws.terminate(), keepalive.timeout)
			}, keepalive.interval),
		)
	}
	const idle = options.idleTimeout
	if (idle > 0) {
		const tick = Math.max(Math.floor(idle / 2), 1)
		timers.push(
			setInterval(() => {
				const quiet = Date.now() - lastSeen
				if (quiet >= idle) ws.terminate()
				else if (quiet >= tick) ws.ping()
			}, tick),
		)
	}
	ws.on("close", () => {
		for (const timer of timers) clearInterval(timer)
		clearTimeout(pongDue)
	})
}

/** Wire one accepted socket to `handler`. Text frames arrive as strings, binary as exactly their bytes. */
function wire(ws: NodeWS, socket: WSContextImpl<NodeWS>, handler: WSHandler<unknown>, open: Set<NodeWS>): void {
	ws.on("message", (data: ArrayBuffer, isBinary: boolean) => {
		const message = isBinary ? data : Buffer.from(data).toString("utf8")
		fireHandler("message", () => handler.onMessage?.(undefined, socket, message))
	})
	ws.on("close", (code: number, reason: Buffer) => {
		open.delete(ws)
		fireHandler("close", () => handler.onClose?.(undefined, socket, code, reason.toString()))
	})
	ws.on("error", (error: unknown) => {
		fireHandler("error", () => handler.onError?.(undefined, socket, error))
	})
}

export function nodeWebSocket(options?: NodeWebSocketOptions): WSAdapter {
	const resolved = resolveWSOptions(options)
	const keepalive = options?.keepalive
	if (keepalive !== undefined && !(keepalive.interval > 0 && keepalive.timeout > 0)) {
		throw new TypeError("nodeWebSocket: keepalive.interval and keepalive.timeout must be positive")
	}
	const loadWs = optionalPeer("ws", "WebSocket routes on Node", () => import("ws") as Promise<unknown>)
	const open = new Set<NodeWS>()
	let server: WebSocketServer | null = null
	/* the request being upgraded, for the protocol choice: ws asks synchronously within handleUpgrade */
	let upgrading: Request | null = null
	const serverOf = async (): Promise<WebSocketServer> => {
		/* ws's ESM entry, or its CommonJS one under default: what Node resolves a retry to once ws was installed */
		const ws = (await loadWs()) as WsModule | { default: WsModule }
		const { WebSocketServer } = "WebSocketServer" in ws ? ws : ws.default
		server ??= new WebSocketServer({
			/* asked only within handleUpgrade, so the request is the one being upgraded */
			handleProtocols: () => selectProtocol(upgrading as Request, resolved) ?? false,
			maxPayload: resolved.maxPayload,
			noServer: true,
			perMessageDeflate: false,
		})
		return server
	}
	return {
		closeAll(code, reason) {
			for (const ws of open) ws.close(code, reason)
		},
		options: resolved,
		runtime: "node",
		async upgrade(req, _env, handler) {
			const upgrade = (req as unknown as { [NODE_UPGRADE]?: NodeUpgrade })[NODE_UPGRADE]
			if (upgrade === undefined)
				throw new Error("nodeWebSocket needs the upgrade socket: serve the app with serve(app) on Node")
			const wss = await serverOf()
			return new Promise((resolve, reject) => {
				/* ws answers a malformed handshake itself and never calls back: fail instead of hanging */
				;(upgrade.socket as { once(event: "close", listener: () => void): void }).once("close", () => {
					if (!upgrade.upgraded) reject(new Error("WebSocket handshake failed"))
				})
				upgrading = req
				wss.handleUpgrade(upgrade.req, upgrade.socket, upgrade.head, (ws) => {
					/* from here the socket is the WebSocket's: the bridge must never write HTTP on it */
					upgrade.upgraded = true
					ws.binaryType = "arraybuffer"
					open.add(ws)
					const socket = new WSContextImpl(ws, resolved)
					wire(ws, socket, handler, open)
					watch(ws, resolved, keepalive)
					fireHandler("open", () => handler.onOpen?.(undefined, socket))
					resolve({ response: switchingProtocols({ upgrade: "websocket" }), socket })
				})
				upgrading = null
			})
		},
	}
}
