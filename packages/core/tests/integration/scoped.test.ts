/**
 * Scoped middleware, use(path, mw): which request paths a scope covers, the order scopes run in
 * beside the chain, what scoped middleware sees and answers, scopes on unknown paths and wrong
 * methods, scoped errors, and scopes across mounts, basePath, stripPrefix and derived handles.
 */
import { describe, expect, it } from "vitest"
import { defineErrors } from "../../src/errors/errors.ts"
import { createMiddleware, defineMiddleware } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"

type Fetchable = { fetch: (r: Request, env: never) => Response | Promise<Response> }

async function send(app: Fetchable, target: string, method = "GET") {
	const res = await app.fetch(new Request(`http://localhost${target}`, { method }), {} as never)
	return { body: await res.text(), status: res.status }
}

/** A middleware that records `name` each time it runs. */
const tracer = (trace: string[], name: string) =>
	createMiddleware((_ctx, next) => {
		trace.push(name)
		return next()
	})

const deny = createMiddleware(() => new Response("blocked", { status: 403 }))

type App = ReturnType<typeof honey<{}>>

/** A route answering with the path it served. */
const echo = (app: App, path: string) => app.get(path).handler((ctx) => ctx.res.text("ok", ctx.path))

describe("which paths a scope covers", () => {
	// v0: aecbb17f6a
	// v0: c671ed62e8
	// v0: 9350e6dede
	// v0: 88298f79e7
	// v0: 6ed262f729
	// v0: 724cfa075e
	// v0: 99debdca5c
	// v0: 3169940e2c
	// v0: 45fd793813
	it.each([
		["/admin", "/admin/x", ["scope"]],
		["/admin", "/admin", ["scope"]],
		["/admin", "/admin/", ["scope"]],
		["/admin", "/administration", []],
		["/admin", "/public", []],
		["/admin/", "/admin/x", ["scope"]],
		["/", "/public", ["scope"]],
		["/", "/admin/x", ["scope"]],
	])("use(%j) on %s runs %j", async (scope, target, ran) => {
		const trace: string[] = []
		const app = honey<{}>()
		const scoped = app.use(scope, tracer(trace, "scope"))
		for (const path of ["/admin", "/admin/x"]) echo(scoped, path)
		for (const path of ["/administration", "/public"]) echo(app, path)
		expect(await send(app, target)).toEqual({ body: target, status: 200 })
		expect(trace).toEqual(ran)
	})
})

describe("scope order, and what scoped middleware sees and answers", () => {
	// v0: ea801fbcf4
	// v0: 95e30b15b8
	// v0: fc47d0719b
	it("chain middleware runs first, then every covering scope in declaration order", async () => {
		const trace: string[] = []
		const app = honey<{}>()
		const handle = app
			.use("/admin", tracer(trace, "a"))
			.use("/admin/billing", tracer(trace, "b"))
			.use(tracer(trace, "chain"))
			.use("/admin", tracer(trace, "c"))
		echo(handle, "/admin/billing/invoices")
		echo(handle, "/public")
		expect(await send(app, "/admin/billing/invoices")).toEqual({ body: "/admin/billing/invoices", status: 200 })
		expect(trace).toEqual(["chain", "a", "b", "c"])
		trace.length = 0
		expect((await send(app, "/public")).status).toBe(200)
		expect(trace).toEqual(["chain"])
	})

	// v0: f30fcde369
	// v0: b650e4fa13
	it("scoped middleware sees the chain's additions, and its own reach the handler", async () => {
		const app = honey<{}>()
			.use(createMiddleware((_ctx, next) => next({ db: "connected" })))
			.use(
				"/admin",
				createMiddleware((ctx: { db: string }, next) => next({ adminOnly: "yes", sawDb: ctx.db })),
			)
		app.get("/admin/x").handler((ctx) => ctx.res.json("ok", { adminOnly: ctx.adminOnly, sawDb: ctx.sawDb }))
		const res = await app.fetch(new Request("http://localhost/admin/x"), {})
		expect([res.status, await res.json()]).toEqual([200, { adminOnly: "yes", sawDb: "connected" }])
	})

	// v0: f9ad0fdb43
	// v0: 421223b0c8
	it("a scope that answers without next() is the answer on paths it covers, and nowhere else", async () => {
		const handled: string[] = []
		const app = honey<{}>()
		const guarded = app.use("/admin", deny)
		for (const path of ["/admin/x", "/public"])
			guarded.get(path).handler((ctx) => {
				handled.push(path)
				return ctx.res.text("ok", path)
			})
		expect(await send(app, "/admin/x")).toEqual({ body: "blocked", status: 403 })
		expect(await send(app, "/public")).toEqual({ body: "/public", status: 200 })
		expect(handled).toEqual(["/public"])
	})
})

