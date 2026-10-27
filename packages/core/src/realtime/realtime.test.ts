import { describe, expect, it, vi } from "vitest"
import { HoneyError } from "../errors/error.ts"
import { createMiddleware } from "../middleware/middleware.ts"
import { honey } from "../routing/app.ts"
import { type WSAdapter, WSContextImpl, type WSHandler } from "../ws/contract.ts"
import { createBus } from "./bus.ts"
import { realtime } from "./realtime.ts"
import type { ConnContext } from "./route.ts"
import { ws } from "../ws/route.ts"

type Raw = {
	bufferedAmount: number
	close: ReturnType<typeof vi.fn<(code?: number, reason?: string) => void>>
	readyState: number
	send: ReturnType<typeof vi.fn<(data: unknown) => void>>
}

type Socket = {
	close(code: number, reason: string): void
	error(error: unknown): void
	message(data: string): void
	raw: Raw
	/** frames the server sent, parsed */
	sent(): unknown[]
}

/** What an adapter's 101 looks like where Fetch refuses status 101: a Response that says 101. */
function upgraded(): Response {
	const response = new Response(null, { headers: { connection: "Upgrade", upgrade: "websocket" } })
	Object.defineProperty(response, "status", { value: 101 })
	return response
}

/** An adapter that opens each upgrade at once and lets a test drive the socket; a server close echoes. */
function testAdapter() {
	const sockets: Socket[] = []
	const adapter: WSAdapter = {
		upgrade(_req, _env, handler: WSHandler<unknown>) {
			const raw: Raw = { bufferedAmount: 0, close: vi.fn(), readyState: 1, send: vi.fn() }
			const wsContext = new WSContextImpl(raw)
			const socket: Socket = {
				close(code, reason) {
					if (raw.readyState === 3) return
					raw.readyState = 3
					handler.onClose?.(undefined, wsContext, code, reason)
				},
				error: (error) => handler.onError?.(undefined, wsContext, error),
				message: (data) => handler.onMessage?.(undefined, wsContext, data),
				raw,
				sent: () => raw.send.mock.calls.map((call) => JSON.parse(call[0] as string) as unknown),
			}
			raw.close.mockImplementation((code, reason) => socket.close(code ?? 1005, reason ?? ""))
			sockets.push(socket)
			handler.onOpen?.(undefined, wsContext)
			return { response: upgraded(), socket: wsContext }
		},
	}
	return { adapter, sockets }
}

function handshake(path: string, headers: Record<string, string> = {}): Request {
	return new Request(`https://app.example.com${path}`, {
		headers: { connection: "Upgrade", upgrade: "websocket", ...headers },
	})
}

const post = (path: string) => new Request(`https://app.example.com${path}`, { method: "POST" })
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

const reject = (): never => {
	throw new HoneyError({ errorKey: "unauthorized", status: "unauthorized" })
}

/** An app on a fresh test adapter. */
function appWith() {
	const { adapter, sockets } = testAdapter()
	return { app: honey<{}>().wsAdapter(adapter), sockets }
}

describe("realtime(app, path, opts): registration", () => {
	// v0: befe31a5ab
	// v0: c64a0b7d14
	// v0: e626a593ee
	// v0: e80b45902e
	// v0: 004808e615
	// v0: 4091b8be8e
	it("registers beside HTTP routes, ws routes and other realtime routes, and never shadows an HTTP route on its path", async () => {
		const { app } = appWith()
		const opened: string[] = []
		realtime(app, "/a", { handler: () => void opened.push("a") })
		realtime(app, "/b", { handler: () => void opened.push("b") })
		ws(app, "/plain").handler({ onOpen: () => void opened.push("plain") })
		app.get("/a").handler((ctx) => ctx.res.text("ok", "page"))
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		const responses = await Promise.all(
			[handshake("/a"), handshake("/b"), handshake("/plain"), new Request("https://app.example.com/a")].map((req) =>
				app.fetch(req, {}),
			),
		)
		const health = await app.fetch(new Request("https://app.example.com/health"), {})
		await settle()
		expect([responses.map((res) => res.status), await responses[3]?.text(), health.status, opened.toSorted()]).toEqual([
			[101, 101, 101, 200],
			"page",
			200,
			["a", "b", "plain"],
		])
	})

	// v0: 7338f9f4e1 — v1 returns the route's publisher in place of the app (ruling 12)
	// v0: 76cbedebee
	it("returns the route's publisher, not the app; a second realtime route on one path throws", () => {
		const { app } = appWith()
		const publisher = realtime(app, "/rt", { handler: () => {} })
		expect([Object.keys(publisher).toSorted(), publisher === (app as unknown)]).toEqual([
			["namespace", "publish"],
			false,
		])
		expect(() => realtime(app, "/rt", { handler: () => {} })).toThrow("Duplicate route: WS /rt")
	})

	// v0: 96b4fcc713
	// v0: f6d72b433b
	it("refuses reconnectBuffer at the call and registers nothing", async () => {
		const { app } = appWith()
		expect(() => realtime(app, "/rt", { handler: () => {}, reconnectBuffer: 10 } as never)).toThrow(
			'realtime("/rt"): reconnectBuffer is not supported.',
		)
		expect((await app.fetch(handshake("/rt"), {})).status).toBe(404)
	})
})

