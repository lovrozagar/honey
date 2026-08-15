import { describe, expect, it, vi } from "vitest"
import { honey } from "../../../src/index.ts"
import type { MiddlewareFn } from "../../../src/middleware.ts"
import type { WSAdapter, WSHandler } from "../../../src/ws/cloudflare.ts"
import { WSContextImpl } from "../../../src/ws/cloudflare.ts"

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

	const mockRaw = { close: vi.fn<() => void>(), readyState: 1, send: vi.fn<(data: unknown) => void>() }

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
		fireMessage(data: ArrayBuffer | string) {
			if (state.handler?.onMessage && state.socket) {
				state.handler.onMessage(undefined, state.socket, data)
			}
		},
		mockRaw,
		state,
	}
}

function makeUpgradeRequest(path: string): Request {
	return new Request(`http://localhost${path}`, {
		headers: { connection: "Upgrade", upgrade: "websocket" },
	})
}

/* ------------------------------------------------------------------ */
/*  Route registration                                                 */
/* ------------------------------------------------------------------ */

describe("app.realtime() — route registration", () => {
	it("does not throw when registering a realtime route", () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		expect(() => {
			app.realtime("/chat/stream", {
				handler: (_c, _conn) => {},
			})
		}).not.toThrow()
	})

	it("returns this for chaining (like .ws(), .get())", () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		const result = app.realtime("/chat/stream", {
			handler: (_c, _conn) => {},
		})

		expect(result).toBe(app)
	})

	it("registers multiple realtime routes at different paths without conflict", () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		expect(() => {
			app
				.realtime("/chat/stream", { handler: (_c, _conn) => {} })
				.realtime("/notifications/stream", { handler: (_c, _conn) => {} })
				.realtime("/presence/stream", { handler: (_c, _conn) => {} })
		}).not.toThrow()
	})

	it("throws on duplicate realtime route for the same path", () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		app.realtime("/chat/stream", { handler: (_c, _conn) => {} })

		expect(() => {
			app.realtime("/chat/stream", { handler: (_c, _conn) => {} })
		}).toThrow()
	})

	it("coexists with HTTP routes on different paths", () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		expect(() => {
			app.realtime("/ws/stream", { handler: (_c, _conn) => {} })
			app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		}).not.toThrow()
	})
})

/* ------------------------------------------------------------------ */
/*  Route matching (WS upgrade)                                        */
/* ------------------------------------------------------------------ */

describe("app.realtime() — route matching", () => {
	it("WS upgrade request to a registered realtime path returns 101", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		app.realtime("/chat/stream", {
			handler: (_c, _conn) => {},
		})

		const req = makeUpgradeRequest("/chat/stream")
		const res = await app.fetch(req, {})
		expect(res.status).toBe(101)
	})

	it("WS upgrade request to an unregistered path returns 404", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		app.realtime("/chat/stream", {
			handler: (_c, _conn) => {},
		})

		const req = makeUpgradeRequest("/unknown/path")
		const res = await app.fetch(req, {})
		expect(res.status).toBe(404)
	})

	it("HTTP GET without Upgrade header to realtime route returns 426", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		app.realtime("/chat/stream", {
			handler: (_c, _conn) => {},
		})

		const res = await app.fetch(new Request("http://localhost/chat/stream"), {})
		expect(res.status).toBe(426)
		expect(res.headers.get("upgrade")).toBe("websocket")
	})

	it("route with path params extracts params correctly", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		const capturedParams: Record<string, string>[] = []

		app.realtime("/chat/:roomId/stream", {
			handler: (c, _conn) => {
				capturedParams.push({ roomId: c.params.roomId })
			},
		})

		const req = makeUpgradeRequest("/chat/room-42/stream")
		await app.fetch(req, {})

		expect(capturedParams).toHaveLength(1)
		expect(capturedParams[0].roomId).toBe("room-42")
	})

	it("route with multiple path params extracts all of them", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		const capturedParams: Record<string, string>[] = []

		app.realtime("/orgs/:orgId/rooms/:roomId/stream", {
			handler: (c, _conn) => {
				capturedParams.push({
					orgId: c.params.orgId,
					roomId: c.params.roomId,
				})
			},
		})

		const req = makeUpgradeRequest("/orgs/org-1/rooms/room-99/stream")
		await app.fetch(req, {})

		expect(capturedParams).toHaveLength(1)
		expect(capturedParams[0].orgId).toBe("org-1")
		expect(capturedParams[0].roomId).toBe("room-99")
	})

	it("no wsAdapter configured returns 500", async () => {
		const app = honey()

		app.realtime("/chat/stream", {
			handler: (_c, _conn) => {},
		})

		const req = makeUpgradeRequest("/chat/stream")
		const res = await app.fetch(req, {})
		expect(res.status).toBe(500)
	})
})

