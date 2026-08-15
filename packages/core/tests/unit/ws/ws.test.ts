import { describe, expect, it, vi } from "vitest"
import { honey } from "../../../src/index.ts"
import type { MiddlewareFn } from "../../../src/middleware.ts"
import type { WSRouteHandler } from "../../../src/tree.ts"
import { createNode, insertWsRoute, matchWsRoute } from "../../../src/tree.ts"
import type { WSAdapter, WSHandler } from "../../../src/ws/cloudflare.ts"
import { WS_SEND_BUFFER_MAX, WSContextImpl } from "../../../src/ws/cloudflare.ts"

/**
 * Node.js Response constructor rejects status 101 (only 200-599 valid per Fetch spec).
 * CF Workers extends Response to support 101 + webSocket property.
 * For tests, we create a synthetic 101 response.
 */
function make101Response(): Response {
	const response = new Response(null, { status: 200 })
	Object.defineProperty(response, "status", { value: 101 })
	return response
}

/**
 * Test-only WS adapter that simulates upgrade without runtime-specific APIs.
 * Returns the wrapped handler + socket so tests can simulate events.
 */
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

	return {
		adapter,
		fireClose(code: number, reason: string) {
			if (state.handler?.onClose && state.socket) {
				state.handler.onClose(undefined, state.socket, code, reason)
			}
		},
		fireError(err: unknown) {
			if (state.handler?.onError && state.socket) {
				state.handler.onError(undefined, state.socket, err)
			}
		},
		fireMessage(data: ArrayBuffer | string) {
			if (state.handler?.onMessage && state.socket) {
				state.handler.onMessage(undefined, state.socket, data)
			}
		},
		mockRaw,
	}
}

/* ---- WSContextImpl ---- */

describe("WSContext", () => {
	function makeMockSocket() {
		return {
			close: vi.fn(),
			readyState: 1,
			send: vi.fn(),
		}
	}

	it("caps pre-open send buffer and keeps the newest frames", () => {
		const listeners: Record<string, Array<() => void>> = {}
		const raw = {
			addEventListener(type: string, fn: () => void) {
				;(listeners[type] ??= []).push(fn)
			},
			close: vi.fn(),
			readyState: 0,
			send: vi.fn(),
		}
		const ws = new WSContextImpl(raw)
		for (let i = 0; i < 40; i++) ws.send(`m${i}`)
		raw.readyState = 1
		for (const fn of listeners.open ?? []) fn()
		expect(raw.send).toHaveBeenCalledTimes(WS_SEND_BUFFER_MAX)
		expect(raw.send.mock.calls[0]?.[0]).toBe("m8")
		expect(raw.send.mock.calls[WS_SEND_BUFFER_MAX - 1]?.[0]).toBe("m39")
	})

	it("send(string) delegates to raw socket", () => {
		const raw = makeMockSocket()
		const ws = new WSContextImpl(raw)
		ws.send("hello")
		expect(raw.send).toHaveBeenCalledWith("hello")
	})

	it("send(object) JSON.stringify then send", () => {
		const raw = makeMockSocket()
		const ws = new WSContextImpl(raw)
		ws.send({ msg: "hi" })
		expect(raw.send).toHaveBeenCalledWith('{"msg":"hi"}')
	})

	it("send(ArrayBuffer) pass-through", () => {
		const raw = makeMockSocket()
		const ws = new WSContextImpl(raw)
		const buf = new ArrayBuffer(4)
		ws.send(buf)
		expect(raw.send).toHaveBeenCalledWith(buf)
	})

	it("close() delegates with code + reason", () => {
		const raw = makeMockSocket()
		const ws = new WSContextImpl(raw)
		ws.close(1000, "done")
		expect(raw.close).toHaveBeenCalledWith(1000, "done")
	})

	it("readyState mirrors raw socket", () => {
		const raw = makeMockSocket()
		raw.readyState = 2
		const ws = new WSContextImpl(raw)
		expect(ws.readyState).toBe(2)
	})
})

/* ---- cfWebSocket adapter (limited to non-Response tests in Node) ---- */

