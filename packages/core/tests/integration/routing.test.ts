/**
 * Routing through `app.fetch`: which route a request reaches, what it sees of its path, and what an
 * app answers when no route fits. Every case asserts the whole answer: status, body, and `Allow`
 * where it matters.
 */
import { describe, expect, it } from "vitest"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { type Honey, honey } from "../../src/routing/app.ts"
import { normalizePattern, parsePattern } from "../../src/routing/pattern.ts"
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

const sortedAllow = (allow: string | null) =>
	allow
		?.split(",")
		.map((m) => m.trim())
		.sort()

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

describe("method resolution", () => {
	const verbs = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const

	// v0: 0b40b00bfb
	// v0: c938683aa6
	// v0: 16d54aad19
	it.each(verbs)("%s on a path every verb registered reaches its own route", async (method) => {
		const app = echoApp(verbs.map((v) => [v, "/m"] as const))
		const res = await send(app, "/m", { method })
		expect(res.status).toBe(200)
		/* HEAD keeps its body until body-kind strips it (bit 08); the route it reached is what matters here */
		expect((JSON.parse(res.body) as Echo).method).toBe(method)
	})

	// v0: 923e952ede
	// v0: 9ab6453be8
	it("HEAD runs the GET route unless HEAD has its own, and is 404 where neither exists", async () => {
		const app = honey<{}>()
		app.get("/page").handler((ctx) => ctx.res.text("ok", "get"))
		app.get("/both").handler((ctx) => ctx.res.text("ok", "get"))
		app.head("/both").handler((ctx) => ctx.res.noContent({ headers: { "x-route": "head" } }))
		expect(await send(app, "/page", { method: "HEAD" })).toMatchObject({ body: "get", status: 200 })
		const own = await app.fetch(new Request("http://localhost/both", { method: "HEAD" }), {})
		expect([own.status, own.headers.get("x-route")]).toEqual([204, "head"])
		expect((await send(app, "/nope", { method: "HEAD" })).status).toBe(404)
	})

	// v0: 93535ff147
	// v0: 191f79b6a7
	it("ALL answers any method, and an exact method on the same path wins over it", async () => {
		const app = echoApp([
			["ALL", "/resource"],
			["GET", "/resource"],
		])
		expect(await echo(app, "/resource")).toEqual({ method: "GET", params: {}, path: "/resource", pattern: "/resource" })
		for (const method of ["PUT", "DELETE", "PATCH"])
			expect((await echo(app, "/resource", { method })).method).toBe(method)
	})
})

describe("404 and 405", () => {
	// v0: ebb0d677ab
	// v0: 3424191595
	// v0: e96839041f
	// v0: ac10ff582e
	// v0: 6abfdc07c5
	it("an unknown path is 404; a known path with another method is 405 naming every method it has", async () => {
		const app = echoApp([
			["GET", "/items"],
			["POST", "/items"],
			["DELETE", "/items"],
		])
		const missing = await send(app, "/nope")
		expect(missing.status).toBe(404)
		expect(JSON.parse(missing.body)).toMatchObject({ error_key: "not_found", status: 404, success: false })
		const wrong = await send(app, "/items", { method: "PATCH" })
		expect(wrong.status).toBe(405)
		expect(sortedAllow(wrong.allow)).toEqual(["DELETE", "GET", "POST"])
		expect(JSON.parse(wrong.body)).toMatchObject({ error_key: "method_not_allowed", status: 405 })
	})

	// v0: 21ddd9fda7
	// v0: 67e1958891
	it("Allow gathers methods from every branch that matches: literal, param and wildcard", async () => {
		const app = echoApp([
			["GET", "/u/me"],
			["POST", "/u/:id"],
			["GET", "/files/*rest"],
		])
		const branches = await send(app, "/u/me", { method: "PUT" })
		expect([branches.status, sortedAllow(branches.allow)]).toEqual([405, ["GET", "POST"]])
		const wildcard = await send(app, "/files/a/b", { method: "POST" })
		expect([wildcard.status, wildcard.allow]).toEqual([405, "GET"])
	})

	// v0: 60e81a1bb9
	// v0: 4dd3f6c1e7
	// v0: 5746507eaa
	it.each([
		["an app with no routes", "/"],
		["a very long path", `/${"a".repeat(10_000)}`],
		["a path of many segments", "/x".repeat(1000)],
	])("%s answers 404", async (_label, target) => {
		const app = honey<{}>()
		if (target !== "/") app.get("/known").handler((ctx) => ctx.res.text("ok", "k"))
		const res = await send(app, target)
		expect(res.status).toBe(404)
		expect(JSON.parse(res.body)).toMatchObject({ error_key: "not_found" })
	})
})

