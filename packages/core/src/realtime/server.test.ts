import { describe, expect, it, vi } from "vitest"
import { WSContextImpl } from "../ws/contract.ts"
import { createBus, type RealtimeBus } from "./bus.ts"
import type { ConnContext, RealtimeOptions } from "./route.ts"
import { resolveRealtimeConfig } from "./route.ts"
import { createRealtimePublisher, createRealtimeSession, topicKey } from "./server.ts"

type Raw = {
	bufferedAmount: number
	close: ReturnType<typeof vi.fn<(code?: number, reason?: string) => void>>
	readyState: number
	send: ReturnType<typeof vi.fn<(data: unknown) => void>>
}

/** Every task the session's lane holds has run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

/** One session over a recording socket; `open()` attaches it as an adapter's onOpen would. */
function connect(options: Partial<RealtimeOptions> = {}, extra: { bus?: RealtimeBus; userId?: string } = {}) {
	const config = resolveRealtimeConfig("/rt", { bus: extra.bus, handler: () => {}, ...options })
	const log = { error: vi.fn<(fields: Record<string, unknown>, msg?: string) => void>() }
	const ctx = { tag: "ctx" }
	const session = createRealtimeSession({ config, ctx, log, userId: extra.userId ?? null })
	const raw: Raw = { bufferedAmount: 0, close: vi.fn(), readyState: 1, send: vi.fn() }
	const ws = new WSContextImpl(raw)
	return {
		config,
		ctx,
		log,
		open: () => session.attach(ws),
		raw,
		sent: () => raw.send.mock.calls.map((call) => JSON.parse(call[0] as string) as unknown),
		session,
		ws,
	}
}

describe("createRealtimeSession: the connection", () => {
	// v0: 3c09b6fed6
	// v0: 4ea6e23e9c
	// v0: 0309216a8c
	// v0: fcb17714b8
	it("runs the handler once with the request ctx and a frozen ConnContext of its own, state included", async () => {
		const seen: [unknown, ConnContext][] = []
		const handler = (ctx: unknown, conn: ConnContext) => void seen.push([ctx, conn])
		const a = connect({ handler }, { userId: "u1" })
		const b = connect({ handler })
		a.open()
		a.open()
		b.open()
		await flush()
		const [[ctx, conn], [, other]] = seen as [[unknown, ConnContext], [unknown, ConnContext]]
		expect([seen.length, ctx, conn.userId, other.userId, conn.transport, conn.closed, conn.state]).toEqual([
			2,
			a.ctx,
			"u1",
			null,
			"ws",
			false,
			{},
		])
		conn.state.n = 1
		expect([conn.id, conn.id === other.id, Object.isFrozen(conn), conn.state, other.state]).toEqual([
			expect.stringMatching(/./),
			false,
			true,
			{ n: 1 },
			{},
		])
	})

	it.each([
		["a handler that is not a function", "message", 1, "conn.on: handler must be a function"],
		["an unknown event", "open", () => {}, 'conn.on: unknown event "open"'],
	])("conn.on refuses %s", async (_name, event, fn, message) => {
		let conn!: ConnContext
		const c = connect({ handler: (_ctx, x) => void (conn = x) })
		c.open()
		await flush()
		expect(() => (conn.on as (e: string, f: unknown) => void)(event, fn)).toThrow(message)
	})
})

