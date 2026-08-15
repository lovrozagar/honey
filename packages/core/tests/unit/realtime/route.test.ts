import { describe, expect, expectTypeOf, it, vi } from "vitest"
import type { ConnContext, RealtimeRouteHandler, RealtimeRouteOpts } from "../../../src/realtime/route.ts"
import { createConnContext } from "../../../src/realtime/route.ts"

function makeBus() {
	return {
		publish: vi.fn<(topic: string, data: unknown) => void>(),
		subscribe: vi.fn<(connId: string, topic: string) => void>(),
		unsubscribe: vi.fn<(connId: string, topic: string) => void>(),
		unsubscribeAll: vi.fn<(connId: string) => void>(),
	}
}

function makeConnOpts(overrides?: Partial<Parameters<typeof createConnContext>[0]>) {
	return {
		bus: makeBus(),
		closeFn: vi.fn<(reason?: string) => void>(),
		id: "conn-1",
		sendFn: vi.fn<(payload: unknown) => void>(),
		transport: "ws" as const,
		userId: "user-42",
		...overrides,
	}
}

/* ------------------------------------------------------------------ */
/*  ConnContext — basic properties                                     */
/* ------------------------------------------------------------------ */

describe("ConnContext — basic properties", () => {
	it("id is set from opts", () => {
		const conn = createConnContext(makeConnOpts({ id: "abc-123" }))
		expect(conn.id).toBe("abc-123")
	})

	it("userId is set from opts when provided as string", () => {
		const conn = createConnContext(makeConnOpts({ userId: "user-99" }))
		expect(conn.userId).toBe("user-99")
	})

	it("userId is null when not provided", () => {
		const conn = createConnContext(makeConnOpts({ userId: null }))
		expect(conn.userId).toBeNull()
	})

	it("transport is set from opts", () => {
		const conn = createConnContext(makeConnOpts({ transport: "sse" }))
		expect(conn.transport).toBe("sse")
	})

	it("state starts as empty object", () => {
		const conn = createConnContext(makeConnOpts())
		expect(conn.state).toEqual({})
	})

	it("state is mutable — app code can set arbitrary keys", () => {
		const conn = createConnContext(makeConnOpts())
		conn.state.counter = 0
		conn.state.label = "test"
		expect(conn.state.counter).toBe(0)
		expect(conn.state.label).toBe("test")
	})
})

/* ------------------------------------------------------------------ */
/*  ConnContext — topic management                                     */
/* ------------------------------------------------------------------ */

describe("ConnContext — topic management", () => {
	it("join(topic) calls bus.subscribe(id, topic)", () => {
		const opts = makeConnOpts({ id: "conn-7" })
		const conn = createConnContext(opts)
		conn.join("chat:lobby")
		expect(opts.bus.subscribe).toHaveBeenCalledWith("conn-7", "chat:lobby")
	})

	it("leave(topic) calls bus.unsubscribe(id, topic)", () => {
		const opts = makeConnOpts({ id: "conn-7" })
		const conn = createConnContext(opts)
		conn.leave("chat:lobby")
		expect(opts.bus.unsubscribe).toHaveBeenCalledWith("conn-7", "chat:lobby")
	})

	it("multiple joins to different topics all register", () => {
		const opts = makeConnOpts({ id: "conn-7" })
		const conn = createConnContext(opts)
		conn.join("topic-a")
		conn.join("topic-b")
		conn.join("topic-c")
		expect(opts.bus.subscribe).toHaveBeenCalledTimes(3)
		expect(opts.bus.subscribe).toHaveBeenCalledWith("conn-7", "topic-a")
		expect(opts.bus.subscribe).toHaveBeenCalledWith("conn-7", "topic-b")
		expect(opts.bus.subscribe).toHaveBeenCalledWith("conn-7", "topic-c")
	})
})

/* ------------------------------------------------------------------ */
/*  ConnContext — messaging                                            */
/* ------------------------------------------------------------------ */

