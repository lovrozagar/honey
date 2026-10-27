import { describe, expect, it, vi } from "vitest"
import { HoneyError } from "../errors/error.ts"
import { defineErrors } from "../errors/errors.ts"
import { createMiddleware } from "../middleware/middleware.ts"
import type { WSAdapter, WSContext, WSHandler } from "../ws/contract.ts"
import { honey } from "./app.ts"
import { ws } from "../ws/route.ts"

/** What an adapter's 101 looks like where Fetch refuses status 101: a Response that says 101. */
function upgraded(): Response {
	const response = new Response(null, { headers: { connection: "Upgrade", upgrade: "websocket" } })
	Object.defineProperty(response, "status", { value: 101 })
	return response
}

/** An adapter that records each upgrade and drives the handler: open, then each message in `messages`. */
function fakeAdapter(messages: string[] = []) {
	const socket: WSContext = { close: () => {}, raw: null, readyState: 1, send: () => {} }
	const upgrades: { env: unknown; req: Request; response: Response }[] = []
	const adapter: WSAdapter = {
		upgrade(req, env, handler: WSHandler<unknown>) {
			const response = upgraded()
			upgrades.push({ env, req, response })
			handler.onOpen?.(undefined, socket)
			for (const message of messages) handler.onMessage?.(undefined, socket, message)
			return { response, socket }
		},
	}
	return { adapter, upgrades }
}

