/**
 * WS2 (middleware) findings, frozen as regressions. Each test names its finding: what a route runs
 * is fixed at registration, scopes guard request paths, the 404/405/preflight pipeline runs the
 * chain once with a full ctx, errors keep their shape through the chain and across mounts, and
 * registration mistakes fail loudly.
 */
import { describe, expect, it } from "vitest"
import { HoneyError } from "../../src/errors/error.ts"
import { defineErrors } from "../../src/errors/errors.ts"
import { createMiddleware, defineMiddleware } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"

type Fetchable = { fetch: (r: Request, env: never) => Response | Promise<Response> }

async function send(app: Fetchable, target: string, init: RequestInit = {}) {
	const res = await app.fetch(new Request(`http://x${target}`, init), {} as never)
	const text = await res.text()
	const body: unknown = res.headers.get("content-type") === "application/json" ? JSON.parse(text) : text
	return { body, status: res.status }
}

const denied = { body: "denied", status: 401 }
const deny = createMiddleware(() => new Response("denied", { status: 401 }))

const envelope = (key: string, status: number, statusKey = key) => ({
	body: { error_key: key, fields: {}, message: key, status, status_key: statusKey, success: false },
	status,
})

/** A middleware that records `name` each time it runs. */
const tracer = (trace: string[], name: string) =>
	createMiddleware((_ctx, next) => {
		trace.push(name)
		return next()
	})

describe("what a route runs is fixed at registration, not by the serving handle", () => {
	// regression: H10
	// v0: 8ae1637ed8
	it("H10: serving a sub on its own first does not let a mounting chain skip its auth", async () => {
		const sub = honey<{}>()
		sub.get("/data").handler((ctx) => ctx.res.json("ok", { data: 1 }))
		expect(await send(sub, "/data")).toEqual({ body: { data: 1 }, status: 200 })
		const parent = honey<{}>().use(deny).route(sub)
		expect(await send(parent, "/data")).toEqual(denied)
		expect(await send(sub, "/data")).toEqual({ body: { data: 1 }, status: 200 })
	})

	// regression: H11
	// v0: c63de00b48
	it("H11: routes mounted through an authed chain handle are protected when the root serves", async () => {
		const app = honey<{}>()
		const authed = app.use(deny)
		authed.get("/me").handler((ctx) => ctx.res.json("ok", {}))
		const admin = honey<{}>()
		admin.get("/admin/users").handler((ctx) => ctx.res.json("ok", { users: [] }))
		authed.route(admin)
		expect(await send(app, "/me")).toEqual(denied)
		expect(await send(app, "/admin/users")).toEqual(denied)
	})

	// regression: H15
	// v0: e0fb56f160
	it("H15: a route registered before a later use() runs its chain once and never the later auth", async () => {
		const trace: string[] = []
		const withA = honey<{}>().use(tracer(trace, "a"))
		withA.get("/public").handler((ctx) => ctx.res.json("ok", {}))
		const withAuth = withA.use(tracer(trace, "auth"))
		withAuth.get("/private").handler((ctx) => ctx.res.json("ok", {}))
		expect(await send(withAuth, "/public")).toEqual({ body: {}, status: 200 })
		expect(trace).toEqual(["a"])
		trace.length = 0
		expect(await send(withAuth, "/private")).toEqual({ body: {}, status: 200 })
		expect(trace).toEqual(["a", "auth"])
	})

	// regression: H bare use (was M)
	// v0: f277e1a831
	it("H-bare-use: a bare app.use(mw) statement fails loudly instead of leaving later routes unprotected", () => {
		const app = honey<{}>()
		app.use(deny)
		app.get("/secret").handler((ctx) => ctx.res.json("ok", { secret: true }))
		expect(() => app.fetch(new Request("http://x/secret"), {})).toThrow(
			/returned a handle that never registers a route/,
		)
	})
})