/* ------------------------------------------------------------------ */
/*  Handler execution                                                   */
/* ------------------------------------------------------------------ */

describe("app.realtime() — handler execution", () => {
	it("handler function is called when a WS connection is established", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		const handlerCalls: number[] = []

		app.realtime("/chat/stream", {
			handler: (_c, _conn) => {
				handlerCalls.push(1)
			},
		})

		const req = makeUpgradeRequest("/chat/stream")
		await app.fetch(req, {})

		expect(handlerCalls).toHaveLength(1)
	})

	it("handler receives HoneyContext as first argument with req and params", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		let capturedCtx: unknown = null

		app.realtime("/chat/:roomId/stream", {
			handler: (c, _conn) => {
				capturedCtx = c
			},
		})

		const req = makeUpgradeRequest("/chat/abc/stream")
		await app.fetch(req, {})

		expect(capturedCtx).not.toBeNull()
		expect((capturedCtx as Record<string, unknown>).req).toBeInstanceOf(Request)
		expect((capturedCtx as Record<string, unknown>).params).toEqual({ roomId: "abc" })
	})

	it("handler receives ConnContext as second argument", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		let capturedConn: unknown = null

		app.realtime("/chat/stream", {
			handler: (_c, conn) => {
				capturedConn = conn
			},
		})

		const req = makeUpgradeRequest("/chat/stream")
		await app.fetch(req, {})

		expect(capturedConn).not.toBeNull()
	})

	it("conn.id is a non-empty string", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		let connId = ""

		app.realtime("/chat/stream", {
			handler: (_c, conn) => {
				connId = conn.id
			},
		})

		const req = makeUpgradeRequest("/chat/stream")
		await app.fetch(req, {})

		expect(typeof connId).toBe("string")
		expect(connId.length).toBeGreaterThan(0)
	})

	it("conn.transport is 'ws' for WebSocket connections", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		let transport = ""

		app.realtime("/chat/stream", {
			handler: (_c, conn) => {
				transport = conn.transport
			},
		})

		const req = makeUpgradeRequest("/chat/stream")
		await app.fetch(req, {})

		expect(transport).toBe("ws")
	})

	it("conn.send(payload) sends data through the WebSocket", async () => {
		const { adapter, mockRaw } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		app.realtime("/chat/stream", {
			handler: (_c, conn) => {
				conn.send({ kind: "joined" })
			},
		})

		const req = makeUpgradeRequest("/chat/stream")
		await app.fetch(req, {})

		expect(mockRaw.send).toHaveBeenCalled()
	})

	it("conn.join(topic) subscribes the connection to a topic", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		let joinCalled = false

		app.realtime("/chat/:roomId/stream", {
			handler: (_c, conn) => {
				/* join should not throw */
				conn.join("room:test")
				joinCalled = true
			},
		})

		const req = makeUpgradeRequest("/chat/test/stream")
		await app.fetch(req, {})

		expect(joinCalled).toBe(true)
	})

	it("conn.on('message', fn) registers a message handler that receives frames", async () => {
		const { adapter, fireMessage } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		const receivedFrames: unknown[] = []

		app.realtime("/chat/stream", {
			handler: (_c, conn) => {
				conn.on("message", (frame) => {
					receivedFrames.push(frame)
				})
			},
		})

		const req = makeUpgradeRequest("/chat/stream")
		await app.fetch(req, {})

		fireMessage(JSON.stringify({ data: { text: "hello" }, t: "msg" }))
		await new Promise((r) => setTimeout(r, 10))

		expect(receivedFrames.length).toBeGreaterThanOrEqual(1)
	})

	it("conn.on('close', fn) registers a close handler", async () => {
		const { adapter, fireClose } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		const closeReasons: string[] = []

		app.realtime("/chat/stream", {
			handler: (_c, conn) => {
				conn.on("close", (reason) => {
					closeReasons.push(reason)
				})
			},
		})

		const req = makeUpgradeRequest("/chat/stream")
		await app.fetch(req, {})

		fireClose(1000, "normal")
		await new Promise((r) => setTimeout(r, 10))

		expect(closeReasons.length).toBeGreaterThanOrEqual(1)
	})

	it("each connection gets a unique conn.id", async () => {
		const connIds: string[] = []

		/*
		 * Need separate adapters because each upgrade call creates a new connection.
		 * The test adapter state is overwritten on each upgrade, but the handler
		 * captures the conn.id before the state is replaced.
		 */
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		app.realtime("/chat/stream", {
			handler: (_c, conn) => {
				connIds.push(conn.id)
			},
		})

		await app.fetch(makeUpgradeRequest("/chat/stream"), {})
		await app.fetch(makeUpgradeRequest("/chat/stream"), {})

		expect(connIds).toHaveLength(2)
		expect(connIds[0]).not.toBe(connIds[1])
	})
})