/** A WebSocket handshake request for `path`; `headers` adds to it. */
function handshake(path: string, headers: Record<string, string> = {}): Request {
	return new Request(`https://app.example.com${path}`, {
		headers: {
			connection: "Upgrade",
			"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
			upgrade: "websocket",
			...headers,
		},
	})
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

describe("ws(app, path): a WebSocket route", () => {
	// v0: 4996752415
	// v0: bc6ba373c4
	it("an upgrade request runs the route: the adapter upgrades with the request and env, and its 101 goes out untouched", async () => {
		const { adapter, upgrades } = fakeAdapter(["hi"])
		const seen: unknown[] = []
		const app = honey<{ db: string }>().wsAdapter(adapter)
		ws(app, "/chat/:room").handler({
			onMessage: (ctx, socket, data) => void seen.push(["message", ctx.params.room, data, socket.readyState]),
			onOpen: (ctx) => void seen.push(["open", ctx.params.room, ctx.env.db]),
		})
		const res = await app.fetch(handshake("/chat/lobby"), { db: "primary" })
		await settle()
		expect([res === upgrades[0]?.response, res.status, upgrades[0]?.env, seen]).toEqual([
			true,
			101,
			{ db: "primary" },
			[
				["open", "lobby", "primary"],
				["message", "lobby", "hi", 1],
			],
		])
		expect(Object.fromEntries(res.headers)).toEqual({ connection: "Upgrade", upgrade: "websocket" })
	})

	// v0: 5b2828255d
	// v0: 684055496b
	// v0: 608d0f7913
	// v0: 4c4e621ed5
	// v0: b0cf67d28a
	it("a plain GET to a ws path no HTTP GET serves is 426 Upgrade Required; an HTTP GET on the same path answers it", async () => {
		const { adapter } = fakeAdapter()
		const app = honey<{}>().wsAdapter(adapter)
		ws(app, "/live").handler({})
		ws(app, "/both").handler({})
		app.get("/both").handler((ctx) => ctx.res.text("ok", "http"))
		ws(app, "/posts").handler({})
		app.post("/posts").handler((ctx) => ctx.res.text("ok", "posted"))
		const [live, both, posts, other] = await Promise.all(
			["/live", "/both", "/posts", "/elsewhere"].map((path) =>
				app.fetch(new Request(`https://app.example.com${path}`), {}),
			),
		)
		const seen = [live.status, live.headers.get("upgrade"), both.status, await both.text(), posts.status, other.status]
		expect(seen).toEqual([426, "websocket", 200, "http", 426, 404])
	})
})

describe("ws(app, path): which requests reach the route", () => {
	// v0: 2cdb172a14
	it("an upgrade request to a path with no ws route is an ordinary request", async () => {
		const { adapter, upgrades } = fakeAdapter()
		const app = honey<{}>().wsAdapter(adapter)
		app.get("/page").handler((ctx) => ctx.res.text("ok", "page"))
		ws(app, "/live").handler({})
		const [page, missing] = await Promise.all([app.fetch(handshake("/page"), {}), app.fetch(handshake("/nope"), {})])
		expect([page.status, missing.status, upgrades.length]).toEqual([200, 404, 0])
	})

	it("the basePath and a mounting app place the route, and the upgrade still reaches the adapter", async () => {
		const { adapter, upgrades } = fakeAdapter()
		const sub = honey<{}>()
		ws(sub, "/feed").handler({})
		const app = honey<{}>().wsAdapter(adapter)
		app.basePath("/v1").route("/sub", sub)
		const res = await app.fetch(handshake("/v1/sub/feed"), {})
		expect([res.status, upgrades.length]).toEqual([101, 1])
	})
})

describe("ws(app, path): reconnect and registration", () => {
	it("a reconnect_token in the query reaches onReconnect in place of onOpen", async () => {
		const { adapter } = fakeAdapter()
		const seen: string[] = []
		const app = honey<{}>().wsAdapter(adapter)
		ws(app, "/live").handler({
			onOpen: () => void seen.push("open"),
			onReconnect: (_c, _ws, token) => void seen.push(token),
		})
		await app.fetch(handshake("/live?reconnect_token=t-42"), {})
		await settle()
		expect(seen).toEqual(["t-42"])
	})

	it("a ws builder left without .handler() is reported, and a second ws route on one path throws", async () => {
		const app = honey<{}>()
		ws(app, "/a")
		await expect(async () => app.fetch(handshake("/a"), {})).rejects.toThrow(
			"WS /a was declared but never got a .handler()",
		)
		const other = honey<{}>()
		ws(other, "/b").handler({})
		expect(() => ws(other, "/b").handler({})).toThrow("Duplicate route: WS /b")
	})
})

describe("ws(app, path): what runs before the upgrade", () => {
	// v0: 685a5f9bee
	// v0: 63ea23180b
	// v0: 9e222bc620
	// v0: 9aaca7bc1c
	// v0: 71037bdd6f
	it("chain middleware, scoped middleware and route middleware run first, in order, and what they add reaches the callbacks", async () => {
		const { adapter } = fakeAdapter()
		const order: string[] = []
		const step = (name: string, adds?: Record<string, unknown>) =>
			createMiddleware((_ctx, next) => {
				order.push(name)
				return next(adds)
			})
		const app = honey<{}>().wsAdapter(adapter)
		app.use("/rooms", step("scoped"))
		ws(app.use(step("chain", { user: "u1" })), "/rooms/:id")
			.use(step("route"))
			.handler({ onOpen: (ctx) => void order.push(`open:${(ctx as unknown as { user: string }).user}`) })
		ws(app, "/elsewhere").handler({ onOpen: () => void order.push("open:elsewhere") })
		await app.fetch(handshake("/rooms/7"), {})
		await settle()
		await app.fetch(handshake("/elsewhere"), {})
		await settle()
		expect(order).toEqual(["chain", "scoped", "route", "open:u1", "open:elsewhere"])
	})

	it("middleware that answers itself refuses the upgrade: the adapter is never asked", async () => {
		const { adapter, upgrades } = fakeAdapter()
		const app = honey<{}>().wsAdapter(adapter)
		ws(app.use(createMiddleware(() => new Response("no", { status: 401 }))), "/live").handler({})
		const res = await app.fetch(handshake("/live"), {})
		expect([res.status, upgrades.length]).toEqual([401, 0])
	})
})

describe("ws(app, path): declared errors and meta", () => {
	it("errors(factory, ...keys) declares a named factory's key on the route", async () => {
		const { adapter, upgrades } = fakeAdapter()
		const own = defineErrors({ banned: "forbidden" })
		const app = honey<{}>().wsAdapter(adapter)
		ws(
			app.use(
				createMiddleware(() => {
					throw own.banned()
				}),
			),
			"/live",
		)
			.errors(own, "banned")
			.handler({})
		const res = await app.fetch(handshake("/live"), {})
		expect([res.status, ((await res.json()) as { error_key: string }).error_key, upgrades.length]).toEqual([
			403,
			"banned",
			0,
		])
	})

	it("a thrown declared error answers through the route's errors, before any upgrade", async () => {
		const { adapter, upgrades } = fakeAdapter()
		const app = honey<{}>().wsAdapter(adapter)
		ws(
			app.use(
				createMiddleware(() => {
					throw new HoneyError({ errorKey: "forbidden", status: "forbidden" })
				}),
			),
			"/live",
		)
			.errors("forbidden")
			.handler({})
		const res = await app.fetch(handshake("/live"), {})
		expect([res.status, ((await res.json()) as { error_key: string }).error_key, upgrades.length]).toEqual([
			403,
			"forbidden",
			0,
		])
	})

	it("route meta reaches ctx.meta in the callbacks", async () => {
		const { adapter } = fakeAdapter()
		const seen: unknown[] = []
		const app = honey<{}>().wsAdapter(adapter)
		ws(app.meta({ area: "chat" }), "/live")
			.meta({ summary: "live feed" })
			.handler({ onOpen: (ctx) => void seen.push(ctx.meta) })
		await app.fetch(handshake("/live"), {})
		await settle()
		expect(seen).toEqual([{ area: "chat", summary: "live feed" }])
	})
})

describe("ws(app, path): the origin check comes before the adapter (H18.12)", () => {
	// v0: a0a15d4670
	it.each([
		["same-origin with credentials", { cookie: "s=1", origin: "https://app.example.com" }, undefined, 101],
		["cross-origin with credentials", { cookie: "s=1", origin: "https://evil.example.com" }, undefined, 403],
		[
			"http against the https server, with credentials",
			{ cookie: "s=1", origin: "http://app.example.com" },
			undefined,
			403,
		],
		["cross-origin without credentials", { origin: "https://evil.example.com" }, undefined, 101],
		["no Origin", { cookie: "s=1" }, undefined, 101],
		[
			"a listed origin",
			{ authorization: "Bearer t", origin: "https://partner.example.org" },
			["https://partner.example.org"],
			101,
		],
		["any origin under *", { cookie: "s=1", origin: "https://evil.example.com" }, "*", 101],
	] as const)("%s → %i", async (_case, headers, policy, status) => {
		const { adapter, upgrades } = fakeAdapter()
		const app = honey<{}>().wsAdapter(adapter)
		const route = ws(app, "/live")
		;(policy === undefined ? route : route.origins(policy as "*" | string[])).handler({})
		const res = await app.fetch(handshake("/live", headers), {})
		expect([res.status, upgrades.length]).toEqual([status, status === 101 ? 1 : 0])
	})

	// v0: 6330ae1544
	it("origins() refuses a policy that is not one", () => {
		expect(() => ws(honey<{}>(), "/live").origins(["partner.example.org"])).toThrow("is not an origin")
	})
})

describe("ws(app, path): with no adapter", () => {
	// v0: cc7811f122
	// v0: 0a85fbff32
	// v0: b04bba9c7d
	it("answers 500, and onError hears the fix: set app.wsAdapter()", async () => {
		const onError = vi.fn()
		const app = honey<{}>().onError((error) => void onError((error as Error).message))
		ws(app, "/live").handler({})
		const res = await app.fetch(handshake("/live"), {})
		const body = (await res.json()) as { error_key: string }
		/* the fix is for the operator log; the client gets the masked internal error */
		expect([res.status, body.error_key, JSON.stringify(body).includes("wsAdapter")]).toEqual([
			500,
			"internal_server_error",
			false,
		])
		expect([res.status, onError.mock.calls]).toEqual([
			500,
			[
				[
					"honey: a WebSocket route was requested but no adapter is set: call app.wsAdapter(adapter), or serve(app) on Node or Bun",
				],
			],
		])
	})

	it("wsAdapter() is an app setting: set on one handle, every handle of the app upgrades with it", async () => {
		const { adapter, upgrades } = fakeAdapter()
		const app = honey<{}>()
		const authed = app.use(createMiddleware((_ctx, next) => next()))
		ws(authed, "/live").handler({})
		expect(app.wsAdapter(adapter)).toBe(app)
		expect([(await authed.fetch(handshake("/live"), {})).status, upgrades.length]).toEqual([101, 1])
	})
})