describe("realtime(app, path, opts): matching", () => {
	// v0: 2f055fcabb
	// v0: d1079813d6
	// v0: c0ec4d4eba
	// v0: 7131828556
	it("an upgrade on the path is 101, elsewhere 404; a plain GET is 426; an empty path is the root", async () => {
		const { app } = appWith()
		realtime(app, "/rt", { handler: () => {} })
		realtime(app, "", { handler: () => {} })
		const [ok, missing, plain, root] = await Promise.all(
			[handshake("/rt"), handshake("/nope"), new Request("https://app.example.com/rt"), handshake("/")].map((req) =>
				app.fetch(req, {}),
			),
		)
		expect([ok.status, missing.status, plain.status, plain.headers.get("upgrade"), root.status]).toEqual([
			101,
			404,
			426,
			"websocket",
			101,
		])
	})

	// v0: 33adc865ef
	// v0: 04c9391b7d
	// v0: a7df562834
	it("the handler gets the request ctx with req and every path param", async () => {
		const { app } = appWith()
		const seen: unknown[] = []
		realtime(app, "/org/:org/room/:room", {
			handler: (ctx) => void seen.push([ctx.params, new URL(ctx.req.url).pathname]),
		})
		await app.fetch(handshake("/org/acme/room/lobby"), {})
		await settle()
		expect(seen).toEqual([[{ org: "acme", room: "lobby" }, "/org/acme/room/lobby"]])
	})

	// v0: 8ada927a9b
	it("with no ws adapter the upgrade is a 500", async () => {
		const app = honey<{}>()
		realtime(app, "/rt", { handler: () => {} })
		expect((await app.fetch(handshake("/rt"), {})).status).toBe(500)
	})
})

describe("realtime(app, path, opts): mounted and chained handles", () => {
	// v0: 9334bdb6fb
	// v0: 77bbf3143a
	it("a mounted sub-app's realtime route upgrades through the parent, and a plain GET there is 426", async () => {
		const { app } = appWith()
		const opened: string[] = []
		const sub = honey<{}>()
		realtime(sub, "/chat/stream", { handler: () => void opened.push("sub") })
		realtime(app.use(createMiddleware((_ctx, next) => next())), "/live", { handler: () => void opened.push("chained") })
		app.route(sub)
		const [plain, mounted, chained] = await Promise.all(
			[new Request("https://app.example.com/chat/stream"), handshake("/chat/stream"), handshake("/live")].map((req) =>
				app.fetch(req, {}),
			),
		)
		await settle()
		expect([plain.status, mounted.status, chained.status, opened.toSorted()]).toEqual([
			426,
			101,
			101,
			["chained", "sub"],
		])
	})
})

