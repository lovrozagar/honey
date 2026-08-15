import { describe, expect, it, vi } from "vitest"
import { honey } from "../../../src/index.ts"
import type { WSAdapter, WSHandler } from "../../../src/ws/cloudflare.ts"
import { WSContextImpl } from "../../../src/ws/cloudflare.ts"

function make101Response(): Response {
	const response = new Response(null, { status: 200 })
	Object.defineProperty(response, "status", { value: 101 })
	return response
}

function createTestAdapter() {
	type State = {
		handler: WSHandler<unknown> | null
		socket: WSContextImpl | null
	}
	const state: State = { handler: null, socket: null }
	const mockRaw = { close: vi.fn(), readyState: 1, send: vi.fn() }

	const adapter: WSAdapter = {
		upgrade(_req, _env, handler) {
			const socket = new WSContextImpl(mockRaw)
			state.handler = handler
			state.socket = socket
			handler.onOpen?.(undefined, socket)
			return { response: make101Response(), socket }
		},
	}

	return { adapter, mockRaw, state }
}

describe("WebSocket reconnection protocol", () => {
	it("calls onReconnect instead of onOpen when reconnect_token present", async () => {
		const { adapter } = createTestAdapter()
		const onOpen = vi.fn()
		const onReconnect = vi.fn()

		const app = honey()
		app.wsAdapter(adapter)
		app.ws("/ws").handler({
			onOpen,
			onReconnect,
		})

		const req = new Request("http://localhost/ws?reconnect_token=abc123", {
			headers: { upgrade: "websocket" },
		})
		const res = await app.fetch(req, {})
		expect(res.status).toBe(101)

		expect(onOpen).not.toHaveBeenCalled()
		expect(onReconnect).toHaveBeenCalledOnce()
		expect(onReconnect).toHaveBeenCalledWith(
			expect.anything() /* ctx */,
			expect.anything() /* ws */,
			"abc123" /* token */,
		)
	})

	it("calls onOpen normally when no reconnect_token", async () => {
		const { adapter } = createTestAdapter()
		const onOpen = vi.fn()
		const onReconnect = vi.fn()

		const app = honey()
		app.wsAdapter(adapter)
		app.ws("/ws").handler({
			onOpen,
			onReconnect,
		})

		const req = new Request("http://localhost/ws", {
			headers: { upgrade: "websocket" },
		})
		const res = await app.fetch(req, {})
		expect(res.status).toBe(101)

		expect(onOpen).toHaveBeenCalledOnce()
		expect(onReconnect).not.toHaveBeenCalled()
	})

	it("calls onOpen when reconnect_token present but no onReconnect handler", async () => {
		const { adapter } = createTestAdapter()
		const onOpen = vi.fn()

		const app = honey()
		app.wsAdapter(adapter)
		app.ws("/ws").handler({
			onOpen,
		})

		const req = new Request("http://localhost/ws?reconnect_token=abc123", {
			headers: { upgrade: "websocket" },
		})
		const res = await app.fetch(req, {})
		expect(res.status).toBe(101)

		expect(onOpen).toHaveBeenCalledOnce()
	})
})