describe("ConnContext — messaging", () => {
	it("send(payload) calls the provided sendFn", () => {
		const opts = makeConnOpts()
		const conn = createConnContext(opts)
		conn.send("hello")
		expect(opts.sendFn).toHaveBeenCalledOnce()
	})

	it("send(payload) passes the payload through unchanged", () => {
		const opts = makeConnOpts()
		const conn = createConnContext(opts)
		const payload = { complex: [1, 2, 3], nested: true }
		conn.send(payload)
		expect(opts.sendFn).toHaveBeenCalledWith(payload)
	})

	it("publish(topic, payload) calls bus.publish(topic, payload)", () => {
		const opts = makeConnOpts()
		const conn = createConnContext(opts)
		const data = { msg: "hi" }
		conn.publish("chat:room-1", data)
		expect(opts.bus.publish).toHaveBeenCalledWith("chat:room-1", data)
	})
})

/* ------------------------------------------------------------------ */
/*  ConnContext — lifecycle                                             */
/* ------------------------------------------------------------------ */

describe("ConnContext — lifecycle", () => {
	it("close() calls closeFn with no reason", () => {
		const opts = makeConnOpts()
		const conn = createConnContext(opts)
		conn.close()
		expect(opts.closeFn).toHaveBeenCalledWith(undefined)
	})

	it("close('kicked') calls closeFn with the reason string", () => {
		const opts = makeConnOpts()
		const conn = createConnContext(opts)
		conn.close("kicked")
		expect(opts.closeFn).toHaveBeenCalledWith("kicked")
	})

	it("close() calls bus.unsubscribeAll(id) to clean up subscriptions", () => {
		const opts = makeConnOpts({ id: "conn-cleanup" })
		const conn = createConnContext(opts)
		conn.join("topic-1")
		conn.join("topic-2")
		conn.close()
		expect(opts.bus.unsubscribeAll).toHaveBeenCalledWith("conn-cleanup")
	})
})

/* ------------------------------------------------------------------ */
/*  ConnContext — event handlers                                        */
/* ------------------------------------------------------------------ */

describe("ConnContext — event handlers", () => {
	it("on('message', handler) registers a message handler", () => {
		const conn = createConnContext(makeConnOpts())
		const handler = vi.fn<(payload: unknown) => void>()
		conn.on("message", handler)
		/* Registration itself should not throw */
		expect(handler).not.toHaveBeenCalled()
	})

	it("on('close', handler) registers a close handler", () => {
		const conn = createConnContext(makeConnOpts())
		const handler = vi.fn<(reason: string) => void>()
		conn.on("close", handler)
		expect(handler).not.toHaveBeenCalled()
	})

	it("registered message handler can be retrieved for protocol layer", () => {
		const conn = createConnContext(makeConnOpts())
		const handler = vi.fn<(payload: unknown) => void>()
		conn.on("message", handler)

		/*
		 * The protocol layer needs to invoke the registered handler when a
		 * client frame arrives. We test by checking the internal handlers
		 * object — exposed via a known shape on ConnContext for integration.
		 * If createConnContext returns the handlers as part of its shape,
		 * this will pass once implemented.
		 */
		expect((conn as Record<string, unknown>)._handlers).toBeDefined()
		const handlers = (conn as Record<string, unknown>)._handlers as Record<string, unknown>
		expect(handlers.message).toBe(handler)
	})

	it("registered close handler can be retrieved for protocol layer", () => {
		const conn = createConnContext(makeConnOpts())
		const handler = vi.fn<(reason: string) => void>()
		conn.on("close", handler)

		expect((conn as Record<string, unknown>)._handlers).toBeDefined()
		const handlers = (conn as Record<string, unknown>)._handlers as Record<string, unknown>
		expect(handlers.close).toBe(handler)
	})

	it("replacing a handler via on() replaces the previous one", () => {
		const conn = createConnContext(makeConnOpts())
		const first = vi.fn<(payload: unknown) => void>()
		const second = vi.fn<(payload: unknown) => void>()
		conn.on("message", first)
		conn.on("message", second)

		const handlers = (conn as Record<string, unknown>)._handlers as Record<string, unknown>
		expect(handlers.message).toBe(second)
		expect(handlers.message).not.toBe(first)
	})
})

