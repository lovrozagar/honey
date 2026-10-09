import { describe, expect, it, vi } from "vitest"
import { HoneyError } from "../../../src/error.ts"
import { honey } from "../../../src/index.ts"
import { truncateUtf8 } from "../../../src/realtime/route.ts"
import type { ConnContext } from "../../../src/realtime/route.ts"
import type { WSAdapter, WSHandler } from "../../../src/ws/cloudflare.ts"
import { WSContextImpl } from "../../../src/ws/cloudflare.ts"
import "../../../src/realtime/register.ts"

/* Node's Response rejects 101; tests fake it the way the CF adapter's Response allows it. */
function make101(): Response {
	const res = new Response(null, { status: 200 })
	Object.defineProperty(res, "status", { value: 101 })
	return res
}

type Raw = {
	bufferedAmount: number
	close: ReturnType<typeof vi.fn<(code?: number, reason?: string) => void>>
	readyState: number
	send: ReturnType<typeof vi.fn<(data: unknown) => void>>
}

type Socket = {
	close(code: number, reason: string): void
	message(data: ArrayBuffer | string): void
	raw: Raw
	/** frames the server sent, parsed */
	sent(): unknown[]
}

/** WS adapter that records every connection and lets a test drive its events. */
function testAdapter(opts: { openOnUpgrade?: boolean } = {}) {
	const sockets: Socket[] = []
	const adapter: WSAdapter = {
		upgrade(_req, _env, handler: WSHandler<unknown>) {
			const raw: Raw = {
				bufferedAmount: 0,
				close: vi.fn<(code?: number, reason?: string) => void>(),
				readyState: 1,
				send: vi.fn<(data: unknown) => void>(),
			}
			const ws = new WSContextImpl(raw)
			let closed = false
			const socket: Socket = {
				close(code, reason) {
					if (closed) return
					closed = true
					raw.readyState = 3
					handler.onClose?.(undefined, ws, code, reason)
				},
				message(data) {
					handler.onMessage?.(undefined, ws, data)
				},
				raw,
				sent: () => raw.send.mock.calls.map((c) => JSON.parse(c[0] as string)),
			}
			/* the server closing the socket echoes a close event, like a real runtime */
			raw.close.mockImplementation((code?: number, reason?: string) => socket.close(code ?? 1005, reason ?? ""))
			sockets.push(socket)
			if (opts.openOnUpgrade !== false) handler.onOpen?.(undefined, ws)
			return { response: make101(), socket: ws }
		},
	}
	return { adapter, sockets }
}

function upgrade(path: string): Request {
	return new Request(`http://localhost${path}`, { headers: { connection: "Upgrade", upgrade: "websocket" } })
}

const tick = () => new Promise((r) => setTimeout(r, 5))

function quietLogger() {
	return { error: vi.fn<(obj: Record<string, unknown>, msg?: string) => void>(), warn: vi.fn() }
}

