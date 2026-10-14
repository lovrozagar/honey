/**
 * Middleware is resolved once, at finalize. What a route runs is fixed by how it was registered and
 * mounted, never by which handle serves the request.
 */
import { describe, expect, it } from "vitest"
import { HoneyError } from "../errors/error.ts"
import { defineErrors } from "../errors/errors.ts"
import { createMiddleware, defineMiddleware } from "../middleware/middleware.ts"
import { GRAPH, type Honey, honey } from "./app.ts"
import { finalTable } from "./dispatch.ts"

type App = Honey<{}>
const req = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init)
const deny = createMiddleware(async () => new Response("denied", { status: 401 }))
const planOf = (app: App, id: string) => finalTable(app[GRAPH]).plans.get(id)

/** A middleware that records its name in `trace` and passes through. */
function tracer(trace: string[], name: string) {
	return createMiddleware(async (_ctx, next) => {
		trace.push(name)
		return next()
	})
}

type Built = { derived: App; root: App }

/**
 * One app shape (chain `A`, scope `/s` → `S`, route middleware `R` on `GET /s/x`) built several
 * ways. Each returns the root handle and a derived handle of the same graph. The loaded-tree
 * shapes join with `routeTree()`.
 */
const shapes: Record<string, (trace: string[]) => Built> = {
	"mounted sub": (trace) => {
		const sub = honey<{}>()
		sub.use("/s", tracer(trace, "S"))
		sub
			.get("/s/x")
			.use(tracer(trace, "R"))
			.handler((ctx) => ctx.res.text("ok", "x"))
		const root = honey<{}>() as App
		const withA = root.use(tracer(trace, "A"))
		withA.route(sub)
		return { derived: withA as unknown as App, root }
	},
	"nested mount": (trace) => {
		const leaf = honey<{}>()
		leaf
			.get("/s/x")
			.use(tracer(trace, "R"))
			.handler((ctx) => ctx.res.text("ok", "x"))
		const mid = honey<{}>()
		mid.use("/s", tracer(trace, "S"))
		mid.route(leaf)
		const root = honey<{}>() as App
		const withA = root.use(tracer(trace, "A"))
		withA.route(mid)
		return { derived: withA as unknown as App, root }
	},
	"own route": (trace) => {
		const root = honey<{}>() as App
		root.use("/s", tracer(trace, "S"))
		root
			.use(tracer(trace, "A"))
			.get("/s/x")
			.use(tracer(trace, "R"))
			.handler((ctx) => ctx.res.text("ok", "x"))
		return { derived: root.context({ v: 1 }) as unknown as App, root }
	},
}

describe("one ordered chain: chain → scoped → route, wherever the route came from", () => {
	for (const [shape, build] of Object.entries(shapes)) {
		for (const via of ["root", "derived"] as const) {
			// v0: 011a881469
			it(`${shape}, served from the ${via} handle`, async () => {
				const trace: string[] = []
				const res = await build(trace)[via].fetch(req("/s/x"), {})
				expect(res.status).toBe(200)
				expect(trace).toEqual(["A", "S", "R"])
			})
		}
	}

	// v0: bbc48a775c
	it("every shape and handle answers the same, request after request", async () => {
		for (const build of Object.values(shapes)) {
			const trace: string[] = []
			const { derived, root } = build(trace)
			await derived.fetch(req("/s/x"), {})
			await root.fetch(req("/s/x"), {})
			await derived.fetch(req("/s/x"), {})
			expect(trace).toEqual(["A", "S", "R", "A", "S", "R", "A", "S", "R"])
		}
	})
})