describe("realtime(app, path, opts): the connection", () => {
	// v0: 2709d13c83
	// v0: fb827f060a
	// v0: e46a1395f1
	it("runs the handler once per connection when the socket opens, each with its own conn", async () => {
		const { app } = appWith()
		const conns: ConnContext[] = []
		realtime(app, "/rt", { handler: (_ctx, conn) => void conns.push(conn) })
		await Promise.all([1, 2, 3].map(() => app.fetch(handshake("/rt"), {})))
		await settle()
		expect([conns.length, new Set(conns.map((conn) => conn.id)).size]).toEqual([3, 3])
	})

	// v0: adb56ec145
	it("a handler that throws closes its own connection 1011; the upgrade and the server carry on", async () => {
		const { app, sockets } = appWith()
		const errors: unknown[] = []
		realtime(app, "/rt", {
			handler: () => {
				throw new Error("boom")
			},
			onError: (error) => void errors.push(error),
		})
		const res = await app.fetch(handshake("/rt"), {})
		await settle()
		const next = await app.fetch(handshake("/rt"), {})
		await settle()
		expect([res.status, next.status, sockets.map((socket) => socket.raw.close.mock.calls), errors.length]).toEqual([
			101,
			101,
			[[[1011, "internal error"]], [[1011, "internal error"]]],
			2,
		])
	})

	it("a frame, a socket error and the close reach the session through the ws route", async () => {
		const { app, sockets } = appWith()
		const seen: unknown[] = []
		const onError = vi.fn()
		realtime(app, "/rt", {
			handler: (_ctx, conn) => {
				conn.on("message", (p) => void seen.push(p))
				conn.on("close", (reason) => void seen.push(`close:${reason}`))
			},
			onError,
		})
		await app.fetch(handshake("/rt"), {})
		sockets[0]?.message('{"n":1}')
		sockets[0]?.error(new Error("reset"))
		sockets[0]?.close(1000, "bye")
		await settle()
		/* a transport error is the socket's, not the route's: onError never hears it */
		expect([seen, onError.mock.calls]).toEqual([[{ n: 1 }, "close:bye"], []])
	})
})

describe("realtime(app, path, opts): middleware and identify", () => {
	// v0: 792bdcc4f4
	// v0: cf74a11ac2
	// v0: a5df24cc6d
	// v0: 885dc768bc
	// v0: 198dfa737e
	it("the app chain, then opts.use in order, then identify run before the handler, and what they add reaches it", async () => {
		const { app } = appWith()
		const order: string[] = []
		const step = (name: string, adds: Record<string, unknown> = {}) =>
			createMiddleware((_ctx, next) => {
				order.push(name)
				return next(adds)
			})
		let seen: unknown
		realtime(app.use(step("global")), "/rt", {
			handler: (ctx, conn) => {
				order.push("handler")
				seen = [(ctx as unknown as { role: string }).role, conn.userId]
			},
			identify: (ctx) => {
				order.push("identify")
				return ctx.req.headers.get("x-user")
			},
			use: [step("first", { role: "admin" }), step("second")],
		})
		await app.fetch(handshake("/rt", { "x-user": "u1" }), {})
		await settle()
		expect([order, seen]).toEqual([
			["global", "first", "second", "identify", "handler"],
			["admin", "u1"],
		])
	})

	// v0: d81a03f6b6
	it.each([
		["no identify", undefined],
		["an identify that finds nobody", () => undefined],
	])("conn.userId is null with %s", async (_name, identify) => {
		const { app } = appWith()
		let userId: unknown = "unset"
		realtime(app, "/rt", { handler: (_ctx, conn) => void (userId = conn.userId), identify })
		await app.fetch(handshake("/rt"), {})
		await settle()
		expect(userId).toBeNull()
	})
})

describe("realtime(app, path, opts): a refused upgrade", () => {
	// v0: 952c6ff05f
	// v0: ef8cd05f3d
	it.each([
		["a route middleware", "use"],
		["identify", "identify"],
	] as const)("%s that throws rejects the upgrade with its error status, before any socket", async (_name, where) => {
		const { app, sockets } = appWith()
		const handler = vi.fn()
		realtime(app, "/rt", {
			handler,
			...(where === "use" ? { use: [createMiddleware(reject)] } : { identify: reject }),
		})
		const res = await app.fetch(handshake("/rt"), {})
		await settle()
		expect([res.status, sockets.length, handler.mock.calls.length]).toEqual([401, 0, 0])
	})

	// v0: 22c6c94abc
	it("allowedOrigins is the route's origin policy: a credentialed cross-site upgrade gets 403, a listed origin passes", async () => {
		const { app, sockets } = appWith()
		realtime(app, "/open", { handler: () => {} })
		realtime(app, "/listed", { allowedOrigins: ["https://partner.example"], handler: () => {} })
		const cross = { cookie: "sid=1", origin: "https://evil.example" }
		const statuses = await Promise.all([
			app.fetch(handshake("/open", cross), {}),
			app.fetch(handshake("/listed", cross), {}),
			app.fetch(handshake("/listed", { cookie: "sid=1", origin: "https://partner.example" }), {}),
		])
		expect([statuses.map((res) => res.status), sockets.length]).toEqual([[403, 403, 101], 1])
	})
})