describe("path params: capture and names", () => {
	// v0: fd12cfc088
	// v0: b8488bc5a6
	// v0: ddd8a7fc9a
	// v0: af851d64d4
	// v0: 31703df14c
	it.each([
		["/a", "/a", {}],
		["/:x", "/q", { x: "q" }],
		["/orgs/:orgId/members/:memberId", "/orgs/o1/members/m2", { memberId: "m2", orgId: "o1" }],
		["/a/:b/c/:d/e/:f/g/:h", "/a/1/c/2/e/3/g/4", { b: "1", d: "2", f: "3", h: "4" }],
	])("%s captures every param it names from %s", async (pattern, target, params) => {
		const app = echoApp([["GET", pattern]])
		expect(await echo(app, target)).toEqual({ method: "GET", params, path: target, pattern })
	})
})

describe("path params: decoding", () => {
	// v0: a13a2b1446
	// v0: bc9f716611
	// v0: db5153c492
	// v0: a53f920a23
	// v0: b179cf8c99
	// v0: 7a8ae71e94
	// v0: d3abcffb88
	// v0: 46a4e97aa3
	it.each([
		["plain", "plain"],
		["a%20b", "a b"],
		["a%20b%2Bc", "a b+c"],
		["user%40example.com", "user@example.com"],
		["a+b", "a+b"],
		["caf%C3%A9", "café"],
		["%F0%9F%8D%AF", "🍯"],
		["%E0%A4%A", "%E0%A4%A"],
	])("a param sent as %s reads %s", async (sent, value) => {
		const app = echoApp([["GET", "/v/:value"]])
		expect((await echo(app, `/v/${sent}`)).params).toEqual({ value })
	})

	// v0: aa339b4531
	// v0: 8ac0edfc93
	it("a param named like a prototype key is an own value and touches no prototype", async () => {
		const before = Object.getOwnPropertyNames(Object.prototype)
		const app = echoApp([
			["GET", "/items/:__proto__"],
			["GET", "/things/:prototype"],
		])
		const proto = (await echo(app, "/items/safe")).params
		expect(Object.hasOwn(proto, "__proto__")).toBe(true)
		expect(proto["__proto__"]).toBe("safe")
		expect((await echo(app, "/things/evil")).params).toEqual({ prototype: "evil" })
		expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(before)
	})

	// v0: d96623e492
	it("an empty segment does not fill a param", async () => {
		const app = echoApp([["GET", "/users/:id"]])
		expect((await send(app, "/users/")).status).toBe(404)
		expect((await echo(app, "/users/7")).params).toEqual({ id: "7" })
	})
})

