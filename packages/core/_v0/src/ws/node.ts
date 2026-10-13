export {
	type RawSocket,
	type WSAdapter,
	type WSAdapterOptions,
	type WSContext,
	WSContextImpl,
	type WSHandler,
} from "./cloudflare.ts"

import type { WSAdapter, WSHandler } from "./cloudflare.ts"
import { fireHandler, WSContextImpl } from "./cloudflare.ts"
import {
	type ResolvedWSOptions,
	resolveWSOptions,
	selectProtocol,
	toArrayBuffer,
	type WSAdapterOptions,
} from "./shared.ts"

type WebSocketServerOptions = {
	handleProtocols?: (protocols: Set<string>, req: unknown) => string | false
	maxPayload: number
	noServer: true
	perMessageDeflate: boolean
}

type WsModule = {
	WebSocketServer: new (opts: WebSocketServerOptions) => WssInstance
}

type NodeWS = {
	binaryType: string
	bufferedAmount: number
	close(code?: number, reason?: string): void
	on(event: "close", cb: (code: number, reason: Buffer) => void): void
	on(event: "error", cb: (err: unknown) => void): void
	on(event: "message", cb: (data: ArrayBuffer | Buffer | Buffer[], isBinary: boolean) => void): void
	on(event: "pong" | "ping", cb: () => void): void
	ping(): void
	readyState: number
	send(data: ArrayBuffer | Buffer | Uint8Array | string): void
	terminate(): void
}

/**
 * What the Node adapter (`serve()`) puts on `env.__nodeUpgrade`. `upgraded` turns true once the
 * 101 is written: from then on the socket belongs to `ws`, and the adapter must not write to it.
 */
export type NodeUpgradeData = {
	head: Buffer
	req: unknown
	socket: unknown
	upgraded: boolean
}

type WssInstance = {
	handleUpgrade(req: unknown, socket: unknown, head: unknown, cb: (ws: NodeWS) => void): void
}

type KeepaliveConfig = {
	interval: number
	timeout: number
}

export type NodeWebSocketOptions = WSAdapterOptions & {
	/** Ping every `interval` ms; a pong missing after `timeout` ms terminates the connection. */
	keepalive?: KeepaliveConfig
}

const WS_MISSING =
	'WebSocket routes on Node need the "ws" package, which is an optional peer dependency of honey. Install it: npm install ws'

/**
 * Node.js WebSocket adapter, on the `ws` package (an optional peer dependency). It reads
 * `env.__nodeUpgrade`, which honey's `serve()` puts there for an upgrade request.
 */
