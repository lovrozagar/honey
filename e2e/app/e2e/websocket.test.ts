import { expect, test } from "@playwright/test"

const WS_PORT = process.env.PORT ?? "4100"
const WS_BASE = `ws://localhost:${WS_PORT}`

/**
 * Helper: opens a WebSocket, collects messages, provides close/wait utilities.
 * Uses Node.js built-in WebSocket (Node 21+).
 */
function connectWs(url: string): {
	close(code?: number, reason?: string): void
	messages: string[]
	send(data: string): void
	waitForClose(): Promise<{ code: number; reason: string }>
	waitForMessages(count: number, timeout?: number): Promise<string[]>
	waitForOpen(): Promise<void>
} {
	const messages: string[] = []
	const messageListeners: Array<() => void> = []
	let openResolve: (() => void) | null = null
	let closeResolve: ((v: { code: number; reason: string }) => void) | null = null

	const ws = new WebSocket(url)

	ws.onopen = () => openResolve?.()
	ws.onmessage = async (evt) => {
		if (typeof evt.data === "string") {
			messages.push(evt.data)
		} else if (evt.data instanceof Blob) {
			messages.push(await evt.data.text())
		} else {
			messages.push(String(evt.data))
		}
		for (const cb of messageListeners) cb()
	}
	ws.onclose = (evt) => closeResolve?.({ code: evt.code, reason: evt.reason })

	return {
		close(code?: number, reason?: string) {
			ws.close(code, reason)
		},
		messages,
		send(data: string) {
			ws.send(data)
		},
		waitForClose() {
			return new Promise((resolve) => {
				if (ws.readyState === WebSocket.CLOSED) {
					resolve({ code: 0, reason: "" })
					return
				}
				closeResolve = resolve
			})
		},
		waitForMessages(count: number, timeout = 5000) {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(
						new Error(
							`Timeout: expected ${count} messages, got ${messages.length}: ${JSON.stringify(messages)}`,
						),
					)
				}, timeout)

				const check = () => {
					if (messages.length >= count) {
						clearTimeout(timer)
						resolve(messages.slice(0, count))
					}
				}
				messageListeners.push(check)
				check()
			})
		},
		waitForOpen() {
			return new Promise((resolve, reject) => {
				if (ws.readyState === WebSocket.OPEN) {
					resolve()
					return
				}
				openResolve = resolve
				ws.onerror = (evt) => reject(evt)
			})
		},
	}
}

test.describe("WebSocket", () => {
	test("GET without Upgrade header to WS route returns 426", async ({ request }) => {
		const res = await request.get("/api/echo-ws")
		expect(res.status()).toBe(426)
		/* workerd strips upgrade header from non-101 responses */
		if (res.headers()["upgrade"]) {
			expect(res.headers()["upgrade"]).toBe("websocket")
		}
	})

	test("echo: connect, receive greeting, close", async () => {
		const ws = connectWs(`${WS_BASE}/api/echo-ws`)
		const msgs = await ws.waitForMessages(1)
		expect(msgs[0]).toBe("connected")
		ws.close(1000, "done")
		const closeEvt = await ws.waitForClose()
		/* Node ws adapter may report 1006 depending on close handshake timing */
		expect([1000, 1006]).toContain(closeEvt.code)
	})

	test("echo: send message and receive echo back", async () => {
		const ws = connectWs(`${WS_BASE}/api/echo-ws`)
		await ws.waitForMessages(1) /* "connected" greeting */

		/* small delay to ensure the WS connection is fully established */
		await new Promise((r) => setTimeout(r, 50))
		ws.send("hello")
		const msgs = await ws.waitForMessages(2) /* "connected" + "hello" echo */
		expect(msgs[1]).toBe("hello")

		ws.close(1000)
		await ws.waitForClose()
	})

	test("reconnection: onReconnect called when reconnect_token present", async () => {
		const ws = connectWs(`${WS_BASE}/api/reconnect-ws?reconnect_token=my-session-42`)
		const msgs = await ws.waitForMessages(1)
		const parsed = JSON.parse(msgs[0])
		expect(parsed.event).toBe("reconnected")
		expect(parsed.token).toBe("my-session-42")
		ws.close(1000)
		await ws.waitForClose()
	})

	test("reconnection: onOpen called when no reconnect_token", async () => {
		const ws = connectWs(`${WS_BASE}/api/reconnect-ws`)
		const msgs = await ws.waitForMessages(1)
		const parsed = JSON.parse(msgs[0])
		expect(parsed.event).toBe("open")
		expect(parsed.token).toBe("fresh-token-123")
		ws.close(1000)
		await ws.waitForClose()
	})

	test("unauthenticated WS /api/v1/socket gets rejected by middleware", async () => {
		/* WS upgrade without auth token — middleware throws unauthorized,
		   server.on("upgrade") writes the rejection to the raw socket.
		   The WebSocket client sees a connection error. */
		const ws = new WebSocket(`${WS_BASE}/api/v1/socket`)
		const closed = new Promise<number>((resolve) => {
			ws.onclose = (evt) => resolve(evt.code)
			ws.onerror = () => resolve(-1)
		})

		const code = await closed
		/* Connection should fail (middleware rejects before upgrade completes) */
		expect(code).not.toBe(1000)
	})
})