describe("createRealtimeSession: wire format, one JSON text per frame", () => {
	// v0: 192a14c256
	// v0: b79e1577ea
	it("send() always emits JSON, strings included", async () => {
		const c = connect({
			handler: (_ctx, conn) => {
				conn.send("hi")
				conn.send(42)
				conn.send({ a: [1] })
			},
		})
		c.open()
		await flush()
		expect(c.raw.send.mock.calls.map((call) => call[0])).toEqual(['"hi"', "42", '{"a":[1]}'])
	})

	// v0: 148e425df7
	it("send() of a value JSON cannot represent throws into the handler, and onError hears it", async () => {
		const errors: unknown[] = []
		const c = connect({ handler: (_ctx, conn) => conn.send(undefined), onError: (error) => void errors.push(error) })
		c.open()
		await flush()
		expect([errors, c.raw.close.mock.calls]).toEqual([
			[new TypeError("realtime payload is not JSON-serializable (got undefined)")],
			[[1011, "internal error"]],
		])
	})

	// v0: 8a566b13ec
	// v0: b6373871b8
	// v0: 6b5f30fb2e
	it("an inbound frame is the payload itself; non-JSON and binary frames are dropped", async () => {
		const got: unknown[] = []
		const c = connect({ handler: (_ctx, conn) => conn.on("message", (p) => void got.push(p)) })
		c.open()
		for (const frame of ['{"text":"hello"}', "not json", new ArrayBuffer(4), '"str"']) c.session.message(frame)
		await flush()
		expect(got).toEqual([{ text: "hello" }, "str"])
	})

	// v0: 1d6437150f
	it("closes with 1009 on a frame over maxFrameBytes, and nothing after it is delivered", async () => {
		const got: unknown[] = []
		const c = connect({
			handler: (_ctx, conn) => conn.on("message", (p) => void got.push(p)),
			limits: { maxFrameBytes: 16 },
		})
		c.open()
		c.session.message(JSON.stringify("x".repeat(64)))
		c.session.message("1")
		await flush()
		expect([c.raw.close.mock.calls, got]).toEqual([[[1009, "frame too large"]], []])
	})
})

describe("createRealtimeSession: a failing message handler (H1)", () => {
	// v0: 8d05813bcc
	it("an async message handler that rejects goes to onError; the connection keeps working", async () => {
		const errors: unknown[] = []
		const seen: unknown[] = []
		const c = connect({
			handler: (_ctx, conn) =>
				conn.on("message", async (p) => {
					seen.push(p)
					if (p === 1) throw new Error("boom")
				}),
			onError: (error, conn) => void errors.push([error, conn.id]),
		})
		c.open()
		c.session.message("1")
		c.session.message("2")
		await flush()
		expect([seen, errors, c.raw.close.mock.calls]).toEqual([[1, 2], [[new Error("boom"), expect.any(String)]], []])
	})

	// v0: 6bc894be1d
	it("a sync throw in a message handler is logged with its phase, not swallowed as a malformed frame", async () => {
		const c = connect({ handler: (_ctx, conn) => conn.on("message", (p) => void (p as { text: string }).text.trim()) })
		c.open()
		c.session.message('{"data":1}')
		await flush()
		const [[fields, msg]] = c.log.error.mock.calls as [[Record<string, unknown>, string]]
		expect([fields, msg]).toEqual([
			{
				connId: expect.any(String),
				err: expect.any(TypeError),
				namespace: "/rt",
				phase: "realtime message",
				route: "/rt",
			},
			"callback failed",
		])
	})
})

describe("createRealtimeSession: a failing connect or close handler (H1)", () => {
	// v0: 610b728d3d
	// v0: 53294b81e0
	it.each([
		["rejecting", async () => Promise.reject(new Error("db down"))],
		[
			"sync-throwing",
			() => {
				throw new Error("db down")
			},
		],
	])("a %s connect handler closes with 1011 and is logged; attach never throws", async (_name, handler) => {
		const c = connect({ handler })
		expect(c.open()).toBeUndefined()
		await flush()
		expect([c.raw.close.mock.calls, c.log.error.mock.calls[0]?.[0]]).toEqual([
			[[1011, "internal error"]],
			expect.objectContaining({ err: new Error("db down"), phase: "realtime handler" }),
		])
	})

	// v0: 79294957b8
	// v0: 0b9b95a755
	it("a throwing close handler still unsubscribes the connection (no ghost in presence)", async () => {
		const bus = createBus()
		const c = connect(
			{
				handler: (_ctx, conn) => {
					conn.join("room")
					conn.on("close", () => {
						throw new Error("close boom")
					})
				},
			},
			{ bus },
		)
		c.open()
		await flush()
		const before = bus.presence(topicKey("/rt", "room")).length
		c.session.close("bye")
		await flush()
		createRealtimePublisher(bus, "/rt").publish("room", { hi: 1 })
		expect([
			before,
			bus.presence(topicKey("/rt", "room")),
			c.raw.send.mock.calls,
			c.log.error.mock.calls.length,
		]).toEqual([1, [], [], 1])
	})
})