describe("what a route runs does not depend on the serving handle", () => {
	// v0: 820f1ff057
	it("H10: serving the sub first does not leak its chain into the parent (or back)", async () => {
		const sub = honey<{}>()
		sub.get("/data").handler((ctx) => ctx.res.text("ok", "data"))
		expect((await sub.fetch(req("/data"), {})).status).toBe(200)
		const parent = honey<{}>().use(deny).route(sub)
		expect((await parent.fetch(req("/data"), {})).status).toBe(401)
		expect((await sub.fetch(req("/data"), {})).status).toBe(200)
	})

	// v0: a14d999e54
	// v0: 2703ec4026
	it("H11: routes mounted on a chain run the chain, like routes registered on it", async () => {
		const app = honey<{}>()
		const authed = app.use(deny)
		authed.get("/me").handler((ctx) => ctx.res.text("ok", "me"))
		const admin = honey<{}>()
		admin.get("/admin/users").handler((ctx) => ctx.res.text("ok", "users"))
		authed.route(admin)
		expect((await app.fetch(req("/me"), {})).status).toBe(401)
		expect((await app.fetch(req("/admin/users"), {})).status).toBe(401)
		expect((await authed.fetch(req("/admin/users"), {})).status).toBe(401)
	})

	// v0: d01db977f4
	it("H13: chain middleware runs before scoped middleware on mounted routes", async () => {
		const sub = honey<{}>()
		const requireAdmin = createMiddleware(async (ctx, next) => {
			if (!(ctx as { user?: { admin: boolean } }).user?.admin) return new Response("no user", { status: 403 })
			return next()
		})
		sub.use("/admin", requireAdmin)
		sub.get("/admin/x").handler((ctx) => ctx.res.text("ok", "x"))
		const auth = createMiddleware(async (_ctx, next) => next({ user: { admin: true } }))
		/* v0's types reject mounting a sub whose ctx lacks the mounting chain's additions (v0 never typechecked its runtime tests) */
		const app = honey<{}>()
			.use(auth)
			.route(sub as never)
		expect((await app.fetch(req("/admin/x"), {})).status).toBe(200)
	})

	// v0: d97e94f78d
	it("H15: a route registered before a later use() runs its chain once and not the later middleware", async () => {
		const trace: string[] = []
		const withA = honey<{}>().use(tracer(trace, "a"))
		withA.get("/public").handler((ctx) => ctx.res.text("ok", "p"))
		const withB = withA.use(tracer(trace, "b"))
		withB.get("/private").handler((ctx) => ctx.res.text("ok", "x"))
		await withB.fetch(req("/public"), {})
		expect(trace).toEqual(["a"])
		trace.length = 0
		await withB.fetch(req("/private"), {})
		expect(trace).toEqual(["a", "b"])
	})
})

describe("scopes guard request paths, in the route grammar", () => {
	// v0: dc49c78613
	it("a scope covers a root wildcard route for paths inside it, not outside", async () => {
		const app = honey<{}>()
		app.use("/admin", deny)
		app.all("/*").handler((ctx) => ctx.res.text("ok", "spa"))
		expect((await app.fetch(req("/admin/secret"), {})).status).toBe(401)
		expect((await app.fetch(req("/admin"), {})).status).toBe(401)
		expect((await app.fetch(req("/home"), {})).status).toBe(200)
		expect((await app.fetch(req("/administrator"), {})).status).toBe(200)
	})

	// v0: 6ef51d3042
	it("a scope covers a param route when the param lands on the scoped literal", async () => {
		const app = honey<{}>()
		app.use("/admin", deny)
		app.get("/:section/users").handler((ctx) => ctx.res.text("ok", ctx.params.section))
		expect((await app.fetch(req("/admin/users"), {})).status).toBe(401)
		expect((await app.fetch(req("/%61dmin/users"), {})).status).toBe(401)
		expect((await app.fetch(req("//admin/users"), {})).status).toBe(401)
		expect((await app.fetch(req("/blog/users"), {})).status).toBe(200)
	})

	// v0: 56ad4e8c97
	it("`/admin/*` scopes everything under /admin", async () => {
		const app = honey<{}>()
		app.use("/admin/*", deny)
		app.get("/admin").handler((ctx) => ctx.res.text("ok", "a"))
		app.get("/admin/x/y").handler((ctx) => ctx.res.text("ok", "b"))
		expect((await app.fetch(req("/admin"), {})).status).toBe(401)
		expect((await app.fetch(req("/admin/x/y"), {})).status).toBe(401)
	})

	// v0: a4d7e16dd6
	it("`/orgs/:id` scopes `/orgs/:orgId/members` whatever the param is called", async () => {
		const app = honey<{}>()
		app.use("/orgs/:id", deny)
		app.get("/orgs/:orgId/members").handler((ctx) => ctx.res.text("ok", "m"))
		expect((await app.fetch(req("/orgs/7/members"), {})).status).toBe(401)
	})

	// v0: 8fe7c7a1a7
	it("a scope string the grammar cannot express is rejected", () => {
		expect(() => honey<{}>().use("/a/../b", deny)).toThrow(/Invalid route pattern/)
		expect(() => honey<{}>().use("/*/x", deny)).toThrow(/Invalid route pattern/)
	})

	// v0: f0eb899251
	it("a scope registered after a route still guards it, from any handle", async () => {
		const app = honey<{}>()
		const v1 = app.basePath("/v1")
		v1.get("/admin/x").handler((ctx) => ctx.res.text("ok", "x"))
		app.use("/v1/admin", deny)
		expect((await v1.fetch(req("/v1/admin/x"), {})).status).toBe(401)
	})
})