describe("realtime: every user callback is contained (H1)", () => {
	it("an async message handler that rejects goes to onError; the connection keeps working", async () => {
		const { adapter, sockets } = testAdapter()
		const errors: unknown[] = []
		const seen: unknown[] = []
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: (_c, conn) => {
					conn.on("message", async (p) => {
						seen.push(p)
						if (p === 1) throw new Error("boom")
					})
				},
				onError: (err) => {
					errors.push(err)
				},
			})
		await app.fetch(upgrade("/rt"), {})
		sockets[0]!.message("1")
		sockets[0]!.message("2")
		await tick()
		expect(seen).toEqual([1, 2])
		expect(errors).toHaveLength(1)
		expect((errors[0] as Error).message).toBe("boom")
		expect(sockets[0]!.raw.close).not.toHaveBeenCalled()
	})

	it("a sync throw in a message handler is reported, not swallowed as a malformed frame", async () => {
		const { adapter, sockets } = testAdapter()
		const log = quietLogger()
		const app = honey()
			.logger(log)
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: (_c, conn) => {
					conn.on("message", (p) => (p as { text: string }).text.trim())
				},
			})
		await app.fetch(upgrade("/rt"), {})
		sockets[0]!.message('{"data":1}')
		await tick()
		expect(log.error).toHaveBeenCalledTimes(1)
		expect(log.error.mock.calls[0]![0]).toMatchObject({ phase: "message", route: "/rt" })
		expect(log.error.mock.calls[0]![0]["err"]).toBeInstanceOf(TypeError)
	})

	it("a rejecting connect handler closes with 1011 and is logged", async () => {
		const { adapter, sockets } = testAdapter()
		const log = quietLogger()
		const app = honey()
			.logger(log)
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: async () => {
					throw new Error("db down")
				},
			})
		const res = await app.fetch(upgrade("/rt"), {})
		expect(res.status).toBe(101)
		await tick()
		expect(sockets[0]!.raw.close).toHaveBeenCalledWith(1011, "internal error")
		expect(log.error.mock.calls[0]![0]).toMatchObject({ phase: "handler" })
	})

	it("a sync throw in the connect handler never escapes the adapter's open callback", async () => {
		const { adapter, sockets } = testAdapter()
		const app = honey()
			.logger(quietLogger())
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: () => {
					throw new Error("sync boom")
				},
			})
		await expect(app.fetch(upgrade("/rt"), {})).resolves.toHaveProperty("status", 101)
		await tick()
		expect(sockets[0]!.raw.close).toHaveBeenCalledWith(1011, "internal error")
	})

	it("a throwing close handler still unsubscribes the connection (no ghost in presence)", async () => {
		const { adapter, sockets } = testAdapter()
		const app = honey()
			.logger(quietLogger())
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: (_c, conn) => {
					conn.join("room")
					conn.on("close", () => {
						throw new Error("close boom")
					})
				},
			})
			.post("/pub")
			.handler((ctx) => {
				ctx.realtime.publish("room", { hi: 1 })
				return ctx.res.json("ok", {})
			})
		await app.fetch(upgrade("/rt"), {})
		await tick()
		sockets[0]!.close(1000, "bye")
		await tick()
		const before = sockets[0]!.raw.send.mock.calls.length
		await app.fetch(new Request("http://localhost/pub", { method: "POST" }), {})
		expect(sockets[0]!.raw.send.mock.calls.length).toBe(before)
	})

	it("an onError that throws is logged once and never re-invoked", async () => {
		const { adapter, sockets } = testAdapter()
		const log = quietLogger()
		let onErrorCalls = 0
		const app = honey()
			.logger(log)
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: (_c, conn) => {
					conn.on("message", () => {
						throw new Error("handler")
					})
				},
				onError: () => {
					onErrorCalls++
					throw new Error("onError itself")
				},
			})
		await app.fetch(upgrade("/rt"), {})
		sockets[0]!.message("1")
		await tick()
		expect(onErrorCalls).toBe(1)
		expect(log.error).toHaveBeenCalledTimes(1)
		expect(log.error.mock.calls[0]![0]).toMatchObject({ phase: "onError" })
		sockets[0]!.message("2")
		await tick()
		expect(onErrorCalls).toBe(2)
	})

	it("a rejecting onError is logged", async () => {
		const { adapter, sockets } = testAdapter()
		const log = quietLogger()
		const app = honey()
			.logger(log)
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: (_c, conn) => {
					conn.on("message", () => {
						throw new Error("handler")
					})
				},
				onError: async () => {
					throw new Error("async onError")
				},
			})
		await app.fetch(upgrade("/rt"), {})
		sockets[0]!.message("1")
		await tick()
		expect(log.error).toHaveBeenCalledTimes(1)
	})
})

describe("realtime: ordered callbacks and early frames", () => {
	it("runs an async connect handler to completion before any message", async () => {
		const { adapter, sockets } = testAdapter()
		const order: string[] = []
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: async (_c, conn) => {
					conn.on("message", (p) => {
						order.push(`msg:${String(p)}`)
					})
					await new Promise((r) => setTimeout(r, 10))
					order.push("open-done")
				},
			})
		await app.fetch(upgrade("/rt"), {})
		sockets[0]!.message("1")
		await new Promise((r) => setTimeout(r, 30))
		expect(order).toEqual(["open-done", "msg:1"])
	})

	it("holds frames that arrive before conn.on('message') and delivers them in order", async () => {
		const { adapter, sockets } = testAdapter()
		const got: unknown[] = []
		let attach: (() => void) | null = null
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: (_c, conn) => {
					attach = () => conn.on("message", (p) => void got.push(p))
				},
			})
		await app.fetch(upgrade("/rt"), {})
		await tick()
		sockets[0]!.message("1")
		sockets[0]!.message("2")
		await tick()
		expect(got).toEqual([])
		attach!()
		sockets[0]!.message("3")
		await tick()
		expect(got).toEqual([1, 2, 3])
	})

	it("closes with 1008 once too many frames wait for a slow handler", async () => {
		const { adapter, sockets } = testAdapter()
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: (_c, conn) => {
					conn.on("message", () => new Promise((r) => setTimeout(r, 50)))
				},
				limits: { maxPendingFrames: 3 },
			})
		await app.fetch(upgrade("/rt"), {})
		await tick()
		for (let i = 0; i < 6; i++) sockets[0]!.message(String(i))
		expect(sockets[0]!.raw.close).toHaveBeenCalledWith(1008, "too many pending frames")
	})

	it("runs the close handler after queued messages", async () => {
		const { adapter, sockets } = testAdapter()
		const order: string[] = []
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: (_c, conn) => {
					conn.on("message", async (p) => {
						await new Promise((r) => setTimeout(r, 5))
						order.push(`msg:${String(p)}`)
					})
					conn.on("close", (reason) => {
						order.push(`close:${reason}`)
					})
				},
			})
		await app.fetch(upgrade("/rt"), {})
		sockets[0]!.message("1")
		sockets[0]!.close(1000, "bye")
		await new Promise((r) => setTimeout(r, 30))
		expect(order).toEqual(["msg:1", "close:bye"])
	})
})