describe("cfWebSocket adapter", () => {
	function mockWebSocketPair() {
		const listeners: Record<string, Array<(evt: unknown) => void>> = {}
		const mockServer = {
			accept: vi.fn(),
			addEventListener: vi.fn((event: string, cb: (evt: unknown) => void) => {
				if (!listeners[event]) listeners[event] = []
				listeners[event].push(cb)
			}),
			close: vi.fn(),
			readyState: 1,
			send: vi.fn(),
		}
		const mockClient = { close: vi.fn(), readyState: 1, send: vi.fn() }

		/* assign directly — bun test runner has no vi.stubGlobal */
		;(globalThis as Record<string, unknown>).WebSocketPair = function WebSocketPair() {
			return [mockClient, mockServer]
		}

		return { listeners, mockClient, mockServer }
	}

	it("upgrade calls accept and fires onOpen", async () => {
		const { mockServer } = mockWebSocketPair()
		const { cfWebSocket } = await import("../../../src/ws/cloudflare.ts")
		const adapter = cfWebSocket()
		const onOpen = vi.fn()

		/* cfWebSocket internally creates Response(null, { status: 101 }) which
		   fails in Node. We catch and verify side-effects instead. */
		try {
			adapter.upgrade(new Request("http://localhost/ws"), {}, { onOpen })
		} catch {
			/* expected in Node — Response rejects 101 */
		}

		expect(mockServer.accept).toHaveBeenCalledOnce()
		expect(onOpen).toHaveBeenCalledOnce()

		delete (globalThis as Record<string, unknown>).WebSocketPair
	})

	it("wires addEventListener for message/close/error", async () => {
		const { listeners } = mockWebSocketPair()
		const { cfWebSocket } = await import("../../../src/ws/cloudflare.ts")
		const adapter = cfWebSocket()
		const onMessage = vi.fn()
		const onClose = vi.fn()
		const onError = vi.fn()

		try {
			adapter.upgrade(new Request("http://localhost/ws"), {}, { onClose, onError, onMessage })
		} catch {
			/* expected — 101 Response fails in Node */
		}

		for (const cb of listeners["message"] ?? []) {
			cb({ data: "hello" })
		}
		expect(onMessage).toHaveBeenCalledWith(undefined, expect.anything(), "hello")

		for (const cb of listeners["close"] ?? []) {
			cb({ code: 1000, reason: "bye" })
		}
		expect(onClose).toHaveBeenCalledWith(undefined, expect.anything(), 1000, "bye")

		const errEvt = new Event("error")
		for (const cb of listeners["error"] ?? []) {
			cb(errEvt)
		}
		expect(onError).toHaveBeenCalledWith(undefined, expect.anything(), errEvt)

		delete (globalThis as Record<string, unknown>).WebSocketPair
	})
})

/* ---- tree: insertWsRoute / matchWsRoute ---- */

describe("WS tree operations", () => {
	function makeWsHandler(): WSRouteHandler {
		return {
			bek: null,
			ek: new Set(),
			fn: { onOpen: vi.fn() },
			iv: null,
			mt: null,
			mw: [],
		}
	}

	it("insert and match static WS route", () => {
		const root = createNode()
		const handler = makeWsHandler()
		insertWsRoute(root, "/ws", handler)

		const result = matchWsRoute(root, "/ws")
		expect(result).not.toBeNull()
		expect(result?.handler).toBe(handler)
		expect(Object.keys(result?.params ?? {})).toHaveLength(0)
	})

	it("insert and match dynamic WS route", () => {
		const root = createNode()
		const handler = makeWsHandler()
		insertWsRoute(root, "/rooms/:roomId", handler)

		const result = matchWsRoute(root, "/rooms/abc")
		expect(result).not.toBeNull()
		expect(result?.params.roomId).toBe("abc")
		expect(result?.handler).toBe(handler)
	})

	it("returns null for unmatched path", () => {
		const root = createNode()
		insertWsRoute(root, "/ws", makeWsHandler())

		expect(matchWsRoute(root, "/other")).toBeNull()
	})

	it("throws on duplicate WS route", () => {
		const root = createNode()
		insertWsRoute(root, "/ws", makeWsHandler())

		expect(() => insertWsRoute(root, "/ws", makeWsHandler())).toThrow("Duplicate WebSocket route")
	})

	it("throws on wildcard segments", () => {
		const root = createNode()
		expect(() => insertWsRoute(root, "/ws/*rest", makeWsHandler())).toThrow("Wildcard segments not supported")
	})
})

/* ---- Honey WS integration ---- */