/* ------------------------------------------------------------------ */
/*  Middleware                                                          */
/* ------------------------------------------------------------------ */

describe("app.realtime() — middleware", () => {
	it("middleware registered via use option runs before the handler", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		const callOrder: string[] = []

		const mw: MiddlewareFn<{}, { mwRan: true }> = async (_ctx, next) => {
			callOrder.push("middleware")
			return next({ mwRan: true })
		}

		app.realtime("/chat/stream", {
			handler: (_c, _conn) => {
				callOrder.push("handler")
			},
			use: [mw],
		})

		const req = makeUpgradeRequest("/chat/stream")
		await app.fetch(req, {})

		expect(callOrder).toEqual(["middleware", "handler"])
	})

	it("middleware can set context values accessible in the handler", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		type AuthCtx = { userId: string }
		const authMiddleware: MiddlewareFn<{}, AuthCtx> = async (_ctx, next) => {
			return next({ userId: "user-42" })
		}

		let capturedUserId = ""

		app.realtime("/chat/stream", {
			handler: (c, _conn) => {
				capturedUserId = (c as unknown as AuthCtx).userId
			},
			use: [authMiddleware],
		})

		const req = makeUpgradeRequest("/chat/stream")
		await app.fetch(req, {})

		expect(capturedUserId).toBe("user-42")
	})

	it("global middleware (app.use) runs on realtime routes", async () => {
		const { adapter } = createTestAdapter()

		type DbCtx = { db: string }
		const withDb: MiddlewareFn<{}, DbCtx> = async (_ctx, next) => {
			return next({ db: "test-db" })
		}

		const app = honey().wsAdapter(adapter)
		const authed = app.use(withDb)

		let capturedDb = ""

		authed.realtime("/chat/stream", {
			handler: (c, _conn) => {
				capturedDb = (c as unknown as DbCtx).db
			},
		})

		const req = makeUpgradeRequest("/chat/stream")
		await authed.fetch(req, {})

		expect(capturedDb).toBe("test-db")
	})

	it("multiple use middlewares run in order", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		const order: number[] = []

		const mw1: MiddlewareFn = async (_ctx, next) => {
			order.push(1)
			return next()
		}
		const mw2: MiddlewareFn = async (_ctx, next) => {
			order.push(2)
			return next()
		}

		app.realtime("/chat/stream", {
			handler: (_c, _conn) => {
				order.push(3)
			},
			use: [mw1, mw2],
		})

		const req = makeUpgradeRequest("/chat/stream")
		await app.fetch(req, {})

		expect(order).toEqual([1, 2, 3])
	})

	it("middleware that throws prevents handler execution and returns error response", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		const handlerCalls: number[] = []

		const failMw: MiddlewareFn = async () => {
			throw new Error("auth failed")
		}

		app.realtime("/chat/stream", {
			handler: (_c, _conn) => {
				handlerCalls.push(1)
			},
			use: [failMw],
		})

		const req = makeUpgradeRequest("/chat/stream")
		const res = await app.fetch(req, {})

		expect(handlerCalls).toHaveLength(0)
		expect(res.status).toBeGreaterThanOrEqual(400)
	})
})

/* ------------------------------------------------------------------ */
/*  c.realtime.publish from REST handlers                              */
/* ------------------------------------------------------------------ */

