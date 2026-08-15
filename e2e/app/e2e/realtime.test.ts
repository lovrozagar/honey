/* eslint-disable unicorn/prefer-add-event-listener */
import { expect, test } from "@playwright/test"

const WS_PORT = (globalThis as Record<string, unknown>).process
	? (((globalThis as Record<string, unknown>).process as Record<string, Record<string, string>>).env.PORT ?? "4101")
	: "4101"
const WS_BASE = `ws://localhost:${WS_PORT}`

/**
 * Helper: opens a WebSocket to a realtime endpoint, collects parsed frames.
 * Uses Node.js built-in WebSocket (Node 22+).
 */
function connectRealtime(path: string): {
	close(code?: number, reason?: string): void
	frames: unknown[]
	send(data: unknown): void
	waitForClose(): Promise<{ code: number; reason: string }>
	waitForFrames(count: number, timeout?: number): Promise<unknown[]>
	waitForOpen(): Promise<void>
} {
	const frames: unknown[] = []
	const frameListeners: Array<() => void> = []
	let openResolve: (() => void) | null = null
	let closeResolve: ((v: { code: number; reason: string }) => void) | null = null

	const ws = new WebSocket(`${WS_BASE}${path}`)

	ws.onopen = () => openResolve?.()
	ws.onmessage = (evt) => {
		let text: string
		if (typeof evt.data === "string") {
			text = evt.data
		} else {
			text = String(evt.data)
		}
		try {
			frames.push(JSON.parse(text))
		} catch {
			frames.push(text)
		}
		for (const cb of frameListeners) cb()
	}
	ws.onclose = (evt) => closeResolve?.({ code: evt.code, reason: evt.reason })

	return {
		close(code?: number, reason?: string) {
			ws.close(code, reason)
		},
		frames,
		send(data: unknown) {
			ws.send(JSON.stringify(data))
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
		waitForFrames(count: number, timeout = 5000) {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(
						new Error(
							`Timeout: expected ${count} frames, got ${frames.length}: ${JSON.stringify(frames)}`,
						),
					)
				}, timeout)

				const check = () => {
					if (frames.length >= count) {
						clearTimeout(timer)
						resolve(frames.slice(0, count))
					}
				}
				frameListeners.push(check)
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

test.describe("Realtime", () => {
	test("connect to realtime echo route and receive connected event", async () => {
		const ws = connectRealtime("/api/realtime/echo")
		const received = await ws.waitForFrames(1)

		const firstFrame = received[0] as Record<string, unknown>
		expect(firstFrame.event).toBe("connected")
		expect(typeof firstFrame.id).toBe("string")

		ws.close(1000)
		await ws.waitForClose()
	})

	test("echo: send message and receive echo back", async () => {
		const ws = connectRealtime("/api/realtime/echo")
		await ws.waitForFrames(1) /* connected event */

		ws.send({ data: { text: "hello realtime" }, t: "msg" })
		const received = await ws.waitForFrames(2)

		const echoFrame = received[1] as Record<string, unknown>
		expect(echoFrame.echo).toBeDefined()

		ws.close(1000)
		await ws.waitForClose()
	})

	test("GET without Upgrade header to realtime route returns 426", async ({ request }) => {
		const res = await request.get("/api/realtime/echo")
		expect(res.status()).toBe(426)
	})

	test("chat: connect to room and receive joined event", async () => {
		const ws = connectRealtime("/api/realtime/chat/room-42")
		const received = await ws.waitForFrames(1)

		const frame = received[0] as Record<string, unknown>
		expect(frame.event).toBe("joined")

		ws.close(1000)
		await ws.waitForClose()
	})

	test("each connection gets a unique id", async () => {
		const ws1 = connectRealtime("/api/realtime/echo")
		const ws2 = connectRealtime("/api/realtime/echo")

		const frames1 = await ws1.waitForFrames(1)
		const frames2 = await ws2.waitForFrames(1)

		const id1 = (frames1[0] as Record<string, unknown>).id
		const id2 = (frames2[0] as Record<string, unknown>).id

		expect(id1).not.toBe(id2)

		ws1.close(1000)
		ws2.close(1000)
		await Promise.all([ws1.waitForClose(), ws2.waitForClose()])
	})

	test("clean close with code 1000", async () => {
		const ws = connectRealtime("/api/realtime/echo")
		await ws.waitForFrames(1)

		ws.close(1000, "done")
		const closeEvt = await ws.waitForClose()
		expect([1000, 1006]).toContain(closeEvt.code)
	})
})
