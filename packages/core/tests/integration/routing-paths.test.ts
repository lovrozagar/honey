/**
 * Request paths through `app.fetch`: how a path is spelled, dot segments and encoded slashes, and
 * the path ctx and scopes see. Every case asserts the whole answer.
 */ import { describe, expect, it } from "vitest"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { type Honey, honey } from "../../src/routing/app.ts"
import type { HttpMethod } from "../../src/routing/types.ts"

type App = Honey<{}>
type Echo = { method: string; params: Record<string, string>; path: string; pattern: string }

/** An app whose routes answer with the method, params, ctx.path and pattern they saw. */
function echoApp(routes: ReadonlyArray<readonly [HttpMethod | "ALL", string]>): App {
	const app = honey<{}>()
	for (const [method, pattern] of routes) {
		app
			.on([method], pattern)
			.handler((ctx) =>
				ctx.res.json("ok", { method: ctx.req.method, params: ctx.params, path: ctx.path, pattern: ctx.routePattern }),
			)
	}
	return app
}

async function send(app: App, target: string, init?: RequestInit) {
	const res = await app.fetch(new Request(`http://localhost${target}`, init), {})
	return { allow: res.headers.get("allow"), body: await res.text(), status: res.status }
}

async function echo(app: App, target: string, init?: RequestInit): Promise<Echo> {
	const res = await send(app, target, init)
	expect(res.status, `${init?.method ?? "GET"} ${target}`).toBe(200)
	return JSON.parse(res.body) as Echo
}

const requireAuth = createMiddleware((ctx, next) =>
	(ctx as { req: Request }).req.headers.get("authorization") === "ok" ? next() : new Response("no", { status: 401 }),
)

/** A scope on /admin that wants an authorization header, over a literal and a wildcard route. */
function guardedApp(app: App = honey<{}>()): App {
	app.use("/admin", requireAuth)
	app.get("/admin/secret").handler((ctx) => ctx.res.json("ok", { path: ctx.path, pattern: ctx.routePattern }))
	app.get("/files/*rest").handler((ctx) => ctx.res.json("ok", { path: ctx.path, rest: ctx.params.rest }))
	return app
}

describe("request path normalization: how the path is spelled", () => {
	// v0: 98baced32e
	// v0: faccadd062
	// v0: 8884c869d8
	// v0: eeaca59f7f
	it.each([
		["http://localhost/docs", "/docs"],
		["http://localhost//docs", "/docs"],
		["http://localhost/docs?x=1#frag", "/docs"],
		["http://localhost:8080/docs", "/docs"],
		["http://localhost/docs/", "/docs/"],
	])("%s reaches /docs with ctx.path %s", async (url, path) => {
		const app = echoApp([["GET", "/docs"]])
		const res = await app.fetch(new Request(url), {})
		expect([res.status, await res.json()]).toEqual([200, { method: "GET", params: {}, path, pattern: "/docs" }])
	})

	// v0: 14c341508e
	// v0: 609319e1ab
	// v0: 50a9734c31
	// v0: 848e7b45f9
	it("the root route is / however it is registered or requested", async () => {
		const app = honey<{}>()
		app.get("").handler((ctx) => ctx.res.json("ok", { path: ctx.path, pattern: ctx.routePattern }))
		for (const url of ["http://localhost", "http://localhost/"]) {
			expect(await (await app.fetch(new Request(url), {})).json()).toEqual({ path: "/", pattern: "/" })
		}
		expect(() => app.get("/").handler((ctx) => ctx.res.text("ok", "again"))).toThrow("Duplicate route: GET /")
	})
})

