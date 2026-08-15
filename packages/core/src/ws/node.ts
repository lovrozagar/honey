export { type RawSocket, type WSAdapter, type WSContext, WSContextImpl, type WSHandler } from "./cloudflare.ts"

import type { WSAdapter, WSHandler } from "./cloudflare.ts"
import { WSContextImpl } from "./cloudflare.ts"

type WsModule = {
	WebSocketServer: new (opts: { noServer: true; perMessageDeflate: boolean }) => {
		handleUpgrade(req: unknown, socket: unknown, head: unknown, cb: (ws: NodeWS) => void): void
	}
}

type NodeWS = {
	close(code?: number, reason?: string): void
	on(event: "close", cb: (code: number, reason: Buffer) => void): void
	on(event: "error", cb: (err: unknown) => void): void
	on(event: "message", cb: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): void
	on(event: "pong", cb: () => void): void
	ping(): void
	readyState: number
	send(data: ArrayBuffer | Buffer | Uint8Array | string): void
}

type NodeUpgradeData = {
	head: Buffer
	req: unknown
	socket: unknown
}

/**
 * Node.js WebSocket adapter.
 * Requires the `ws` package. Creates a no-server WebSocketServer internally.
 * Reads __nodeUpgrade from env (placed there by serve()).
 */
type WssInstance = {
	handleUpgrade(req: unknown, socket: unknown, head: unknown, cb: (ws: NodeWS) => void): void
}

type KeepaliveConfig = {
	interval: number
	timeout: number
}

export function nodeWebSocket(opts?: { keepalive?: KeepaliveConfig }): WSAdapter {
	let wss: WssInstance | null = null
	let wssReady: Promise<void> | null = null

	const ensureWss = async (): Promise<WssInstance> => {
		if (wss) return wss
		if (!wssReady) {
			wssReady = import("ws").then((mod) => {
				const wsModule = mod as unknown as WsModule
				wss = new wsModule.WebSocketServer({ noServer: true, perMessageDeflate: false })
			})
		}
		await wssReady
		if (!wss) throw new Error("Failed to initialize WebSocketServer")
		return wss
	}

	return {
		async upgrade(_req: Request, env: unknown, handler: WSHandler<unknown>) {
			const server = await ensureWss()

			const nodeEnv = env as Record<string, unknown>
			const upgrade = nodeEnv.__nodeUpgrade as NodeUpgradeData

			return new Promise((resolve, reject) => {
				try {
					server.handleUpgrade(upgrade.req, upgrade.socket, upgrade.head, (ws: NodeWS) => {
						const socket = new WSContextImpl(ws)

						ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
							if (!isBinary) {
								/* text frame — decode to string to match other runtimes */
								const text = Buffer.isBuffer(data) ? data.toString("utf-8") : String(data)
								handler.onMessage?.(undefined, socket, text)
							} else if (Buffer.isBuffer(data)) {
								/* binary frame — slice from pool to get exact bytes */
								handler.onMessage?.(
									undefined,
									socket,
									data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
								)
							} else if (Array.isArray(data)) {
								const merged = Buffer.concat(data)
								handler.onMessage?.(
									undefined,
									socket,
									merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength) as ArrayBuffer,
								)
							} else {
								handler.onMessage?.(undefined, socket, data)
							}
						})

						/* keepalive ping/pong */
						let pingTimer: ReturnType<typeof setInterval> | undefined
						let pongTimeout: ReturnType<typeof setTimeout> | undefined

						if (opts?.keepalive) {
							const { interval, timeout } = opts.keepalive
							ws.on("pong", () => {
								if (pongTimeout !== undefined) {
									clearTimeout(pongTimeout)
									pongTimeout = undefined
								}
							})
							pingTimer = setInterval(() => {
								if (ws.readyState !== 1) {
									clearInterval(pingTimer)
									return
								}
								ws.ping()
								pongTimeout = setTimeout(() => {
									ws.close(1001, "keepalive timeout")
								}, timeout)
							}, interval)
						}

						ws.on("close", (code: number, reason: Buffer) => {
							if (pingTimer !== undefined) clearInterval(pingTimer)
							if (pongTimeout !== undefined) clearTimeout(pongTimeout)
							handler.onClose?.(undefined, socket, code, reason.toString())
						})

						ws.on("error", (err: unknown) => {
							if (pingTimer !== undefined) clearInterval(pingTimer)
							if (pongTimeout !== undefined) clearTimeout(pongTimeout)
							handler.onError?.(undefined, socket, err)
						})

						handler.onOpen?.(undefined, socket)

						/* Node's Response rejects status 101 (Fetch spec: 200-599 only).
						   Create a valid Response and override status for the sentinel check. */
						const resp = new Response(null)
						Object.defineProperty(resp, "status", { value: 101 })
						resolve({ response: resp, socket })
					})
				} catch (err) {
					reject(err)
				}
			})
		},
	}
}
