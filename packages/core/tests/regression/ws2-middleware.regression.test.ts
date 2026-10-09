/**
 * Regression guards for workstream 2 of the 3ab88ce deep review (middleware resolved once, at
 * finalize). Each test reproduces a finding's scenario and failed on 3ab88ce; see
 * docs/regression-matrix/ws1-3.md. Only APIs that existed at 3ab88ce are used.
 */
import { describe, expect, it } from "vitest"
import { cors } from "../../src/cors.ts"
import { csrf } from "../../src/csrf.ts"
import { HoneyError } from "../../src/error.ts"
import { defineErrors } from "../../src/errors.ts"
import { createMiddleware, honey } from "../../src/index.ts"
import { defineMiddleware } from "../../src/middleware.ts"
import "../../src/openapi/register.ts"

type Fetchable = { fetch(r: Request, e?: object): Response | Promise<Response> }

async function send(app: Fetchable, path: string, init: RequestInit = {}): Promise<Response | "threw"> {
	try {
		return await app.fetch(new Request(`http://x${path}`, init), {})
	} catch {
		return "threw"
	}
}

async function status(app: Fetchable, path: string, init: RequestInit = {}): Promise<number | "threw"> {
	const res = await send(app, path, init)
	return res === "threw" ? res : res.status
}

const deny = createMiddleware(async () => new Response("denied", { status: 401 }))

function tracer(trace: string[], name: string) {
	return createMiddleware(async (_c, next) => {
		trace.push(name)
		return next()
	})
}