describe("realtime: after close", () => {
	it("join and send are no-ops; an async handler joining late leaves no subscriber", async () => {
		const { adapter, sockets } = testAdapter()
		let captured: ConnContext | null = null
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: async (_c, conn) => {
					captured = conn
					await new Promise((r) => setTimeout(r, 10))
					conn.join("room")
					conn.send({ late: true })
				},
			})
			.post("/pub")
			.handler((ctx) => {
				ctx.realtime.publish("room", { x: 1 })
				return ctx.res.json("ok", {})
			})
		await app.fetch(upgrade("/rt"), {})
		sockets[0]!.close(1001, "gone")
		await new Promise((r) => setTimeout(r, 30))
		expect(captured!.closed).toBe(true)
		await app.fetch(new Request("http://localhost/pub", { method: "POST" }), {})
		expect(sockets[0]!.raw.send).not.toHaveBeenCalled()
	})

	it("publish from a close handler still reaches the others", async () => {
		const { adapter, sockets } = testAdapter()
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: (_c, conn) => {
					conn.join("room")
					conn.on("close", () => conn.publish("room", { left: conn.id }))
				},
			})
		await app.fetch(upgrade("/rt"), {})
		await app.fetch(upgrade("/rt"), {})
		await tick()
		sockets[0]!.close(1000, "")
		await tick()
		expect(sockets[1]!.sent()).toEqual([{ left: expect.any(String) }])
		expect(sockets[0]!.raw.send).not.toHaveBeenCalled()
	})

	it("conn.close() truncates a long reason to 123 UTF-8 bytes instead of throwing", async () => {
		const { adapter, sockets } = testAdapter()
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: (_c, conn) => {
					conn.close("é".repeat(100))
				},
			})
		await app.fetch(upgrade("/rt"), {})
		await tick()
		const reason = sockets[0]!.raw.close.mock.calls[0]![1] as string
		expect(new TextEncoder().encode(reason).byteLength).toBeLessThanOrEqual(123)
		expect(reason).toBe("é".repeat(61))
	})

	it("truncateUtf8 never splits a code point", () => {
		expect(truncateUtf8("ab", 123)).toBe("ab")
		expect(truncateUtf8("😀".repeat(40), 123)).toBe("😀".repeat(30))
		expect(truncateUtf8("a".repeat(200), 123)).toHaveLength(123)
	})
})

