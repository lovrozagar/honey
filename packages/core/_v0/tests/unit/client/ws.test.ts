import { describe, expect, it, vi } from "vitest"
import { createTypedWebSocket } from "../../../src/client/ws.ts"

/* mock WebSocket for unit testing */
class MockWebSocket {
	static CONNECTING = 0
	static OPEN = 1
	static CLOSING = 2
	static CLOSED = 3

	url: string
	readyState = MockWebSocket.CONNECTING
	private _listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
	sentMessages: string[] = []

	constructor(url: string) {
		this.url = url
		/* simulate async open */
		queueMicrotask(() => {
			this.readyState = MockWebSocket.OPEN
			this._emit("open", { type: "open" })
		})
	}

	addEventListener(event: string, handler: (...args: unknown[]) => void) {
		if (!this._listeners[event]) this._listeners[event] = []
		this._listeners[event].push(handler)
	}

	removeEventListener(event: string, handler: (...args: unknown[]) => void) {
		const list = this._listeners[event]
		if (list) {
			this._listeners[event] = list.filter((h) => h !== handler)
		}
	}

	send(data: string) {
		this.sentMessages.push(data)
	}

	close(code?: number, reason?: string) {
		this.readyState = MockWebSocket.CLOSED
		this._emit("close", { code: code ?? 1000, reason: reason ?? "", type: "close" })
	}

	/* test helper: simulate incoming message */
	_emit(event: string, data: unknown) {
		for (const handler of this._listeners[event] ?? []) {
			handler(data)
		}
	}

	_simulateMessage(data: string) {
		this._emit("message", { data, type: "message" })
	}
}

describe("createTypedWebSocket", () => {
	it("wraps WebSocket with typed interface", () => {
		const ws = createTypedWebSocket("ws://test/echo", undefined, MockWebSocket as unknown as typeof WebSocket)
		expect(ws).toBeDefined()
		expect(typeof ws.send).toBe("function")
		expect(typeof ws.on).toBe("function")
		expect(typeof ws.close).toBe("function")
	})

	it("sends string messages", async () => {
		const ws = createTypedWebSocket("ws://test/echo", undefined, MockWebSocket as unknown as typeof WebSocket)
		await new Promise((r) => setTimeout(r, 10))
		ws.send("hello")

		const raw = (ws as unknown as { _ws: MockWebSocket })._ws
		expect(raw.sentMessages).toContain("hello")
	})

	it("auto-stringifies objects", async () => {
		const ws = createTypedWebSocket("ws://test/echo", undefined, MockWebSocket as unknown as typeof WebSocket)
		await new Promise((r) => setTimeout(r, 10))
		ws.send({ msg: "hi" } as unknown as string)

		const raw = (ws as unknown as { _ws: MockWebSocket })._ws
		expect(raw.sentMessages).toContain(JSON.stringify({ msg: "hi" }))
	})

	it("receives messages via on()", async () => {
		const ws = createTypedWebSocket("ws://test/echo", undefined, MockWebSocket as unknown as typeof WebSocket)
		const messages: string[] = []
		ws.on("message", (data) => messages.push(data))

		const raw = (ws as unknown as { _ws: MockWebSocket })._ws
		raw._simulateMessage("world")

		expect(messages).toEqual(["world"])
	})

	it("fires open event", async () => {
		const opened = vi.fn()
		const ws = createTypedWebSocket("ws://test/echo", undefined, MockWebSocket as unknown as typeof WebSocket)
		ws.on("open", opened)
		await new Promise((r) => setTimeout(r, 10))
		expect(opened).toHaveBeenCalledOnce()
	})

	it("fires close event", async () => {
		const closed = vi.fn()
		const ws = createTypedWebSocket("ws://test/echo", undefined, MockWebSocket as unknown as typeof WebSocket)
		ws.on("close", closed)
		await new Promise((r) => setTimeout(r, 10))
		ws.close(1000, "done")
		expect(closed).toHaveBeenCalledWith(1000, "done")
	})

	it("exposes readyState", async () => {
		const ws = createTypedWebSocket("ws://test/echo", undefined, MockWebSocket as unknown as typeof WebSocket)
		await new Promise((r) => setTimeout(r, 10))
		expect(ws.readyState).toBe(MockWebSocket.OPEN)
	})
})