/* ------------------------------------------------------------------ */
/*  ConnContext — state persistence                                     */
/* ------------------------------------------------------------------ */

describe("ConnContext — state persistence", () => {
	it("state object persists across reads", () => {
		const conn = createConnContext(makeConnOpts())
		const ref1 = conn.state
		const ref2 = conn.state
		expect(ref1).toBe(ref2)
	})

	it("state modifications are visible on subsequent reads", () => {
		const conn = createConnContext(makeConnOpts())
		conn.state.count = 1
		conn.state.count = (conn.state.count as number) + 1
		expect(conn.state.count).toBe(2)
	})

	it("state is per-connection — two ConnContexts have independent state", () => {
		const connA = createConnContext(makeConnOpts({ id: "a" }))
		const connB = createConnContext(makeConnOpts({ id: "b" }))
		connA.state.x = "from-a"
		connB.state.x = "from-b"
		expect(connA.state.x).toBe("from-a")
		expect(connB.state.x).toBe("from-b")
	})
})

/* ------------------------------------------------------------------ */
/*  ConnContext — edge cases                                            */
/* ------------------------------------------------------------------ */

describe("ConnContext — edge cases", () => {
	it("id is readonly — cannot be reassigned", () => {
		const conn = createConnContext(makeConnOpts({ id: "immutable-id" }))
		expect(() => {
			;(conn as Record<string, unknown>).id = "new-id"
		}).toThrow()
	})

	it("userId is readonly — cannot be reassigned", () => {
		const conn = createConnContext(makeConnOpts({ userId: "u1" }))
		expect(() => {
			;(conn as Record<string, unknown>).userId = "u2"
		}).toThrow()
	})

	it("transport is readonly — cannot be reassigned", () => {
		const conn = createConnContext(makeConnOpts({ transport: "ws" }))
		expect(() => {
			;(conn as Record<string, unknown>).transport = "sse"
		}).toThrow()
	})

	it("send passes through falsy values without modification", () => {
		const opts = makeConnOpts()
		const conn = createConnContext(opts)
		conn.send(null)
		conn.send(0)
		conn.send("")
		conn.send(false)
		expect(opts.sendFn).toHaveBeenNthCalledWith(1, null)
		expect(opts.sendFn).toHaveBeenNthCalledWith(2, 0)
		expect(opts.sendFn).toHaveBeenNthCalledWith(3, "")
		expect(opts.sendFn).toHaveBeenNthCalledWith(4, false)
	})

	it("close() calls unsubscribeAll before closeFn", () => {
		const callOrder: string[] = []
		const bus = makeBus()
		bus.unsubscribeAll.mockImplementation(() => callOrder.push("unsubscribeAll"))
		const closeFn = vi.fn<(reason?: string) => void>(() => callOrder.push("closeFn"))
		const sendFn = vi.fn<(payload: unknown) => void>()
		const conn = createConnContext({ bus, closeFn, id: "c", sendFn, transport: "ws", userId: null })
		conn.close()
		expect(callOrder).toEqual(["unsubscribeAll", "closeFn"])
	})

	it("join with empty string topic still delegates to bus", () => {
		const opts = makeConnOpts({ id: "c" })
		const conn = createConnContext(opts)
		conn.join("")
		expect(opts.bus.subscribe).toHaveBeenCalledWith("c", "")
	})

	it("publish with undefined payload passes it through", () => {
		const opts = makeConnOpts()
		const conn = createConnContext(opts)
		conn.publish("t", undefined)
		expect(opts.bus.publish).toHaveBeenCalledWith("t", undefined)
	})

	it("transport accepts longpoll value", () => {
		const conn = createConnContext(makeConnOpts({ transport: "longpoll" }))
		expect(conn.transport).toBe("longpoll")
	})
})