export function nodeWebSocket(opts?: NodeWebSocketOptions): WSAdapter {
	const options: ResolvedWSOptions = resolveWSOptions(opts)
	const keepalive = opts?.keepalive
	if (keepalive !== undefined && !(keepalive.interval > 0 && keepalive.timeout > 0)) {
		throw new TypeError("nodeWebSocket: keepalive.interval and keepalive.timeout must be positive")
	}
	let wss: WssInstance | null = null
	let wssReady: Promise<WssInstance> | null = null
	const open = new Set<NodeWS>()
	/* the Request being upgraded, for the protocol callback (ws hands it the IncomingMessage) */
	let upgrading: Request | null = null

	const ensureWss = (): Promise<WssInstance> => {
		if (wss) return Promise.resolve(wss)
		if (!wssReady) {
			wssReady = import("ws").then(
				(mod) => {
					const wsModule = mod as unknown as WsModule
					wss = new wsModule.WebSocketServer({
						handleProtocols: (protocols) => {
							if (protocols.size === 0 || upgrading === null) return false
							return selectProtocol(upgrading, options) ?? false
						},
						maxPayload: options.maxPayload,
						noServer: true,
						perMessageDeflate: false,
					})
					return wss
				},
				(err: unknown) => {
					/* not cached: installing ws later works without a restart */
					wssReady = null
					throw new Error(WS_MISSING, { cause: err })
				},
			)
		}
		return wssReady
	}

	const watch = (ws: NodeWS): void => {
		let pingTimer: ReturnType<typeof setInterval> | undefined
		let pongTimeout: ReturnType<typeof setTimeout> | undefined
		let idleTimer: ReturnType<typeof setInterval> | undefined
		let lastSeen = Date.now()
		const seen = (): void => {
			lastSeen = Date.now()
		}

		ws.on("pong", () => {
			seen()
			if (pongTimeout !== undefined) {
				clearTimeout(pongTimeout)
				pongTimeout = undefined
			}
		})
		ws.on("ping", seen)

		if (keepalive) {
			pingTimer = setInterval(() => {
				if (ws.readyState !== 1) return
				/* one pong outstanding at a time: a slow pong must not stack timers */
				if (pongTimeout !== undefined) return
				ws.ping()
				pongTimeout = setTimeout(() => ws.terminate(), keepalive.timeout)
			}, keepalive.interval)
		}

		const idle = options.idleTimeout
		if (idle > 0) {
			const tick = Math.max(Math.floor(idle / 2), 1)
			idleTimer = setInterval(() => {
				if (ws.readyState !== 1) return
				const quiet = Date.now() - lastSeen
				if (quiet >= idle) ws.terminate()
				else if (quiet >= tick) ws.ping()
			}, tick)
		}

		const stop = (): void => {
			if (pingTimer !== undefined) clearInterval(pingTimer)
			if (pongTimeout !== undefined) clearTimeout(pongTimeout)
			if (idleTimer !== undefined) clearInterval(idleTimer)
			pingTimer = pongTimeout = idleTimer = undefined
		}
		ws.on("close", stop)
		ws.on("error", stop)
	}

	return {
		closeAll(code: number, reason: string) {
			for (const ws of open) {
				try {
					ws.close(code, reason)
				} catch {
					ws.terminate()
				}
			}
		},
		options,
		async upgrade(req: Request, env: unknown, handler: WSHandler<unknown>) {
			const server = await ensureWss()
			const upgrade = (env as Record<string, unknown>).__nodeUpgrade as NodeUpgradeData | undefined
			if (upgrade === undefined) {
				throw new Error("nodeWebSocket: no upgrade socket; serve the app with honey's serve() on Node")
			}

			return new Promise((resolve, reject) => {
				/* ws answers a malformed handshake itself and never calls back: fail instead of hanging */
				const sock = upgrade.socket as { once?(event: "close", cb: () => void): void }
				sock.once?.("close", () => {
					if (!upgrade.upgraded) reject(new Error("WebSocket handshake failed"))
				})
				upgrading = req
				try {
					server.handleUpgrade(upgrade.req, upgrade.socket, upgrade.head, (ws: NodeWS) => {
						upgrade.upgraded = true
						ws.binaryType = "arraybuffer"
						open.add(ws)
						const socket = new WSContextImpl(ws, options)

						ws.on("message", (data: ArrayBuffer | Buffer | Buffer[], isBinary: boolean) => {
							let payload: ArrayBuffer | string
							if (!isBinary) {
								/* text frame: a string, as on every other runtime */
								payload = Buffer.isBuffer(data)
									? data.toString("utf-8")
									: data instanceof ArrayBuffer
										? Buffer.from(data).toString("utf-8")
										: Buffer.concat(data).toString("utf-8")
							} else if (data instanceof ArrayBuffer) {
								payload = data
							} else {
								payload = toArrayBuffer(Array.isArray(data) ? Buffer.concat(data) : data)
							}
							fireHandler("message", () => handler.onMessage?.(undefined, socket, payload))
						})
						watch(ws)

						ws.on("close", (code: number, reason: Buffer) => {
							open.delete(ws)
							fireHandler("close", () => handler.onClose?.(undefined, socket, code, reason.toString()))
						})

						ws.on("error", (err: unknown) => {
							fireHandler("error", () => handler.onError?.(undefined, socket, err))
						})

						fireHandler("open", () => handler.onOpen?.(undefined, socket))

						/* Node's Response rejects status 101 (Fetch spec: 200-599 only).
						   Create a valid Response and override status for the sentinel check. */
						const resp = new Response(null)
						Object.defineProperty(resp, "status", { value: 101 })
						resolve({ response: resp, socket })
					})
				} catch (err) {
					reject(err)
				} finally {
					upgrading = null
				}
			})
		},
	}
}