describe("Honey .ws() integration", () => {
	it("HTTP GET without Upgrade header to .ws() route returns 426", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)
		app.ws("/ws").handler({ onOpen: vi.fn() })

		const res = await app.fetch(new Request("http://localhost/ws"), {})
		expect(res.status).toBe(426)
		expect(res.headers.get("upgrade")).toBe("websocket")
	})

	it("WS upgrade returns 101", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)
		app.ws("/ws").handler({ onOpen: vi.fn() })

		const req = new Request("http://localhost/ws", {
			headers: { connection: "Upgrade", upgrade: "websocket" },
		})
		const res = await app.fetch(req, {})
		expect(res.status).toBe(101)
	})

	it("no wsAdapter configured returns 500", async () => {
		const app = honey()
		app.ws("/ws").handler({ onOpen: vi.fn() })

		const req = new Request("http://localhost/ws", {
			headers: { connection: "Upgrade", upgrade: "websocket" },
		})
		const res = await app.fetch(req, {})
		expect(res.status).toBe(500)

		const body = (await res.json()) as Record<string, unknown>
		/* must NOT leak internal config details */
		expect(body.error_key).toBe("internal_server_error")
		expect(body.error).toBeUndefined()
	})

	it("WS route and HTTP route on different paths coexist", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)
		app.ws("/ws").handler({ onOpen: vi.fn() })
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const httpRes = await app.fetch(new Request("http://localhost/health"), {})
		expect(httpRes.status).toBe(200)
		expect(await httpRes.text()).toBe("ok")

		const wsReq = new Request("http://localhost/ws", {
			headers: { connection: "Upgrade", upgrade: "websocket" },
		})
		const wsRes = await app.fetch(wsReq, {})
		expect(wsRes.status).toBe(101)
	})

	it("preUpgrade is not called for Upgrade on a non-WS path", async () => {
		let preCount = 0
		const { adapter } = createTestAdapter()
		adapter.preUpgrade = () => {
			preCount++
			return {
				response: make101Response(),
				socket: new WSContextImpl({ close: vi.fn(), readyState: 1, send: vi.fn() }),
				whenOpen(fn) {
					fn()
				},
			}
		}
		const app = honey().wsAdapter(adapter)
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		app.ws("/ws").handler({ onOpen: vi.fn() })

		const res = await app.fetch(new Request("http://localhost/health", { headers: { upgrade: "websocket" } }), {})
		expect(preCount).toBe(0)
		expect(res.status).not.toBe(101)
	})

	it("preUpgrade is called for an actual WS route", async () => {
		let preCount = 0
		const { adapter } = createTestAdapter()
		adapter.preUpgrade = () => {
			preCount++
			return {
				response: make101Response(),
				socket: new WSContextImpl({ close: vi.fn(), readyState: 1, send: vi.fn() }),
				whenOpen(fn) {
					fn()
				},
			}
		}
		const app = honey().wsAdapter(adapter)
		app.ws("/ws").handler({ onOpen: vi.fn() })

		const res = await app.fetch(new Request("http://localhost/ws", { headers: { upgrade: "websocket" } }), {})
		expect(preCount).toBe(1)
		expect(res.status).toBe(101)
	})

	it("middleware chain runs once on upgrade with ctx enrichment", async () => {
		const { adapter } = createTestAdapter()

		type DbCtx = { db: string }
		const withDb: MiddlewareFn<{}, DbCtx> = async (_ctx, next) => {
			return next({ db: "test-db" })
		}

		const capturedDb: string[] = []
		const app = honey().wsAdapter(adapter)
		const authed = app.use(withDb)

		authed.ws("/ws").handler({
			onOpen: (ctx) => {
				capturedDb.push(ctx.db)
			},
		})

		const req = new Request("http://localhost/ws", {
			headers: { connection: "Upgrade", upgrade: "websocket" },
		})
		await authed.fetch(req, {})

		expect(capturedDb).toHaveLength(1)
		expect(capturedDb[0]).toBe("test-db")
	})

	it("onClose receives code + reason", async () => {
		const { adapter, fireClose } = createTestAdapter()

		const closeCalls: Array<{ code: number; reason: string }> = []
		const app = honey().wsAdapter(adapter)
		app.ws("/ws").handler({
			onClose: (_ctx, _ws, code, reason) => {
				closeCalls.push({ code, reason })
			},
		})

		const req = new Request("http://localhost/ws", {
			headers: { connection: "Upgrade", upgrade: "websocket" },
		})
		await app.fetch(req, {})

		fireClose(1001, "going away")

		expect(closeCalls).toHaveLength(1)
		expect(closeCalls[0].code).toBe(1001)
		expect(closeCalls[0].reason).toBe("going away")
	})

	it("onError receives thrown error from onMessage queue", async () => {
		const { adapter, fireMessage } = createTestAdapter()

		const errorCalls: unknown[] = []
		const app = honey().wsAdapter(adapter)
		app.ws("/ws").handler({
			onError: (_ctx, _ws, error) => {
				errorCalls.push(error)
			},
			onMessage: async () => {
				throw new Error("handler boom")
			},
		})

		const req = new Request("http://localhost/ws", {
			headers: { connection: "Upgrade", upgrade: "websocket" },
		})
		await app.fetch(req, {})

		fireMessage("test")
		await new Promise((r) => setTimeout(r, 10))

		expect(errorCalls).toHaveLength(1)
		expect((errorCalls[0] as Error).message).toBe("handler boom")
	})

	it("sequential onMessage: second message waits for first async handler", async () => {
		const { adapter, fireMessage } = createTestAdapter()

		const order: number[] = []
		const app = honey().wsAdapter(adapter)
		app.ws("/ws").handler({
			onMessage: async (_ctx, _ws, data) => {
				const msg = data as string
				const delay = msg === "first" ? 30 : 0
				await new Promise((r) => setTimeout(r, delay))
				order.push(msg === "first" ? 1 : 2)
			},
		})

		const req = new Request("http://localhost/ws", {
			headers: { connection: "Upgrade", upgrade: "websocket" },
		})
		await app.fetch(req, {})

		fireMessage("first")
		fireMessage("second")

		await new Promise((r) => setTimeout(r, 80))

		expect(order).toEqual([1, 2])
	})
})