describe("WS2 regressions", () => {
	// regression: H10
	it("H10: serving a sub on its own first does not let a mounting chain skip its auth", async () => {
		const sub = honey()
		sub.get("/data").handler((c) => c.res.json("ok", { data: 1 }))
		await sub.fetch(new Request("http://x/data"), {})
		const parent = honey().use(deny).route(sub)
		expect(await status(parent, "/data")).toBe(401)
	})

	// regression: H11
	it("H11: routes mounted through an authed chain handle are protected when the root serves", async () => {
		const app = honey()
		const authed = app.use(deny)
		authed.get("/me").handler((c) => c.res.json("ok", {}))
		const admin = honey()
		admin.get("/admin/users").handler((c) => c.res.json("ok", { users: [] }))
		authed.route(admin)
		expect(await status(app, "/me")).toBe(401)
		expect(await status(app, "/admin/users")).toBe(401)
	})

	// regression: H12
	it("H12: scopes guard request paths, whatever the registered pattern", async () => {
		const a = honey()
		a.use("/admin", deny)
		a.get("/:section/users").handler((c) => c.res.json("ok", {}))
		expect(await status(a, "/admin/users")).toBe(401)
		expect(await status(a, "/public/users")).toBe(200)

		const b = honey()
		b.use("/admin", deny)
		b.all("/*").handler((c) => c.res.json("ok", {}))
		expect(await status(b, "/admin/anything")).toBe(401)

		const c = honey()
		c.use("/orgs/:id", deny)
		c.get("/orgs/:orgId/members").handler((ctx) => ctx.res.json("ok", {}))
		expect(await status(c, "/orgs/1/members")).toBe(401)
	})

	// regression: H13
	it("H13: chain middleware runs before scoped middleware, also when the sub-app is mounted", async () => {
		const auth = createMiddleware(async (_c, next) => next({ user: "u1" }))
		const requireAdmin = createMiddleware(async (c: { user?: string }, next) =>
			c.user === undefined ? new Response("no user", { status: 500 }) : next(),
		)
		const sub = honey().use(auth)
		sub.use("/admin", requireAdmin)
		sub.get("/admin/x").handler((c) => c.res.json("ok", { user: c.user }))
		const parent = honey()
		parent.route(sub)
		expect(await status(sub, "/admin/x")).toBe(200)
		expect(await status(parent, "/admin/x")).toBe(200)
	})

	// regression: M (was H14)
	it("M-H14: 404 runs middleware with ctx.errors and the real ctx.path", async () => {
		const errors = defineErrors({ unauthorized: "unauthorized" })
		const seen: string[] = []
		const app = honey()
			.errorFactory(errors)
			.use(
				createMiddleware(async (c: { path: string; errors: typeof errors }, next) => {
					seen.push(c.path)
					if (c.path.startsWith("/locked")) throw c.errors.unauthorized()
					return next()
				}),
			)
		app.get("/open").handler((c) => c.res.json("ok", {}))
		expect(await status(app, "/locked/nope")).toBe(401)
		await status(app, "/nope")
		expect(seen).toContain("/nope")
	})

	// regression: H15
	it("H15: a route registered before a later use() runs its chain once and never the later auth", async () => {
		const trace: string[] = []
		const h = honey().use(tracer(trace, "a"))
		h.get("/public").handler((c) => c.res.json("ok", {}))
		const h2 = h.use(tracer(trace, "auth"))
		h2.get("/private").handler((c) => c.res.json("ok", {}))
		trace.length = 0
		expect(await status(h2, "/public")).toBe(200)
		expect(trace).toEqual(["a"])
	})

	// regression: H16
	it("H16: outer middleware post-next code runs when inner middleware throws", async () => {
		const outer = createMiddleware(async (_c, next) => {
			const res = await next()
			res.headers.set("x-outer", "1")
			return res
		})
		const inner = createMiddleware(async () => {
			throw new HoneyError({ errorKey: "forbidden", status: "forbidden" })
		})
		const app = honey().use(outer).use(inner)
		app.get("/x").handler((c) => c.res.json("ok", {}))
		const res = await send(app, "/x")
		expect(res).not.toBe("threw")
		expect((res as Response).headers.get("x-outer")).toBe("1")
	})

	// regression: M mounted sub keeps errorFactory and context
	it("M-sub-config: a mounted sub keeps its errorFactory and context values", async () => {
		const errors = defineErrors({ teapot: "forbidden" })
		const sub = honey().errorFactory(errors).context({ answer: 42 })
		sub.get("/ctx").handler((c) => c.res.json("ok", { answer: c.answer }))
		sub.get("/err").handler((c) => {
			throw c.errors.teapot()
		})
		const parent = honey()
		parent.route(sub)
		const res = await send(parent, "/ctx")
		expect(res).not.toBe("threw")
		expect(await (res as Response).json()).toEqual({ answer: 42 })
		expect(await status(parent, "/err")).toBe(403)
	})

	// regression: H preflight (was M)
	it("H-preflight: a preflight runs the scoped cors and the requested method's chain", async () => {
		const app = honey()
		app.use("/api", cors({ origin: "https://admin.example" }))
		app.post("/api/x").handler((c) => c.res.json("ok", {}))
		const res = await send(app, "/api/x", {
			headers: { "access-control-request-method": "POST", origin: "https://admin.example" },
			method: "OPTIONS",
		})
		expect(res).not.toBe("threw")
		expect((res as Response).headers.get("access-control-allow-origin")).toBe("https://admin.example")

		const split = honey()
		split
			.use(cors({ origin: "*" }))
			.get("/w")
			.handler((c) => c.res.json("ok", {}))
		split
			.use(cors({ origin: "https://admin.example" }))
			.post("/w")
			.handler((c) => c.res.json("ok", {}))
		const pre = await send(split, "/w", {
			headers: { "access-control-request-method": "POST", origin: "https://evil.example" },
			method: "OPTIONS",
		})
		expect(pre).not.toBe("threw")
		expect((pre as Response).headers.get("access-control-allow-origin")).not.toBe("*")
	})

	// regression: M preflight chain twice
	it("M-preflight-twice: a preflight that is not short-circuited runs the chain once", async () => {
		const trace: string[] = []
		const app = honey().use(tracer(trace, "count"))
		app.post("/p").handler((c) => c.res.json("ok", {}))
		await send(app, "/p", {
			headers: { "access-control-request-method": "POST", origin: "https://a.example" },
			method: "OPTIONS",
		})
		expect(trace.length).toBeLessThanOrEqual(1)
	})

	// regression: M forbidden is a framework key
	it("M-forbidden: csrf rejection under errorFactory().defaultErrors() is 403, not 500", async () => {
		const errors = defineErrors({ teapot: "bad_request" })
		const app = honey().errorFactory(errors).defaultErrors("teapot").use(csrf())
		app.post("/form").handler((c) => c.res.json("ok", {}))
		const res = await status(app, "/form", {
			body: "a=1",
			headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
			method: "POST",
		})
		expect(res).toBe(403)
	})

	// regression: M chain-level use(mw) declares mw.errors
	it("M-chain-errors: chain-level use(mw) contributes the middleware's declared errors", async () => {
		const errors = defineErrors({ blocked: "forbidden", teapot: "bad_request" })
		const block = defineMiddleware({
			errors: [errors, "blocked"],
			fn: async () => {
				throw errors.blocked()
			},
		})
		const app = honey().errorFactory(errors).defaultErrors("teapot").use(block)
		app.get("/b").handler((c) => c.res.json("ok", {}))
		expect(await status(app, "/b")).toBe(403)
	})

	// regression: H bare use (was M)
	it("H-bare-use: a bare app.use(mw) statement never leaves later routes silently unprotected", async () => {
		const app = honey()
		app.use(deny)
		app.get("/secret").handler((c) => c.res.json("ok", { secret: true }))
		expect(await status(app, "/secret")).not.toBe(200)
	})

	// regression: M middleware meta on mounted routes
	it("M-mw-meta: meta contributed by the mounting chain reaches the mounted routes", async () => {
		const tag = createMiddleware(async (_c, next) => next(), { meta: { tier: "gold" } })
		const sub = honey()
		sub.get("/m").handler((c) => c.res.json("ok", { tier: (c.meta as { tier?: string }).tier ?? null }))
		const parent = honey()
		parent.use(tag).route(sub)
		const res = await send(parent, "/m")
		expect(res).not.toBe("threw")
		expect(await (res as Response).json()).toEqual({ tier: "gold" })
	})

	// regression: NEW-H WS route middleware order
	it("NEW-H ws-order: WS routes run chain before scoped middleware", async () => {
		const trace: string[] = []
		const adapter = {
			upgrade() {
				const response = new Response(null, { status: 200 })
				Object.defineProperty(response, "status", { value: 101 })
				return { response, socket: { close() {}, raw: {}, readyState: 1, send() {} } as never }
			},
		}
		const app = honey().wsAdapter(adapter as never)
		app.use("/rooms", tracer(trace, "scoped"))
		app.use(tracer(trace, "chain")).ws("/rooms/:id").handler({})
		await send(app, "/rooms/1", { headers: { connection: "Upgrade", upgrade: "websocket" } })
		expect(trace).toEqual(["chain", "scoped"])
	})

	// regression: M default error keys aliased by internal routes
	it("M-default-keys: a scoped middleware's errors never leak into unrelated routes' documented errors", async () => {
		const errors = defineErrors({ blocked: "forbidden", teapot: "bad_request" })
		const block = defineMiddleware({
			errors: [errors, "blocked"],
			fn: async (_c, next) => next(),
		})
		const app = honey().errorFactory(errors).defaultErrors("teapot")
		app.openapi({ path: "/openapi", title: "t", version: "1" })
		/* the scope covers the internal spec routes, whose error set was the shared default set */
		app.use("/openapi.json", block)
		app.use("/admin", block)
		app.get("/admin/x").handler((c) => c.res.json("ok", {}))
		app.get("/public").handler((c) => c.res.json("ok", {}))
		const res = await send(app, "/openapi.json")
		expect(res).not.toBe("threw")
		const doc = (await (res as Response).json()) as {
			paths: Record<string, { get?: { responses?: Record<string, unknown> } }>
		}
		expect(Object.keys(doc.paths["/admin/x"]?.get?.responses ?? {})).toContain("403")
		expect(Object.keys(doc.paths["/public"]?.get?.responses ?? {})).not.toContain("403")
	})

	// regression: M (perf) route() re-walks the whole tree per scoped entry per mount
	it("M-mount-perf: mounting 200 sub-apps under scoped middleware with meta stays fast", async () => {
		const errors = defineErrors({ blocked: "forbidden" })
		const scoped = defineMiddleware({
			errors: [errors, "blocked"],
			fn: async (_c, next) => next(),
			meta: { area: "admin" },
		})
		const started = performance.now()
		const parent = honey().errorFactory(errors)
		for (let i = 0; i < 200; i++) {
			const sub = honey().errorFactory(errors)
			sub.use(`/s/${i}`, scoped)
			for (let r = 0; r < 5; r++) sub.get(`/s/${i}/r${r}`).handler((c) => c.res.json("ok", {}))
			parent.route(sub)
		}
		expect(await status(parent, "/s/199/r4")).toBe(200)
		expect(performance.now() - started).toBeLessThan(3_000)
	}, 30_000)

	// regression: L reserved ctx keys
	it("L-reserved: context() with a framework key is rejected at registration, not per request", () => {
		expect(() => honey().context({ searchAll: 1 } as never)).toThrow()
		expect(() => honey().context({ path: "/x" } as never)).toThrow()
	})

	// regression: L unknown status key
	it("L-status-key: an unknown status key never answers 200", async () => {
		const app = honey()
		app.get("/e").handler(() => {
			throw new HoneyError({ errorKey: "weird", status: "not_a_status" as never })
		})
		expect(await status(app, "/e")).not.toBe(200)
	})

	// regression: L RouteBuilder without handler
	it("L-no-handler: a route builder without .handler() is reported", async () => {
		const app = honey()
		app.get("/forgot")
		app.get("/ok").handler((c) => c.res.json("ok", {}))
		expect(await status(app, "/ok")).toBe("threw")
	})

	// regression: L telemetry onResponse once
	it("L-telemetry: onResponse fires once for a handler-thrown error", async () => {
		let calls = 0
		const app = honey().telemetry({ onResponse: () => void calls++ })
		app.get("/boom").handler(() => {
			throw new Error("boom")
		})
		await status(app, "/boom")
		expect(calls).toBe(1)
	})
})