describe("realtime(app, path, opts): the publisher", () => {
	// v0: 9eab38f974 — v1 publishes through the returned publisher; there is no ctx.realtime (ruling 12)
	// v0: 4537b82232
	// v0: 4de0cb0cb7
	// v0: 2fcaf293ea
	// v0: 2094bd189e
	// v0: 38d651709a
	it("a REST handler publishes through it to the joined connections; before any, or to an empty topic, it is quiet", async () => {
		const { app, sockets } = appWith()
		const live = realtime(app, "/rt", { handler: (_ctx, conn) => conn.join("room") })
		app.post("/broadcast").handler((ctx) => {
			live.publish("room", { hi: 1 })
			live.publish("empty", { hi: 2 })
			return ctx.res.text("ok", "ok")
		})
		const early = await app.fetch(post("/broadcast"), {})
		await app.fetch(handshake("/rt"), {})
		await app.fetch(handshake("/rt"), {})
		await settle()
		const res = await app.fetch(post("/broadcast"), {})
		expect([early.status, res.status, sockets.map((socket) => socket.sent())]).toEqual([
			200,
			200,
			[[{ hi: 1 }], [{ hi: 1 }]],
		])
	})

	// v0: dbb20abe5a — v1: each route's publisher knows its namespace; another is reached through namespace(name)
	it("each publisher reaches its own namespace; namespace(name) reaches another on the same bus", async () => {
		const { app, sockets } = appWith()
		const bus = createBus()
		const a = realtime(app, "/a", { bus, handler: (_ctx, conn) => conn.join("t"), namespace: "chat" })
		const b = realtime(app, "/b", { bus, handler: (_ctx, conn) => conn.join("t") })
		await app.fetch(handshake("/a"), {})
		await app.fetch(handshake("/b"), {})
		await settle()
		a.publish("t", 1)
		b.publish("t", 2)
		b.namespace("chat").publish("t", 3)
		a.namespace("/b").publish("t", 4)
		expect(sockets.map((socket) => socket.sent())).toEqual([
			[1, 3],
			[2, 4],
		])
	})
})

describe("realtime(app, path, opts): after the close", () => {
	// v0: 06a747437d
	it("join and send are no-ops; an async handler joining late leaves no subscriber", async () => {
		const { app, sockets } = appWith()
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let conn!: ConnContext
		const live = realtime(app, "/rt", {
			handler: async (_ctx, x) => {
				conn = x
				await gate
				x.join("room")
				x.leave("room")
				x.join("room")
				x.send({ late: true })
			},
		})
		await app.fetch(handshake("/rt"), {})
		sockets[0]?.close(1001, "gone")
		release()
		await settle()
		live.publish("room", 1)
		expect([conn.closed, sockets[0]?.raw.send.mock.calls]).toEqual([true, []])
	})

	// v0: fa6fae7184
	it("publish from a close handler still reaches the others", async () => {
		const { app, sockets } = appWith()
		realtime(app, "/rt", {
			handler: (_ctx, conn) => {
				conn.join("room")
				conn.on("close", () => conn.publish("room", { left: conn.id }))
			},
		})
		await app.fetch(handshake("/rt"), {})
		await app.fetch(handshake("/rt"), {})
		await settle()
		sockets[0]?.close(1000, "")
		await settle()
		expect([sockets[1]?.sent(), sockets[0]?.raw.send.mock.calls]).toEqual([[{ left: expect.any(String) }], []])
	})

	// v0: 77bec622f8
	it("conn.close() closes 1000 once, a long reason cut to 123 UTF-8 bytes, none as empty", async () => {
		const { app, sockets } = appWith()
		realtime(app, "/long", {
			handler: (_ctx, conn) => {
				conn.close("é".repeat(100))
				conn.close("again")
			},
		})
		realtime(app, "/bare", { handler: (_ctx, conn) => conn.close() })
		await app.fetch(handshake("/long"), {})
		await app.fetch(handshake("/bare"), {})
		await settle()
		expect(sockets.map((socket) => socket.raw.close.mock.calls)).toEqual([[[1000, "é".repeat(61)]], [[1000, ""]]])
	})
})