const forbidden = () => new HoneyError({ errorKey: "forbidden", status: "forbidden" })

describe("errors thrown inside the chain still pass through outer middleware", () => {
	const stamp = createMiddleware(async (_ctx, next) => {
		const res = await next()
		const out = new Response(res.body, res)
		out.headers.set("x-outer", "1")
		return out
	})

	// v0: 97c30049be
	it("a middleware throw reaches outer post-next() code as a response", async () => {
		const failing = createMiddleware(async () => {
			throw forbidden()
		})
		const app = honey<{}>().use(stamp).use(failing)
		app.get("/x").handler((ctx) => ctx.res.text("ok", "x"))
		const res = await app.fetch(req("/x"), {})
		expect(res.status).toBe(403)
		expect(res.headers.get("x-outer")).toBe("1")
	})

	// v0: 30a86b5632
	// v0: d551a5be83
	it("the 404 and 405 pipelines convert errors the same way", async () => {
		const failing = createMiddleware(async (ctx, next) => {
			if ((ctx as { path: string }).path.startsWith("/locked")) throw forbidden()
			return next()
		})
		const app = honey<{}>().use(stamp).use(failing)
		app.get("/x").handler((ctx) => ctx.res.text("ok", "x"))
		const res = await app.fetch(req("/locked/missing"), {})
		expect(res.status).toBe(403)
		expect(res.headers.get("x-outer")).toBe("1")
	})
})

describe("404, 405 and preflight run through the same pipeline", () => {
	const errors = defineErrors({ unauthorized: "unauthorized" })

	// v0: c132211504
	it("H14: ctx.errors and ctx.path exist on unknown paths", async () => {
		const seen: string[] = []
		const auth = createMiddleware(async (ctx, next) => {
			seen.push((ctx as { path: string }).path)
			if (!(ctx as { headers: Record<string, string> }).headers.authorization) {
				throw (ctx as unknown as { errors: typeof errors }).errors.unauthorized()
			}
			return next()
		})
		const app = honey<{}>().errorFactory(errors).use(auth)
		app.get("/x").handler((ctx) => ctx.res.text("ok", "x"))
		expect((await app.fetch(req("/nope"), {})).status).toBe(401)
		expect((await app.fetch(req("/x", { method: "POST" }), {})).status).toBe(401)
		expect(seen).toEqual(["/nope", "/x"])
	})

	// v0: 584faecc44
	it("the app-wide chain runs exactly once on 404 and 405, whichever handle serves", async () => {
		const trace: string[] = []
		const root = honey<{}>()
		const app = root.use(tracer(trace, "log"))
		app.get("/x").handler((ctx) => ctx.res.text("ok", "x"))
		for (const handle of [root, app]) {
			trace.length = 0
			expect((await handle.fetch(req("/missing"), {})).status).toBe(404)
			expect((await handle.fetch(req("/x", { method: "DELETE" }), {})).status).toBe(405)
			expect(trace).toEqual(["log", "log"])
		}
	})

	// v0: 1fcfb7a44d
	it("a preflight nothing answers runs the chain once and returns the 405", async () => {
		const trace: string[] = []
		const app = honey<{}>().use(tracer(trace, "a"))
		app.get("/x").handler((ctx) => ctx.res.text("ok", "x"))
		const res = await app.fetch(
			req("/x", { headers: { "access-control-request-method": "GET" }, method: "OPTIONS" }),
			{},
		)
		expect(res.status).toBe(405)
		expect(trace).toEqual(["a"])
	})
})