describe("realtime: wire format — one JSON text per frame, both directions", () => {
	it("send() always emits JSON, strings included", async () => {
		const { adapter, sockets } = testAdapter()
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: (_c, conn) => {
					conn.send("hi")
					conn.send(42)
					conn.send({ a: [1] })
				},
			})
		await app.fetch(upgrade("/rt"), {})
		await tick()
		expect(sockets[0]!.raw.send.mock.calls.map((c) => c[0])).toEqual(['"hi"', "42", '{"a":[1]}'])
	})

	it("send() of a value JSON cannot represent throws into the handler", async () => {
		const { adapter } = testAdapter()
		const errors: unknown[] = []
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: (_c, conn) => {
					conn.send(undefined)
				},
				onError: (e) => void errors.push(e),
			})
		await app.fetch(upgrade("/rt"), {})
		await tick()
		expect(errors[0]).toBeInstanceOf(TypeError)
	})

	it("an inbound frame is the payload itself; non-JSON and binary frames are dropped", async () => {
		const { adapter, sockets } = testAdapter()
		const got: unknown[] = []
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: (_c, conn) => {
					conn.on("message", (p) => void got.push(p))
				},
			})
		await app.fetch(upgrade("/rt"), {})
		const s = sockets[0]!
		s.message('{"text":"hello"}')
		s.message("not json")
		s.message(new ArrayBuffer(4))
		s.message('"str"')
		await tick()
		expect(got).toEqual([{ text: "hello" }, "str"])
	})

	it("closes with 1009 on a frame over maxFrameBytes", async () => {
		const { adapter, sockets } = testAdapter()
		const got: unknown[] = []
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: (_c, conn) => {
					conn.on("message", (p) => void got.push(p))
				},
				limits: { maxFrameBytes: 16 },
			})
		await app.fetch(upgrade("/rt"), {})
		sockets[0]!.message(JSON.stringify("x".repeat(64)))
		await tick()
		expect(sockets[0]!.raw.close).toHaveBeenCalledWith(1009, "frame too large")
		expect(got).toEqual([])
	})
})

describe("realtime: namespaces", () => {
	it("two routes using the same topic name never see each other's messages", async () => {
		const { adapter, sockets } = testAdapter()
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/public", {
				handler: (_c, conn) => {
					conn.join("events")
					conn.on("message", (p) => conn.publish("events", p))
				},
			})
			.realtime("/admin", {
				handler: (_c, conn) => {
					conn.join("events")
				},
			})
		await app.fetch(upgrade("/public"), {})
		await app.fetch(upgrade("/admin"), {})
		await tick()
		sockets[0]!.message('{"from":"public"}')
		await tick()
		expect(sockets[0]!.sent()).toEqual([{ from: "public" }])
		expect(sockets[1]!.raw.send).not.toHaveBeenCalled()
	})

	it("routes that name the same namespace share topics", async () => {
		const { adapter, sockets } = testAdapter()
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/a", {
				handler: (_c, conn) => {
					conn.join("t")
					conn.on("message", (p) => conn.publish("t", p))
				},
				namespace: "chat",
			})
			.realtime("/b", { handler: (_c, conn) => conn.join("t"), namespace: "chat" })
		await app.fetch(upgrade("/a"), {})
		await app.fetch(upgrade("/b"), {})
		await tick()
		sockets[0]!.message("1")
		await tick()
		expect(sockets[1]!.sent()).toEqual([1])
	})

	it("ctx.realtime.publish needs a namespace once the app has several", async () => {
		const { adapter, sockets } = testAdapter()
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/a", { handler: (_c, conn) => conn.join("t"), namespace: "chat" })
			.realtime("/b", { handler: (_c, conn) => conn.join("t") })
			.post("/ambiguous")
			.handler((ctx) => {
				ctx.realtime.publish("t", 1)
				return ctx.res.json("ok", {})
			})
			.post("/explicit")
			.handler((ctx) => {
				ctx.realtime.namespace("chat").publish("t", 2)
				ctx.realtime.namespace("/b").publish("t", 3)
				return ctx.res.json("ok", {})
			})
		await app.fetch(upgrade("/a"), {})
		await app.fetch(upgrade("/b"), {})
		await tick()
		const res = await app.fetch(new Request("http://localhost/ambiguous", { method: "POST" }), {})
		expect(res.status).toBe(500)
		await app.fetch(new Request("http://localhost/explicit", { method: "POST" }), {})
		expect(sockets[0]!.sent()).toEqual([2])
		expect(sockets[1]!.sent()).toEqual([3])
	})

	it("rejects an empty namespace", () => {
		expect(() => honey().realtime("/a", { handler: () => {}, namespace: "" })).toThrow(/namespace/)
	})
})