describe("scopes guard request paths", () => {
	// regression: H12
	// v0: 12dd76a075
	it.each([
		{ answer: denied, method: "GET", pattern: "/:section/users", scope: "/admin", target: "/admin/users" },
		{
			answer: { body: { ok: true }, status: 200 },
			method: "GET",
			pattern: "/:section/users",
			scope: "/admin",
			target: "/public/users",
		},
		{ answer: denied, method: "ALL", pattern: "/*", scope: "/admin", target: "/admin/anything" },
		{ answer: denied, method: "GET", pattern: "/orgs/:orgId/members", scope: "/orgs/:id", target: "/orgs/1/members" },
	] as const)(
		"H12: use($scope) over $method $pattern answers $target with $answer.status",
		async ({ answer, method, pattern, scope, target }) => {
			const app = honey<{}>()
			app.use(scope, deny)
			app.on([method], pattern).handler((ctx) => ctx.res.json("ok", { ok: true }))
			expect(await send(app, target)).toEqual(answer)
		},
	)

	// regression: H13
	// v0: 5d1dfbe98f
	it("H13: chain middleware runs before scoped middleware, also when the sub-app is mounted", async () => {
		const auth = createMiddleware((_ctx, next) => next({ user: "u1" }))
		const requireUser = createMiddleware((ctx: { user?: string }, next) =>
			ctx.user === undefined ? new Response("no user", { status: 500 }) : next(),
		)
		const sub = honey<{}>().use(auth)
		sub.use("/admin", requireUser)
		sub.get("/admin/x").handler((ctx) => ctx.res.json("ok", { user: ctx.user }))
		const parent = honey<{}>()
		parent.route(sub)
		for (const app of [sub, parent]) expect(await send(app, "/admin/x")).toEqual({ body: { user: "u1" }, status: 200 })
	})
})

describe("the 404, 405 and preflight pipeline", () => {
	// regression: M (was H14)
	// v0: 248b7cea72
	it("M-H14: a 404 runs the middleware with ctx.errors and the real ctx.path", async () => {
		const errors = defineErrors({ unauthorized: "unauthorized" })
		const seen: string[] = []
		const lock = createMiddleware((ctx: { errors: Readonly<Record<string, unknown>>; path: string }, next) => {
			seen.push(ctx.path)
			if (ctx.path.startsWith("/locked")) throw (ctx.errors.unauthorized as () => HoneyError)()
			return next()
		})
		const app = honey<{}>().errorFactory(errors).use(lock)
		app.get("/open").handler((ctx) => ctx.res.json("ok", {}))
		expect(await send(app, "/locked/nope")).toEqual(envelope("unauthorized", 401))
		expect(await send(app, "/nope")).toEqual(envelope("not_found", 404))
		expect(seen).toEqual(["/locked/nope", "/nope"])
	})

	// regression: M preflight chain twice
	// v0: 63e0cc5148
	it("M-preflight-twice: a preflight that is not short-circuited runs the chain once", async () => {
		const trace: string[] = []
		const app = honey<{}>().use(tracer(trace, "count"))
		app.post("/p").handler((ctx) => ctx.res.json("ok", {}))
		const preflight = { "access-control-request-method": "POST", origin: "https://a.example" }
		expect(await send(app, "/p", { headers: preflight, method: "OPTIONS" })).toEqual(
			envelope("method_not_allowed", 405),
		)
		expect(trace).toEqual(["count"])
	})
})

describe("errors keep their shape through the chain", () => {
	// regression: H16
	// v0: 84af38bf0f
	it("H16: outer middleware post-next code runs when inner middleware throws", async () => {
		const outer = createMiddleware(async (_ctx, next) => {
			const res = await next()
			res.headers.set("x-outer", "1")
			return res
		})
		const inner = createMiddleware(() => {
			throw new HoneyError({ errorKey: "forbidden", status: "forbidden" })
		})
		const app = honey<{}>().use(outer).use(inner)
		app.get("/x").handler((ctx) => ctx.res.json("ok", {}))
		const res = await app.fetch(new Request("http://x/x"), {})
		expect([res.status, res.headers.get("x-outer"), await res.json()]).toEqual([
			403,
			"1",
			envelope("forbidden", 403).body,
		])
	})

	// regression: M chain-level use(mw) declares mw.errors
	// v0: ae9c81026f
	it("M-chain-errors: chain-level use(mw) contributes the middleware's declared errors", async () => {
		const errors = defineErrors({ blocked: "forbidden", teapot: "bad_request" })
		const block = defineMiddleware({
			errors: [errors, "blocked"],
			fn: () => {
				throw errors.blocked()
			},
		})
		const app = honey<{}>().errorFactory(errors).defaultErrors("teapot").use(block)
		app.get("/b").handler((ctx) => ctx.res.json("ok", {}))
		expect(await send(app, "/b")).toEqual(envelope("blocked", 403, "forbidden"))
	})

	// regression: L unknown status key
	// v0: 245588843b
	it("L-status-key: an unknown status key answers the full internal error, never 200 (H18.17)", async () => {
		const app = honey<{}>()
		app.get("/e").handler(() => {
			throw new HoneyError({ errorKey: "weird", status: "not_a_status" as never })
		})
		expect(await send(app, "/e")).toEqual(envelope("internal_server_error", 500))
	})
})