describe("literal segments", () => {
	// v0: 053ac894d6
	// v0: 3c2b1bb0f7
	// v0: 3cf829405e
	it.each(["/api/v1.0/test", "/files/[id]", "/group(1)"])("%s is a literal, not a pattern", async (pattern) => {
		const app = echoApp([["GET", pattern]])
		expect(await echo(app, pattern)).toMatchObject({ params: {}, pattern })
		expect((await send(app, pattern.replace(/[.[(]/, "x"))).status).toBe(404)
	})

	// v0: 17759e784b
	it("a literal is encoded the way the request path is, so either spelling reaches it", async () => {
		expect(normalizePattern("/é/a b/x^y")).toBe("/%C3%A9/a%20b/x%5Ey")
		expect(normalizePattern("/%C3%A9")).toBe("/%C3%A9")
		expect(() => parsePattern("/a/%2e%2E")).toThrow(/segments are not allowed/)
		const app = echoApp([["GET", "/é/a b"]])
		for (const target of ["/é/a b", "/%C3%A9/a%20b"]) {
			expect(await echo(app, target)).toMatchObject({ path: "/%C3%A9/a%20b", pattern: "/%C3%A9/a%20b" })
		}
	})
})

describe("wildcards and optional params", () => {
	// v0: 0d8247d678
	// v0: 435dfc0a98
	// v0: 088d9fe73f
	// v0: 77099d2ea8
	// v0: 37425c7390
	// v0: 6e7976882b
	// v0: bbc08090bf
	// v0: 4168bd9e45
	// v0: 722ff22ccb
	it.each([
		["/files/*rest", "/files/a/b/c/d/e", { rest: "a/b/c/d/e" }],
		["/files/*rest", "/files", { rest: "" }],
		["/files/*rest", "/files/", { rest: "" }],
		["/files/*rest", "/files/a/b/", { rest: "a/b/" }],
		["/files/*rest", "/files/a%20b", { rest: "a b" }],
		["/blob/*", "/blob/x/y", { "*": "x/y" }],
	])("%s on %s captures %j", async (pattern, target, params) => {
		const app = echoApp([["GET", pattern]])
		expect(await echo(app, target)).toEqual({ method: "GET", params, path: target, pattern })
	})

	// v0: a62ff22a0d
	// v0: 8a79392e36
	it("an optional last param matches with and without its segment", async () => {
		const app = echoApp([["GET", "/opt/:id?"]])
		expect(await echo(app, "/opt")).toEqual({ method: "GET", params: {}, path: "/opt", pattern: "/opt/:id?" })
		expect((await echo(app, "/opt/7")).params).toEqual({ id: "7" })
	})
})

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

describe("registration", () => {
	// v0: 3ba595eaeb
	// v0: 329409fbc2
	// v0: b2703a71c5
	// v0: b5d1ab2ad1
	it("the same method and pattern twice is an error, whether from a new builder or the same one", () => {
		const app = honey<{}>()
		const route = app.get("/x")
		route.handler((ctx) => ctx.res.text("ok", "first"))
		expect(() => app.get("/x").handler((ctx) => ctx.res.text("ok", "second"))).toThrow("Duplicate route: GET /x")
		expect(() => route.handler((ctx) => ctx.res.text("ok", "again"))).toThrow("Duplicate route: GET /x")
		expect(() => app.post("/x").handler((ctx) => ctx.res.text("ok", "post"))).not.toThrow()
	})

	// v0: 30a1012a5a
	// v0: 8cce2d79a9
	it("a param or wildcard named differently where another route already named one is an error", () => {
		const app = honey<{}>()
		app.get("/users/:id").handler((ctx) => ctx.res.text("ok", "id"))
		app.get("/files/*path").handler((ctx) => ctx.res.text("ok", "path"))
		expect(() => app.get("/users/:userId/posts").handler((ctx) => ctx.res.text("ok", "posts"))).toThrow()
		expect(() => app.post("/files/*rest").handler((ctx) => ctx.res.text("ok", "rest"))).toThrow()
	})

	// v0: a2c7ef2bb4
	// v0: 73c30e5a6e
	it("a route registered after the first request is served by the next one", async () => {
		const app = echoApp([["GET", "/first"]])
		await echo(app, "/first")
		app.get("/later").handler((ctx) => ctx.res.json("ok", { later: true }))
		expect(JSON.parse((await send(app, "/later")).body)).toEqual({ later: true })
	})

	// v0: ce5693f6cb
	// v0: 40cd065c97
	// v0: c41bbf815d
	it("handler() returns the app, so a long chain or hundreds of routes all register", async () => {
		let chained = honey<{}>() as App
		for (let i = 0; i < 50; i++) chained = chained.get(`/c${i}`).handler((ctx) => ctx.res.text("ok", `c${i}`)) as App
		const many = echoApp(Array.from({ length: 500 }, (_, i) => ["GET", `/r${i}/:id`] as const))
		expect((await send(chained, "/c0")).body).toBe("c0")
		expect((await send(chained, "/c49")).body).toBe("c49")
		expect(await echo(many, "/r499/z")).toMatchObject({ params: { id: "z" }, pattern: "/r499/:id" })
	})

	// v0: a6b65809b4
	it("fetch is a method: called on its app through a binding, it serves", async () => {
		const app = echoApp([["GET", "/test"]])
		const { fetch } = app
		const res = await fetch.call(app, new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
	})
})

describe("answers stay the same", () => {
	// v0: fca3300e84
	// v0: c92cb0eeca
	it("with or without middleware on the route", async () => {
		const bare = echoApp([["GET", "/x"]])
		const wrapped = honey<{}>()
		wrapped
			.use(createMiddleware((_ctx, next) => next()))
			.get("/x")
			.handler((ctx) =>
				ctx.res.json("ok", { method: ctx.req.method, params: ctx.params, path: ctx.path, pattern: ctx.routePattern }),
			)
		expect(await echo(wrapped as App, "/x")).toEqual(await echo(bare, "/x"))
	})

	// v0: 0aa60ff52e
	// v0: e01a588c7e
	// v0: 70b534a172
	it("across a thousand sequential and interleaved requests", async () => {
		const app = echoApp([
			["GET", "/a/:n"],
			["GET", "/b"],
		])
		const wrong: string[] = []
		for (let i = 0; i < 1000; i++) {
			const [a, b] = await Promise.all([send(app, `/a/${i}`), send(app, "/b")])
			if (a.status !== 200 || (JSON.parse(a.body) as Echo).params.n !== String(i) || b.status !== 200)
				wrong.push(`${i}`)
		}
		expect(wrong).toEqual([])
	})
})