/* ------------------------------------------------------------------ */
/*  Type contracts                                                      */
/* ------------------------------------------------------------------ */

describe("ConnContext — type contracts", () => {
	it("ConnContext.id is typed as string", () => {
		expectTypeOf<ConnContext["id"]>().toBeString()
	})

	it("ConnContext.userId is typed as string | null", () => {
		expectTypeOf<ConnContext["userId"]>().toEqualTypeOf<string | null>()
	})

	it("ConnContext.transport is a union of ws | sse | longpoll", () => {
		expectTypeOf<ConnContext["transport"]>().toEqualTypeOf<"ws" | "sse" | "longpoll">()
	})

	it("ConnContext.state is Record<string, unknown>", () => {
		expectTypeOf<ConnContext["state"]>().toEqualTypeOf<Record<string, unknown>>()
	})

	it("ConnContext.send accepts unknown payload", () => {
		expectTypeOf<ConnContext["send"]>().toEqualTypeOf<(payload: unknown) => void>()
	})

	it("ConnContext.publish accepts topic string and unknown payload", () => {
		expectTypeOf<ConnContext["publish"]>().toEqualTypeOf<(topic: string, payload: unknown) => void>()
	})

	it("ConnContext.close accepts optional reason string", () => {
		expectTypeOf<ConnContext["close"]>().toEqualTypeOf<(reason?: string) => void>()
	})

	it("ConnContext.join accepts a topic string", () => {
		expectTypeOf<ConnContext["join"]>().toEqualTypeOf<(topic: string) => void>()
	})

	it("ConnContext.leave accepts a topic string", () => {
		expectTypeOf<ConnContext["leave"]>().toEqualTypeOf<(topic: string) => void>()
	})

	it("ConnContext.on overloads accept message and close events", () => {
		expectTypeOf<ConnContext["on"]>().toBeFunction()
	})
})

/* ------------------------------------------------------------------ */
/*  RealtimeRouteOpts — type contracts                                  */
/* ------------------------------------------------------------------ */

describe("RealtimeRouteOpts — type contracts", () => {
	it("handler is required", () => {
		expectTypeOf<RealtimeRouteOpts["handler"]>().toBeFunction()
		expectTypeOf<RealtimeRouteOpts["handler"]>().not.toBeNullable()
	})

	it("use is optional array of middleware functions", () => {
		expectTypeOf<RealtimeRouteOpts>().toHaveProperty("use")
		type UseType = RealtimeRouteOpts["use"]
		expectTypeOf<NonNullable<UseType>>().toBeArray()
	})

	it("reconnectBuffer is optional number", () => {
		expectTypeOf<RealtimeRouteOpts>().toHaveProperty("reconnectBuffer")
		type BufferType = RealtimeRouteOpts["reconnectBuffer"]
		expectTypeOf<NonNullable<BufferType>>().toBeNumber()
	})
})

/* ------------------------------------------------------------------ */
/*  RealtimeRouteHandler — type contracts                               */
/* ------------------------------------------------------------------ */

describe("RealtimeRouteHandler — type contracts", () => {
	it("handler property matches RealtimeRouteOpts handler", () => {
		expectTypeOf<RealtimeRouteHandler["handler"]>().toEqualTypeOf<RealtimeRouteOpts["handler"]>()
	})

	it("path is a string", () => {
		expectTypeOf<RealtimeRouteHandler["path"]>().toBeString()
	})

	it("reconnectBuffer is a number (resolved default)", () => {
		expectTypeOf<RealtimeRouteHandler["reconnectBuffer"]>().toBeNumber()
	})
})