describe("createRealtimeSession: a failing onError, a socket error (H1)", () => {
	// v0: 75257277d0
	// v0: 3d911353d4
	it.each([
		[
			"throws",
			() => {
				throw new Error("onError itself")
			},
		],
		["rejects", async () => Promise.reject(new Error("onError itself"))],
	])("an onError that %s is logged once per failure and never handed its own error", async (_name, fail) => {
		const onError = vi.fn(fail)
		const c = connect({
			handler: (_ctx, conn) =>
				conn.on("message", () => {
					throw new Error("handler")
				}),
			onError,
		})
		c.open()
		c.session.message("1")
		await flush()
		c.session.message("2")
		await flush()
		expect([onError.mock.calls.length, c.log.error.mock.calls.map(([fields]) => [fields.phase, fields.err])]).toEqual([
			2,
			[
				["onError", new Error("onError itself")],
				["onError", new Error("onError itself")],
			],
		])
	})

	it("a socket error is logged, never handed to the route's onError", () => {
		const onError = vi.fn()
		const c = connect({ onError })
		c.session.error(new Error("reset"))
		expect([onError.mock.calls, c.log.error.mock.calls[0]?.[0]]).toEqual([
			[],
			expect.objectContaining({ err: new Error("reset"), phase: "realtime socket error" }),
		])
	})
})

describe("createRealtimeSession: ordered callbacks and early frames", () => {
	// v0: ecbd69cfc9
	it("runs an async connect handler to completion before any message", async () => {
		const order: string[] = []
		const gate = deferred()
		const c = connect({
			handler: async (_ctx, conn) => {
				conn.on("message", (p) => void order.push(`msg:${String(p)}`))
				await gate.promise
				order.push("open-done")
			},
		})
		c.open()
		c.session.message("1")
		await flush()
		const early = [...order]
		gate.resolve()
		await flush()
		expect([early, order]).toEqual([[], ["open-done", "msg:1"]])
	})

	// v0: 379d685e96
	it("holds frames that arrive before conn.on('message') and delivers them in order", async () => {
		const got: unknown[] = []
		let attach!: () => void
		const c = connect({ handler: (_ctx, conn) => void (attach = () => conn.on("message", (p) => void got.push(p))) })
		c.open()
		await flush()
		c.session.message("1")
		c.session.message("2")
		await flush()
		const before = [...got]
		attach()
		c.session.message("3")
		await flush()
		expect([before, got]).toEqual([[], [1, 2, 3]])
	})

	// v0: 0f618f61ee
	it("a frame that beat the open is delivered after the handler, before frames that arrive later", async () => {
		const got: unknown[] = []
		const c = connect({ handler: (_ctx, conn) => conn.on("message", (p) => void got.push(`msg:${String(p)}`)) })
		c.session.message("1")
		c.open()
		c.session.message("2")
		await flush()
		expect(got).toEqual(["msg:1", "msg:2"])
	})
})

describe("createRealtimeSession: the pending cap", () => {
	it("before the open, a frame over maxFrameBytes or past maxPendingFrames is dropped; nothing is closed", async () => {
		const got: unknown[] = []
		const c = connect({
			handler: (_ctx, conn) => conn.on("message", (p) => void got.push(p)),
			limits: { maxFrameBytes: 4, maxPendingFrames: 2 },
		})
		for (const frame of ["1", '"too long"', "2", "3"]) c.session.message(frame)
		c.open()
		await flush()
		expect([got, c.raw.close.mock.calls]).toEqual([[1, 2], []])
	})

	// v0: e5ac56bf9b
	it("closes with 1008 once too many frames wait for a slow handler", async () => {
		const gate = deferred()
		const c = connect({
			handler: (_ctx, conn) => conn.on("message", () => gate.promise),
			limits: { maxPendingFrames: 3 },
		})
		c.open()
		await flush()
		for (let i = 0; i < 6; i++) c.session.message(String(i))
		expect(c.raw.close.mock.calls).toEqual([[1008, "too many pending frames"]])
		gate.resolve()
	})
})