describe("errors and meta come from the chain that runs", () => {
	const errors = defineErrors({ forbidden: "forbidden", gone: "gone", nope: "bad_request" })

	// v0: 8d2d900785
	it("defaultErrors applies to routes registered before the call", () => {
		const scopedGuard = defineMiddleware({ errors: [errors, "nope"], fn: async (_c, next) => next() })
		const app = honey<{}>().errorFactory(errors)
		app.get("/early").handler((ctx) => ctx.res.text("ok", "x"))
		app.defaultErrors("gone")
		app.use("/admin", scopedGuard)
		app.get("/admin/x").handler((ctx) => ctx.res.text("ok", "x"))
		app.get("/later").handler((ctx) => ctx.res.text("ok", "x"))
		const declared = (id: string) => [...(planOf(app as App, id)?.policy.declared ?? [])].sort()
		expect(declared("GET /early")).toEqual(["gone"])
		expect(declared("GET /admin/x")).toEqual(["gone", "nope"])
		expect(declared("GET /later")).toEqual(["gone"])
	})

	// v0: 43e2b5b027
	it("mounted routes keep their own error factory and context values", async () => {
		const subErrors = defineErrors({ sub_failed: "conflict" })
		const sub = honey<{}>().errorFactory(subErrors).context({ tenant: "sub" })
		sub
			.get("/sub")
			.errors("sub_failed")
			.handler((ctx) => {
				if (ctx.tenant !== "sub") return ctx.res.text("ok", "wrong")
				throw ctx.errors.sub_failed()
			})
		const app = honey<{}>().errorFactory(errors).route(sub)
		expect((await app.fetch(req("/sub"), {})).status).toBe(409)
		expect(planOf(app as App, "GET /sub")?.policy.factory).toBe(subErrors)
	})

	// v0: 8bd49ebdaa
	// v0: 1f6f240192
	it("contributed meta merges in run order and explicit meta wins; mounted routes get it too", async () => {
		const a = createMiddleware(async (_c, next) => next(), { meta: { owner: "chain", tier: 1 } })
		const s = createMiddleware(async (_c, next) => next(), { meta: { tier: 2 } })
		const sub = honey<{}>().meta<{ owner: string }>()
		sub
			.get("/s/x")
			.meta({ owner: "route" })
			.handler((ctx) => ctx.res.json("ok", { meta: ctx.meta }))
		const app = honey<{}>()
		app.use("/s", s)
		app.use(a).route(sub)
		const plan = planOf(app as App, "GET /s/x")
		expect(plan?.route.meta).toEqual({ owner: "route", tier: 2 })
		expect(plan?.pfChain).toHaveLength(2)
		/* the handler reads the same merged meta at runtime */
		expect(await (await app.fetch(req("/s/x"), {})).json()).toEqual({ meta: { owner: "route", tier: 2 } })
	})
})

describe("finalize reports middleware and routes that would silently be missing", () => {
	// v0: 2a10e94a81
	it("app.use(mw) as a bare statement is an error, not an unprotected route", () => {
		const app = honey<{}>()
		app.use(deny)
		app.get("/secret").handler((ctx) => ctx.res.text("ok", "secret"))
		expect(() => app.fetch(req("/secret"), {})).toThrow(/returned a handle that never registers a route/)
	})

	// v0: 83faeb8b0e
	it("a route builder without .handler() is an error", () => {
		const app = honey<{}>()
		app.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		app.get("/forgotten")
		expect(() => app.fetch(req("/a"), {})).toThrow(/GET \/forgotten was declared but never got a \.handler\(\)/)
	})

	// v0: 58ed2ebb98
	it("a chain used only through a derived handle counts as used", async () => {
		const app = honey<{}>()
		app
			.use(deny)
			.basePath("/v1")
			.get("/x")
			.handler((ctx) => ctx.res.text("ok", "x"))
		expect((await app.fetch(req("/v1/x"), {})).status).toBe(401)
	})
})