describe("request path normalization: dot segments, encoded slashes and scopes", () => {
	// v0: b8530d8cc2
	// v0: dd21469798
	it("the scope guard, ctx.path and the route all see one normalized path", async () => {
		const app = guardedApp()
		expect((await send(app, "//admin/secret")).status).toBe(401)
		const ok = await send(app, "//admin/secret", { headers: { authorization: "ok" } })
		expect([ok.status, JSON.parse(ok.body)]).toEqual([200, { path: "/admin/secret", pattern: "/admin/secret" }])
	})

	// v0: 860d347581
	// v0: f14bd5e990
	it("dot segments resolve before routing and scopes, encoded or not", async () => {
		const raw = new Request("http://localhost/")
		Object.defineProperty(raw, "url", { value: "http://localhost/files/a/../../admin/secret" })
		expect((await guardedApp().fetch(raw, {})).status).toBe(401)
		const app = echoApp([
			["GET", "/files/:id"],
			["GET", "/etc"],
		])
		expect(await echo(app, "/files/%2e%2e/etc")).toMatchObject({ path: "/etc", pattern: "/etc" })
	})

	// v0: 5893ed7b81
	// v0: 4df2cd8ea8
	// v0: 6a604d84d5
	// v0: 6927ae9908
	// v0: 37e860ba5a
	it("an encoded slash is 400 before any middleware, unless allowed: then it decodes into the param", async () => {
		const seen: string[] = []
		/* the watcher wraps every route, so it would see any request that got past normalization */
		const watched = guardedApp(
			honey<{}>().use(
				createMiddleware((ctx, next) => {
					seen.push((ctx as { path: string }).path)
					return next()
				}),
			) as App,
		)
		expect((await send(watched, "/files/x")).status).toBe(200)
		expect(seen).toEqual(["/files/x"])
		seen.length = 0
		for (const target of ["/files/..%2fadmin%2fsecret", `/files/${encodeURIComponent("../etc/passwd")}`]) {
			const res = await send(watched, target)
			expect([res.status, (JSON.parse(res.body) as { error_key: string }).error_key]).toEqual([400, "bad_request"])
		}
		expect(seen).toEqual([])
		const allowed = guardedApp().encodedSlashes("allow")
		const res = await send(allowed, "/files/a%2Fb")
		expect([res.status, JSON.parse(res.body)]).toEqual([200, { path: "/files/a%2Fb", rest: "a/b" }])
	})
})

describe("request path normalization: ctx.path and patterns", () => {
	// v0: 79fcd571fd
	it.each([
		["/api/", "/admin/x"],
		["api", "/admin/x"],
		["/api", "admin/x"],
		["/api", "//admin/x"],
	])("basePath(%j) + get(%j) is /api/admin/x, guarded by a root scope there", async (base, route) => {
		const root = honey<{}>()
		root.use("/api/admin", requireAuth)
		root
			.basePath(base)
			.get(route)
			.handler((ctx) => ctx.res.json("ok", { pattern: ctx.routePattern }))
		expect((await send(root, "/api/admin/x")).status).toBe(401)
		const ok = await send(root, "/api/admin/x", { headers: { authorization: "ok" } })
		expect(JSON.parse(ok.body)).toEqual({ pattern: "/api/admin/x" })
	})

	// v0: b7dd87de75
	// v0: 6c8ea866ea
	// v0: 83662f41a0
	it("ctx.path is the request path and ctx.routePattern the full pattern, basePath included", async () => {
		const app = honey<{}>()
		app.get("/a/b/c/d/e/f/g/h/i/j").handler((ctx) => ctx.res.json("ok", { path: ctx.path, pattern: ctx.routePattern }))
		app
			.basePath("/v1")
			.get("/users/:id")
			.handler((ctx) => ctx.res.json("ok", { path: ctx.path, pattern: ctx.routePattern }))
		expect(JSON.parse((await send(app, "/a/b/c/d/e/f/g/h/i/j")).body)).toEqual({
			path: "/a/b/c/d/e/f/g/h/i/j",
			pattern: "/a/b/c/d/e/f/g/h/i/j",
		})
		expect(JSON.parse((await send(app, "/v1/users/42")).body)).toEqual({
			path: "/v1/users/42",
			pattern: "/v1/users/:id",
		})
	})
})