describe("realtime: limits", () => {
	it("join throws past maxTopics; re-joining a topic already held is fine", async () => {
		const { adapter } = testAdapter()
		const errors: unknown[] = []
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: (_c, conn) => {
					conn.join("a")
					conn.join("b")
					conn.join("a")
					conn.join("c")
				},
				limits: { maxTopics: 2 },
				onError: (e) => void errors.push(e),
			})
		await app.fetch(upgrade("/rt"), {})
		await tick()
		expect(errors).toHaveLength(1)
		expect(errors[0]).toBeInstanceOf(RangeError)
	})

	it("closes a slow consumer with 1013 by default", async () => {
		const { adapter, sockets } = testAdapter()
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/rt", { handler: (_c, conn) => conn.join("t"), limits: { maxBufferedBytes: 100 } })
			.post("/pub")
			.handler((ctx) => {
				ctx.realtime.publish("t", "x")
				return ctx.res.json("ok", {})
			})
		await app.fetch(upgrade("/rt"), {})
		await tick()
		sockets[0]!.raw.bufferedAmount = 1000
		await app.fetch(new Request("http://localhost/pub", { method: "POST" }), {})
		expect(sockets[0]!.raw.close).toHaveBeenCalledWith(1013, "slow consumer")
		expect(sockets[0]!.raw.send).not.toHaveBeenCalled()
	})

	it("drops frames for a slow consumer with slowConsumer: 'drop'", async () => {
		const { adapter, sockets } = testAdapter()
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: (_c, conn) => conn.join("t"),
				limits: { maxBufferedBytes: 100, slowConsumer: "drop" },
			})
			.post("/pub")
			.handler((ctx) => {
				ctx.realtime.publish("t", "x")
				return ctx.res.json("ok", {})
			})
		await app.fetch(upgrade("/rt"), {})
		await tick()
		sockets[0]!.raw.bufferedAmount = 1000
		await app.fetch(new Request("http://localhost/pub", { method: "POST" }), {})
		sockets[0]!.raw.bufferedAmount = 0
		await app.fetch(new Request("http://localhost/pub", { method: "POST" }), {})
		expect(sockets[0]!.raw.close).not.toHaveBeenCalled()
		expect(sockets[0]!.sent()).toEqual(["x"])
	})

	it("rejects invalid limits and options the bus does not implement", () => {
		expect(() => honey().realtime("/a", { handler: () => {}, limits: { maxTopics: 0 } })).toThrow(/maxTopics/)
		expect(() => honey().realtime("/a", { handler: () => {}, limits: { slowConsumer: "x" as never } })).toThrow(
			/slowConsumer/,
		)
		expect(() => honey().realtime("/a", { handler: () => {}, transports: ["sse"] } as never)).toThrow(/transport/)
	})
})

describe("realtime: identify", () => {
	it("sets conn.userId from identify(ctx)", async () => {
		const { adapter } = testAdapter()
		let userId: string | null = "unset"
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: (_c, conn) => {
					userId = conn.userId
				},
				identify: (ctx) => ctx.req.headers.get("x-user"),
			})
		const req = new Request("http://localhost/rt", {
			headers: { connection: "Upgrade", upgrade: "websocket", "x-user": "u1" },
		})
		await app.fetch(req, {})
		await tick()
		expect(userId).toBe("u1")
	})

	it("userId is null without identify", async () => {
		const { adapter } = testAdapter()
		let userId: string | null = "unset"
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler: (_c, conn) => {
					userId = conn.userId
				},
			})
		await app.fetch(upgrade("/rt"), {})
		await tick()
		expect(userId).toBeNull()
	})

	it("a throwing identify rejects the upgrade with its error status", async () => {
		const { adapter, sockets } = testAdapter()
		const handler = vi.fn()
		const app = honey()
			.wsAdapter(adapter)
			.realtime("/rt", {
				handler,
				identify: () => {
					throw new HoneyError({ errorKey: "unauthorized", status: "unauthorized" })
				},
			})
		const res = await app.fetch(upgrade("/rt"), {})
		expect(res.status).toBe(401)
		expect(sockets).toHaveLength(0)
		expect(handler).not.toHaveBeenCalled()
	})
})

describe("realtime: socket delivered through onOpen (Bun, Deno)", () => {
	it("starts the connection when the socket opens", async () => {
		const { adapter, sockets } = testAdapter({ openOnUpgrade: false })
		const started = vi.fn()
		const app = honey()
			.wsAdapter({
				upgrade(req, env, handler) {
					const r = adapter.upgrade(req, env, handler) as { response: Response; socket: WSContextImpl }
					/* the runtime has not opened it yet */
					;(r.socket.raw as Raw).readyState = 0
					setTimeout(() => {
						;(r.socket.raw as Raw).readyState = 1
						handler.onOpen?.(undefined, r.socket)
					}, 1)
					return r
				},
			})
			.realtime("/rt", { handler: started })
		await app.fetch(upgrade("/rt"), {})
		expect(started).not.toHaveBeenCalled()
		await tick()
		expect(started).toHaveBeenCalledTimes(1)
		expect(sockets).toHaveLength(1)
	})
})
