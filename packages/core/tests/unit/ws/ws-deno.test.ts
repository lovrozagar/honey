import { describe, expect, it, vi } from "vitest"
import type { WSContext, WSHandler } from "../../../src/ws/cloudflare.ts"
import { denoWebSocket } from "../../../src/ws/deno.ts"

function mockDenoGlobal() {
	const listeners: Record<string, Array<(...args: never[]) => void>> = {}
	const rawSocket = {
		addEventListener(type: string, listener: (...args: never[]) => void) {
			listeners[type] = listeners[type] ?? []
			listeners[type].push(listener)
		},
		close: vi.fn(),
		readyState: 1,
		send: vi.fn(),
	}
	const response = new Response(null, { status: 200 })
	Object.defineProperty(response, "status", { value: 101 })

	;(globalThis as Record<string, unknown>).Deno = {
		upgradeWebSocket: vi.fn(() => ({ response, socket: rawSocket })),
	}

	function emit(type: string, ...args: unknown[]) {
		for (const fn of listeners[type] ?? []) {
			;(fn as (...a: unknown[]) => void)(...args)
		}
	}

	return { emit, rawSocket, response }
}

function cleanupDenoGlobal() {
	delete (globalThis as Record<string, unknown>).Deno
}

describe("denoWebSocket adapter", () => {
	it("calls Deno.upgradeWebSocket with request", () => {
		mockDenoGlobal()
		const adapter = denoWebSocket()
		const req = new Request("http://localhost/ws")
		const handler: WSHandler<unknown> = {}

		adapter.upgrade(req, {}, handler)

		const denoNs = (globalThis as Record<string, unknown>).Deno as Record<string, unknown>
		/* Deno pings idle sockets itself: the shared idleTimeout goes over in seconds */
		expect(denoNs.upgradeWebSocket).toHaveBeenCalledWith(req, { idleTimeout: 120 })
		cleanupDenoGlobal()
	})

	it("passes the chosen subprotocol and sets binaryType to arraybuffer", () => {
		const { rawSocket } = mockDenoGlobal()
		const adapter = denoWebSocket({ idleTimeout: 0 })
		const req = new Request("http://localhost/ws", { headers: { "sec-websocket-protocol": "a, b" } })
		adapter.upgrade(req, {}, {})
		const denoNs = (globalThis as Record<string, unknown>).Deno as Record<string, unknown>
		expect(denoNs.upgradeWebSocket).toHaveBeenCalledWith(req, { protocol: "a" })
		expect((rawSocket as { binaryType?: string }).binaryType).toBe("arraybuffer")
		cleanupDenoGlobal()
	})

	it("preUpgrade holds frames that arrive before the handler is bound, then delivers them in order", () => {
		const { emit } = mockDenoGlobal()
		const adapter = denoWebSocket()
		const req = new Request("http://localhost/ws")
		adapter.preUpgrade?.(req)
		emit("open")
		emit("message", { data: "first" })
		emit("message", { data: "second" })
		const seen: string[] = []
		adapter.upgrade(
			req,
			{},
			{
				onMessage: (_c, _ws, data) => {
					seen.push(String(data))
				},
				onOpen: () => {
					seen.push("open")
				},
			},
		)
		expect(seen).toEqual(["open", "first", "second"])
		emit("message", { data: "third" })
		expect(seen).toEqual(["open", "first", "second", "third"])
		cleanupDenoGlobal()
	})

	it("closes with 1009 on a message over maxPayload", () => {
		const { emit, rawSocket } = mockDenoGlobal()
		const adapter = denoWebSocket({ maxPayload: 4 })
		const onMessage = vi.fn()
		adapter.upgrade(new Request("http://localhost/ws"), {}, { onMessage })
		emit("message", { data: "12345" })
		expect(onMessage).not.toHaveBeenCalled()
		expect(rawSocket.close).toHaveBeenCalledWith(1009, "message too big")
		cleanupDenoGlobal()
	})

	it("returns response and socket from upgrade", () => {
		const { response } = mockDenoGlobal()
		const adapter = denoWebSocket()
		const handler: WSHandler<unknown> = {}

		const result = adapter.upgrade(new Request("http://localhost/ws"), {}, handler) as {
			response: Response
			socket: WSContext<unknown>
		}
		expect(result.response).toBe(response)
		expect(result.socket).toBeDefined()
		cleanupDenoGlobal()
	})

	it("wires onOpen event", () => {
		const { emit } = mockDenoGlobal()
		const adapter = denoWebSocket()
		const onOpen = vi.fn()
		const handler: WSHandler<unknown> = { onOpen }

		adapter.upgrade(new Request("http://localhost/ws"), {}, handler)

		emit("open")
		expect(onOpen).toHaveBeenCalledOnce()
		cleanupDenoGlobal()
	})

	it("wires onMessage event with data", () => {
		const { emit } = mockDenoGlobal()
		const adapter = denoWebSocket()
		const onMessage = vi.fn()
		const handler: WSHandler<unknown> = { onMessage }

		adapter.upgrade(new Request("http://localhost/ws"), {}, handler)

		emit("message", { data: "hello" })
		expect(onMessage).toHaveBeenCalledOnce()
		expect(onMessage.mock.calls[0][2]).toBe("hello")
		cleanupDenoGlobal()
	})

	it("wires onMessage event with binary data", () => {
		const { emit } = mockDenoGlobal()
		const adapter = denoWebSocket()
		const onMessage = vi.fn()
		const handler: WSHandler<unknown> = { onMessage }

		adapter.upgrade(new Request("http://localhost/ws"), {}, handler)

		const binary = new ArrayBuffer(4)
		emit("message", { data: binary })
		expect(onMessage.mock.calls[0][2]).toBe(binary)
		cleanupDenoGlobal()
	})

	it("wires onClose event with code and reason", () => {
		const { emit } = mockDenoGlobal()
		const adapter = denoWebSocket()
		const onClose = vi.fn()
		const handler: WSHandler<unknown> = { onClose }

		adapter.upgrade(new Request("http://localhost/ws"), {}, handler)

		emit("close", { code: 1000, reason: "normal" })
		expect(onClose).toHaveBeenCalledOnce()
		expect(onClose.mock.calls[0][2]).toBe(1000)
		expect(onClose.mock.calls[0][3]).toBe("normal")
		cleanupDenoGlobal()
	})

	it("wires onError event", () => {
		const { emit } = mockDenoGlobal()
		const adapter = denoWebSocket()
		const onError = vi.fn()
		const handler: WSHandler<unknown> = { onError }

		adapter.upgrade(new Request("http://localhost/ws"), {}, handler)

		const err = new Error("ws error")
		emit("error", err)
		expect(onError).toHaveBeenCalledOnce()
		expect(onError.mock.calls[0][2]).toBe(err)
		cleanupDenoGlobal()
	})

	it("WSContextImpl wraps rawSocket for send/close", () => {
		const { rawSocket } = mockDenoGlobal()
		const adapter = denoWebSocket()
		const handler: WSHandler<unknown> = {}

		const result = adapter.upgrade(new Request("http://localhost/ws"), {}, handler) as {
			response: Response
			socket: WSContext<unknown>
		}

		result.socket.send("test")
		expect(rawSocket.send).toHaveBeenCalledWith("test")

		result.socket.close(1000, "done")
		expect(rawSocket.close).toHaveBeenCalledWith(1000, "done")
		cleanupDenoGlobal()
	})

	it("works when handler has no event callbacks", () => {
		mockDenoGlobal()
		const adapter = denoWebSocket()
		const handler: WSHandler<unknown> = {}

		/* should not throw when no callbacks set */
		expect(() => adapter.upgrade(new Request("http://localhost/ws"), {}, handler)).not.toThrow()
		cleanupDenoGlobal()
	})
})