describe("mounted routes keep their error factory, context and meta", () => {
	// regression: M mounted sub keeps errorFactory and context
	// v0: f91146be1d
	it("M-sub-config: a mounted sub keeps its errorFactory and context values", async () => {
		const errors = defineErrors({ teapot: "forbidden" })
		const sub = honey<{}>().errorFactory(errors).context({ answer: 42 })
		sub.get("/ctx").handler((ctx) => ctx.res.json("ok", { answer: ctx.answer }))
		sub
			.get("/err")
			.errors("teapot")
			.handler((ctx) => {
				throw ctx.errors.teapot()
			})
		const parent = honey<{}>()
		parent.route(sub)
		expect(await send(parent, "/ctx")).toEqual({ body: { answer: 42 }, status: 200 })
		expect(await send(parent, "/err")).toEqual(envelope("teapot", 403, "forbidden"))
	})

	// regression: M middleware meta on mounted routes
	// v0: 6586ee8fcf
	it("M-mw-meta: meta contributed by the mounting chain reaches the mounted routes", async () => {
		const tag = createMiddleware((_ctx, next) => next(), { meta: { tier: "gold" } })
		const sub = honey<{}>()
		sub.get("/m").handler((ctx) => ctx.res.json("ok", { meta: ctx.meta }))
		const parent = honey<{}>()
		parent.use(tag).route(sub)
		expect(await send(parent, "/m")).toEqual({ body: { meta: { tier: "gold" } }, status: 200 })
	})
})

describe("registration fails loudly, and stays fast", () => {
	// regression: L reserved ctx keys
	// v0: 13047f7b51
	it.each(["searchAll", "path"])(
		"L-reserved: context() with the framework key %j is rejected at registration",
		(key) => {
			expect(() => honey<{}>().context({ [key]: 1 } as never)).toThrow(`context() cannot set reserved key "${key}"`)
		},
	)

	// regression: L RouteBuilder without handler
	// v0: 7f27ea285c
	it("L-no-handler: a route builder without .handler() is reported when the app serves", () => {
		const app = honey<{}>()
		app.get("/forgot")
		app.get("/ok").handler((ctx) => ctx.res.json("ok", {}))
		expect(() => app.fetch(new Request("http://x/ok"), {})).toThrow(
			/GET \/forgot was declared but never got a \.handler\(\)/,
		)
	})

	// regression: M (perf) route() re-walks the whole tree per scoped entry per mount
	// v0: 30a7badae6
	it("M-mount-perf: mounting 200 sub-apps under scoped middleware with meta stays fast", async () => {
		const errors = defineErrors({ blocked: "forbidden" })
		const scoped = defineMiddleware({
			errors: [errors, "blocked"],
			fn: (_ctx, next) => next(),
			meta: { area: "admin" },
		})
		const started = performance.now()
		const parent = honey<{}>().errorFactory(errors)
		for (let i = 0; i < 200; i++) {
			const sub = honey<{}>().errorFactory(errors)
			sub.use(`/s/${i}`, scoped)
			for (let r = 0; r < 5; r++) sub.get(`/s/${i}/r${r}`).handler((ctx) => ctx.res.json("ok", { r }))
			parent.route(sub)
		}
		expect(await send(parent, "/s/199/r4")).toEqual({ body: { r: 4 }, status: 200 })
		expect(performance.now() - started).toBeLessThan(3_000)
	}, 30_000)
})

describe("websocket routes run the same order", () => {
	// regression: NEW-H WS route middleware order
	// v0: f55ae6b3a6
	it("NEW-H ws-order: a WS route runs the chain before scoped middleware, before the upgrade", async () => {
		const trace: string[] = []
		const socket = { close() {}, raw: null, readyState: 1 as const, send() {} }
		const app = honey<{}>().wsAdapter({
			upgrade() {
				trace.push("upgrade")
				const response = new Response(null)
				Object.defineProperty(response, "status", { value: 101 })
				return { response, socket }
			},
		})
		app.use("/rooms", tracer(trace, "scoped"))
		app.use(tracer(trace, "chain")).ws("/rooms/:id").handler({})
		const res = await app.fetch(
			new Request("http://x/rooms/1", { headers: { connection: "Upgrade", upgrade: "websocket" } }),
			{},
		)
		expect([res.status, trace]).toEqual([101, ["chain", "scoped", "upgrade"]])
	})
})