describe("createRealtimeSession: the close", () => {
	// v0: c27f236915
	// v0: fe3e2e0354
	it("runs the close handler after queued messages, once, with the reason or 'normal'", async () => {
		const order: string[] = []
		const gate = deferred()
		const handler = (_ctx: unknown, conn: ConnContext) => {
			conn.on("message", async (p) => {
				await gate.promise
				order.push(`msg:${String(p)}`)
			})
			conn.on("close", (reason) => void order.push(`close:${reason}`))
		}
		const a = connect({ handler })
		const b = connect({ handler })
		a.open()
		b.open()
		a.session.message("1")
		a.session.close("bye")
		a.session.close("again")
		b.session.close("")
		gate.resolve()
		await flush()
		expect(order).toEqual(["close:normal", "msg:1", "close:bye"])
	})

	it("frames still waiting for a message handler at the close are dropped, never delivered later", async () => {
		const got: unknown[] = []
		let conn!: ConnContext
		const c = connect({ handler: (_ctx, x) => void (conn = x) })
		c.open()
		await flush()
		c.session.message("1")
		c.session.close("bye")
		await flush()
		conn.on("message", (p) => void got.push(p))
		await flush()
		expect(got).toEqual([])
	})
})

describe("createRealtimeSession: topics and limits", () => {
	// v0: 11d0afb818
	// v0: 5fde0a0c29
	it("join subscribes within the namespace, leave drops it; join throws past maxTopics, re-joining a held topic is fine", async () => {
		const bus = createBus()
		const outcomes: unknown[] = []
		const c = connect(
			{
				handler: (_ctx, conn) => {
					conn.join("a")
					conn.join("b")
					conn.join("a")
					try {
						conn.join("c")
					} catch (error) {
						outcomes.push(error)
					}
					conn.leave("b")
				},
				limits: { maxTopics: 2 },
			},
			{ bus },
		)
		c.open()
		await flush()
		const [id] = bus.presence(topicKey("/rt", "a")) as [string]
		expect([outcomes, bus.isSubscribed(id, topicKey("/rt", "a")), bus.topicCount(id)]).toEqual([
			[new RangeError("realtime: a connection may join at most 2 topics")],
			true,
			1,
		])
	})

	// v0: 0185cb9bc7
	// v0: 638057ae78
	it.each([
		["close", [[1013, "slow consumer"]], []],
		["drop", [], ['"fast"']],
	] as const)("a slow consumer under slowConsumer %s", async (slowConsumer, closes, sends) => {
		let conn!: ConnContext
		const c = connect({ handler: (_ctx, x) => void (conn = x), limits: { maxBufferedBytes: 10, slowConsumer } })
		c.open()
		await flush()
		c.raw.bufferedAmount = 11
		conn.send("slow")
		c.raw.bufferedAmount = 0
		conn.send("fast")
		expect([c.raw.close.mock.calls, c.raw.send.mock.calls.map((call) => call[0])]).toEqual([closes, sends])
	})
})

describe("createRealtimeSession: the socket", () => {
	it("a socket that reports no bufferedAmount is never a slow consumer", async () => {
		const config = resolveRealtimeConfig("/rt", {
			handler: (_ctx, conn) => conn.send(1),
			limits: { maxBufferedBytes: 1 },
		})
		const sent: unknown[] = []
		const session = createRealtimeSession({ config, ctx: {}, log: null, userId: null })
		session.attach({ close: () => {}, raw: null, readyState: 1, send: (data) => void sent.push(data) })
		await flush()
		expect(sent).toEqual(["1"])
	})

	it("a session closed before its socket opened never attaches it", async () => {
		const handler = vi.fn()
		const c = connect({ handler })
		c.session.close("")
		c.open()
		await flush()
		expect([handler.mock.calls, c.raw.send.mock.calls]).toEqual([[], []])
	})

	it("a socket that throws on send or close is logged, and the connection carries on", async () => {
		let conn!: ConnContext
		const c = connect({ handler: (_ctx, x) => void (conn = x) })
		c.open()
		await flush()
		c.raw.send.mockImplementation(() => {
			throw new Error("gone")
		})
		c.raw.close.mockImplementation(() => {
			throw new Error("gone")
		})
		conn.send(1)
		conn.close()
		expect(c.log.error.mock.calls.map(([fields]) => fields.phase)).toEqual(["realtime send", "realtime close"])
	})
})