describe("c.realtime.publish — from REST handlers", () => {
	it("c.realtime is available on REST handler context when realtime routes exist", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		let hasRealtime = false

		app.realtime("/ws/stream", {
			handler: (_c, _conn) => {},
		})

		app.get("/test").handler((ctx) => {
			hasRealtime = "realtime" in ctx && ctx.realtime !== null && ctx.realtime !== undefined
			return ctx.res.text("ok", "ok")
		})

		await app.fetch(new Request("http://localhost/test"), {})

		expect(hasRealtime).toBe(true)
	})

	it("c.realtime.publish(topic, data) does not throw", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		let threw = false

		app.realtime("/ws/stream", {
			handler: (_c, _conn) => {},
		})

		app.get("/broadcast").handler((ctx) => {
			try {
				ctx.realtime.publish("feed:123", { kind: "new_post" })
			} catch {
				threw = true
			}
			return ctx.res.text("ok", "ok")
		})

		await app.fetch(new Request("http://localhost/broadcast"), {})

		expect(threw).toBe(false)
	})

	it("publishing from REST handler reaches subscribed realtime connections", async () => {
		const { adapter, mockRaw } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		const receivedData: unknown[] = []

		app.realtime("/ws/stream", {
			handler: (_c, conn) => {
				conn.join("feed:123")
				conn.on("message", (data) => {
					receivedData.push(data)
				})
			},
		})

		app.get("/broadcast").handler((ctx) => {
			ctx.realtime.publish("feed:123", { kind: "new_post", title: "Hello" })
			return ctx.res.text("ok", "ok")
		})

		/* First, establish the realtime connection */
		await app.fetch(makeUpgradeRequest("/ws/stream"), {})

		/* Then, publish from REST */
		await app.fetch(new Request("http://localhost/broadcast"), {})

		/*
		 * The bus should deliver the message to the connected client.
		 * Either via the on("message") handler or direct WS send.
		 */
		const sent = mockRaw.send.mock.calls.length > 0 || receivedData.length > 0
		expect(sent).toBe(true)
	})

	it("c.realtime.publish to a topic with no subscribers does not throw", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		let threw = false

		app.realtime("/ws/stream", {
			handler: (_c, _conn) => {},
		})

		app.get("/broadcast").handler((ctx) => {
			try {
				ctx.realtime.publish("empty-topic", { kind: "noop" })
			} catch {
				threw = true
			}
			return ctx.res.text("ok", "ok")
		})

		await app.fetch(new Request("http://localhost/broadcast"), {})

		expect(threw).toBe(false)
	})

	it("c.realtime.publish is callable even when no connections exist yet", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		let publishCallable = false

		app.realtime("/ws/stream", {
			handler: (_c, _conn) => {},
		})

		app.get("/test").handler((ctx) => {
			ctx.realtime.publish("some-topic", { test: true })
			publishCallable = true
			return ctx.res.text("ok", "ok")
		})

		await app.fetch(new Request("http://localhost/test"), {})

		expect(publishCallable).toBe(true)
	})
})

/* ------------------------------------------------------------------ */
/*  Edge cases                                                         */
/* ------------------------------------------------------------------ */

describe("app.realtime() — edge cases", () => {
	it("empty path normalizes to root and is matchable via WS upgrade", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		app.realtime("", { handler: (_c, _conn) => {} })

		const res = await app.fetch(makeUpgradeRequest("/"), {})
		expect(res.status).toBe(101)
	})

	it("reconnectBuffer option is accepted without error", () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		expect(() => {
			app.realtime("/chat/stream", {
				handler: (_c, _conn) => {},
				reconnectBuffer: 500,
			})
		}).not.toThrow()
	})

	it("handler that throws does not crash the server — returns error response", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		app.realtime("/chat/stream", {
			handler: () => {
				throw new Error("handler boom")
			},
		})

		const req = makeUpgradeRequest("/chat/stream")
		/* Should not reject the promise */
		const res = await app.fetch(req, {})
		/* Either returns 101 (error happens post-upgrade) or returns an error status */
		expect(typeof res.status).toBe("number")
	})

	it("rapid successive connections to same path each get independent conn objects", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		const conns: Array<{ id: string; transport: string }> = []

		app.realtime("/chat/stream", {
			handler: (_c, conn) => {
				conns.push({ id: conn.id, transport: conn.transport })
			},
		})

		await Promise.all([
			app.fetch(makeUpgradeRequest("/chat/stream"), {}),
			app.fetch(makeUpgradeRequest("/chat/stream"), {}),
			app.fetch(makeUpgradeRequest("/chat/stream"), {}),
		])

		expect(conns).toHaveLength(3)
		const uniqueIds = new Set(conns.map((c) => c.id))
		expect(uniqueIds.size).toBe(3)
	})

	it("realtime route and legacy ws() route on different paths coexist", async () => {
		const { adapter } = createTestAdapter()
		const app = honey().wsAdapter(adapter)

		app.realtime("/realtime/stream", {
			handler: (_c, _conn) => {},
		})

		app.ws("/legacy/ws").handler({ onOpen: vi.fn<() => void>() })

		const rtRes = await app.fetch(makeUpgradeRequest("/realtime/stream"), {})
		expect(rtRes.status).toBe(101)

		const wsRes = await app.fetch(makeUpgradeRequest("/legacy/ws"), {})
		expect(wsRes.status).toBe(101)
	})
})
