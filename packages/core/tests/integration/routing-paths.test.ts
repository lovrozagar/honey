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
	// v0: d85a20b37d
	// v0: b3d35c3ea8
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

/** An app behind stripPrefix(`prefix`) whose routes echo what they saw. */
const stripped = (prefix: string) => {
	const app = honey<{}>().stripPrefix(prefix)
	for (const pattern of ["/", "/health", "/users", "/other", "/api/deep", "/-docs", "/ary", "/test"])
		app.get(pattern).handler((ctx) => ctx.res.json("ok", { path: ctx.path, pattern: ctx.routePattern }))
	return app
}

describe("stripPrefix", () => {
	// v0: 43479ee78c
	// v0: 2dccaca6b1
	// v0: 420f680ef2
	// v0: 51e66f3a69
	// v0: 035b84d974
	// v0: ab6b7bc42a
	// v0: 5f3fb6b7f4
	// v0: ba99826af9
	// v0: f54a65f0c8
	// v0: c7bf49ba30
	// v0: 22ee825969
	it.each([
		["/api", "/api/health", "/health"],
		["/api", "/api", "/"],
		["/api", "/api/", "/"],
		["/api", "/other", "/other"],
		["/api", "/", "/"],
		["/api", "/api/api/deep", "/api/deep"],
		["/api/v1", "/api/v1/users", "/users"],
		["/api/", "/api/health", "/health"],
		["api", "/api/health", "/health"],
		["", "/health", "/health"],
		["/", "/health", "/health"],
	])("stripPrefix(%j) serves %s as %s, stripping once", async (prefix, target, path) => {
		const res = await stripped(prefix).fetch(new Request(`http://localhost${target}`), {})
		expect([res.status, await res.json()]).toEqual([200, { path, pattern: path }])
	})

	// v0: 3e4b3afe6e
	// v0: e39db192a9
	// v0: fdb922499a
	// v0: 204706c5e1
	it.each([
		["/other/users", 404],
		["/api-docs", 404],
		["/apiary", 404],
		["/api%2Ftest", 400],
	])('stripPrefix("/api") strips whole segments only: %s answers %i', async (target, status) => {
		expect((await stripped("/api").fetch(new Request(`http://localhost${target}`), {})).status).toBe(status)
	})

	// v0: 3a91894d74
	// v0: ca0b63a843
	it.each([
		["/gateway", "/gateway/v1/users"],
		["", "/v1/users"],
	])("stripPrefix(%j) runs before basePath: %s reaches /v1/users", async (prefix, target) => {
		const app = honey<{}>().stripPrefix(prefix)
		app
			.basePath("/v1")
			.get("/users")
			.handler((ctx) => ctx.res.json("ok", { path: ctx.path, pattern: ctx.routePattern }))
		const res = await app.fetch(new Request(`http://localhost${target}`), {})
		expect([res.status, await res.json()]).toEqual([200, { path: "/v1/users", pattern: "/v1/users" }])
	})
})

/** The status, Location and body an app answers `target` with, the target sent from `origin`. */
async function answer(app: App, target: string, init?: RequestInit, origin = "http://localhost") {
	const res = await app.fetch(new Request(`${origin}${target}`, init), {})
	return { body: await res.text(), location: res.headers.get("location"), status: res.status }
}

/** `app` with a GET route on `pattern` answering with ctx.path. */
function serving(app: App, pattern: string): App {
	app.get(pattern).handler((ctx) => ctx.res.text("ok", ctx.path))
	return app
}

describe("trailing-slash redirects: the spelling and the Location", () => {
	// v0: bc05bd7560
	// v0: 1e22a811cc
	// v0: f114a4f84d
	// v0: e5ad351574
	// v0: e4cdf6ccc2
	// v0: 9efd7a1195
	// v0: 0b793c65e5
	// v0: 5d82f987a3
	it("strip and enforce answer 308 to the other spelling; the root is never redirected", async () => {
		const strip = serving(serving(honey<{}>().trailingSlash("strip"), "/users"), "/")
		const enforce = serving(honey<{}>().trailingSlash("enforce"), "/users/")
		expect([
			await answer(strip, "/users/"),
			await answer(strip, "/users"),
			await answer(strip, "/"),
			await answer(enforce, "/users"),
			await answer(enforce, "/users/"),
		]).toEqual([
			{ body: "", location: "/users", status: 308 },
			{ body: "/users", location: null, status: 200 },
			{ body: "/", location: null, status: 200 },
			{ body: "", location: "/users/", status: 308 },
			{ body: "/users/", location: null, status: 200 },
		])
	})

	// v0: 6961fc12f2
	// v0: 1727be37b4
	// v0: 61069fa2f8
	it("Location is relative to the origin the request came from and keeps the query", async () => {
		const strip = serving(honey<{}>().trailingSlash("strip"), "/users")
		const enforce = serving(honey<{}>().trailingSlash("enforce"), "/users/")
		expect([
			(await answer(strip, "/users/?q=hello&page=2", undefined, "https://api.example.com:8443")).location,
			(await answer(strip, "/users/?page=2", undefined, "http://internal.host:8080")).location,
			(await answer(enforce, "/users", undefined, "http://internal:3000")).location,
		]).toEqual(["/users?q=hello&page=2", "/users?page=2", "/users/"])
	})

	// v0: 66cc284aa5
	it("never reflects the Host header or answers with a protocol-relative Location", async () => {
		const app = serving(honey<{}>().trailingSlash("strip"), "/evil.example/x")
		expect(await answer(app, "//evil.example/x/", undefined, "http://attacker.example")).toEqual({
			body: "",
			location: "/evil.example/x",
			status: 308,
		})
	})

	// v0: e5c86046d1
	it("HEAD is redirected like GET, without a body", async () => {
		const app = serving(honey<{}>().trailingSlash("strip"), "/items")
		expect(await answer(app, "/items/", { method: "HEAD" })).toEqual({ body: "", location: "/items", status: 308 })
	})
})

describe("trailing-slash redirects under a stripped prefix or a basePath", () => {
	// v0: 42a51b8a43
	// v0: dc1b045f33
	// v0: 95ccdeeb6e
	// v0: 38b426c677
	it("keeps the prefix stripPrefix removed, and the redirected spelling then matches", async () => {
		const strip = serving(honey<{}>().stripPrefix("/api").trailingSlash("strip"), "/health")
		const enforce = serving(honey<{}>().stripPrefix("/api").trailingSlash("enforce"), "/health/")
		expect([
			await answer(strip, "/api/health/"),
			await answer(strip, "/api/health"),
			await answer(enforce, "/api/health"),
			await answer(enforce, "/api/health/"),
		]).toEqual([
			{ body: "", location: "/api/health", status: 308 },
			{ body: "/health", location: null, status: 200 },
			{ body: "", location: "/api/health/", status: 308 },
			{ body: "/health/", location: null, status: 200 },
		])
	})

	// v0: e71ddc88a3
	// v0: 3526c7a0e4
	it("keeps the basePath, and the redirected spelling then matches", async () => {
		const app = honey<{}>().trailingSlash("strip")
		app
			.basePath("/api")
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", ctx.path))
		expect([await answer(app, "/api/health/"), await answer(app, "/api/health")]).toEqual([
			{ body: "", location: "/api/health", status: 308 },
			{ body: "/api/health", location: null, status: 200 },
		])
	})
})