describe("ctx.errors holds the declared keys the factory has", () => {
	it("a declared key the factory lacks is left out of ctx.errors", async () => {
		const errors = defineErrors({ gone: "gone" })
		const foreign = defineMiddleware({ errors: [{ elsewhere: () => null }, "elsewhere"], fn: (_c, next) => next() })
		const app = honey<{}>().errorFactory(errors)
		app
			.get("/e")
			.use(foreign)
			.errors("gone")
			.handler((ctx) => ctx.res.json("ok", Object.keys(ctx.errors)))
		expect(await (await app.fetch(req("/e"), {})).json()).toEqual(["gone"])
	})
})

describe("finalize compiles once per registration epoch", () => {
	it("runs once, and again only when a registration moved the graph", async () => {
		const app = honey<{}>()
		app.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		const first = finalTable(app[GRAPH])
		expect(finalTable(app[GRAPH])).toBe(first)
		app.get("/b").handler((ctx) => ctx.res.text("ok", "b"))
		const second = finalTable(app[GRAPH])
		expect(second).not.toBe(first)
		expect((await app.fetch(req("/b"), {})).status).toBe(200)
	})

	// v0: d65278f417
	it("keeps static patterns in a method → path map; an optional param places both paths", () => {
		const app = honey<{}>()
		app.get("/users/:id?").handler((ctx) => ctx.res.text("ok", "u"))
		app.post("/users").handler((ctx) => ctx.res.text("ok", "u"))
		app.get("/items/:id").handler((ctx) => ctx.res.text("ok", "i"))
		app.get("/files/*rest").handler((ctx) => ctx.res.text("ok", "f"))
		const { plans, statics } = finalTable(app[GRAPH])
		expect(Object.keys(statics).sort()).toEqual(["GET", "POST"])
		expect(Object.keys(statics.GET ?? {})).toEqual(["/users"])
		expect(statics.GET?.["/users"]).toBe(plans.get("GET /users/:id?"))
		expect(statics.POST?.["/users"]).toBe(plans.get("POST /users"))
	})
})

describe("the statics table: literal routes without the tree", () => {
	// v0: 056c5b5067
	// v0: 3bd187b5a9
	// v0: 34caa430ed
	// v0: 1af0b5e4c6
	// v0: 031efcf0eb
	it("literal routes answer from the table, the rest from the tree, alike to every method", async () => {
		const sub = honey<{}>()
		sub.get("/mounted").handler((ctx) => ctx.res.text("ok", "mounted"))
		const app = honey<{}>()
		app.get("/json").handler((ctx) => ctx.res.json("ok", { static: true }))
		app.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		app.post("/a").handler((ctx) => ctx.res.text("ok", "a-post"))
		app.get("/b").handler((ctx) => ctx.res.text("ok", "b"))
		app.get("/users/:id").handler((ctx) => ctx.res.text("ok", ctx.params.id))
		app.all("/catch").handler((ctx) => ctx.res.text("ok", ctx.req.method))
		app.route(sub)
		const { statics } = finalTable(app[GRAPH])
		expect([Object.keys(statics.GET ?? {}).sort(), Object.keys(statics.POST ?? {})]).toEqual([
			["/a", "/b", "/json", "/mounted"],
			["/a"],
		])
		const answers = []
		for (const [method, path] of [
			["GET", "/json"],
			["GET", "/a"],
			["POST", "/a"],
			["GET", "/b"],
			["GET", "/users/42"],
			["GET", "/catch"],
			["PATCH", "/catch"],
			["GET", "/mounted"],
		] as const) {
			const res = await app.fetch(req(path, { method }), {})
			answers.push([method, path, res.status, await res.text()])
		}
		/* HEAD reaches a literal GET route through the same table */
		const head = await app.fetch(req("/b", { method: "HEAD" }), {})
		expect([head.status, head.headers.get("content-type")]).toEqual([200, "text/plain; charset=utf-8"])
		expect(answers).toEqual([
			["GET", "/json", 200, '{"static":true}'],
			["GET", "/a", 200, "a"],
			["POST", "/a", 200, "a-post"],
			["GET", "/b", 200, "b"],
			["GET", "/users/42", 200, "42"],
			["GET", "/catch", 200, "GET"],
			["PATCH", "/catch", 200, "PATCH"],
			["GET", "/mounted", 200, "mounted"],
		])
	})
})