describe("scopes on unknown paths and wrong methods", () => {
	// v0: 761b799e2f
	// v0: 99cf4ec591
	it.each([
		["/admin/missing", "GET", 404, ["scope"]],
		["/elsewhere", "GET", 404, []],
		["/admin/x", "POST", 405, ["scope"]],
	])("%s %s answers %i after running %j", async (target, method, status, ran) => {
		const trace: string[] = []
		const app = honey<{}>()
		echo(app.use("/admin", tracer(trace, "scope")), "/admin/x")
		expect((await send(app, target, method)).status).toBe(status)
		expect(trace).toEqual(ran)
	})

	// v0: a0fcac9713
	it("a scope's declared errors reach the routes it covers, and only those", async () => {
		const errors = defineErrors({ admin_only: "forbidden", internal_server_error: "internal_server_error" })
		const declares = defineMiddleware({ errors: [errors, "admin_only"], fn: (_ctx, next) => next() })
		const app = honey<{}>().errorFactory(errors).defaultBoundary("internal_server_error").use("/admin", declares)
		for (const path of ["/admin/x", "/public"])
			app.get(path).handler(() => {
				throw errors.admin_only()
			})
		expect((await send(app, "/admin/x")).status).toBe(403)
		expect((await send(app, "/public")).status).toBe(500)
	})
})

describe("scopes across mounts, basePath, stripPrefix and handles", () => {
	// v0: 71452507d9
	// v0: 8555d22887
	// v0: 7503aae4ae
	// v0: f0c542ebbb
	// v0: abbbaf02f4
	it("a mounted route runs the parent's scopes and the sub's in declaration order, the sub's joining at the mount", async () => {
		const trace: string[] = []
		const sub = honey<{}>()
		echo(sub.use("/admin", tracer(trace, "sub")), "/admin/y")
		const app = honey<{}>()
		app.use("/admin", tracer(trace, "parent")).route(sub)
		app.use("/admin", tracer(trace, "late"))
		echo(app, "/public")
		expect(await send(app, "/admin/y")).toEqual({ body: "/admin/y", status: 200 })
		expect(trace).toEqual(["parent", "sub", "late"])
		trace.length = 0
		expect((await send(app, "/public")).status).toBe(200)
		expect(trace).toEqual([])
	})

	// v0: 6e1fc8ee53
	// v0: 7a37077351
	it("a scope's path is relative to the handle it is registered on", async () => {
		const trace: string[] = []
		const underApi = honey<{}>()
		underApi
			.basePath("/api")
			.use("/admin", tracer(trace, "under-api"))
			.get("/admin/x")
			.handler((ctx) => ctx.res.text("ok", ctx.path))
		const atRoot = honey<{}>()
		atRoot
			.use("/admin", tracer(trace, "at-root"))
			.basePath("/api")
			.get("/admin/x")
			.handler((ctx) => ctx.res.text("ok", ctx.path))
		for (const app of [underApi, atRoot])
			expect(await send(app, "/api/admin/x")).toEqual({ body: "/api/admin/x", status: 200 })
		expect(trace).toEqual(["under-api"])
	})

	// v0: 51d56ad52a
	// v0: eac6e1e6e9
	it("scopes match after stripPrefix, and a handle derived with context() keeps them", async () => {
		const trace: string[] = []
		const app = honey<{}>().stripPrefix("/app")
		app
			.use("/admin", tracer(trace, "scope"))
			.context({ foo: 1 })
			.get("/admin/x")
			.handler((ctx) => ctx.res.text("ok", `${ctx.path} ${ctx.foo}`))
		expect(await send(app, "/app/admin/x")).toEqual({ body: "/admin/x 1", status: 200 })
		expect(trace).toEqual(["scope"])
	})
})
