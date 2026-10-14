/**
 * Routing through `app.fetch`: which route a request reaches by method, what an app answers when
 * no route fits (404, 405 and Allow), and registration. Params are in routing-params.test.ts and
 * request paths in routing-paths.test.ts. Every case asserts the whole answer.
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

const sortedAllow = (allow: string | null) =>
	allow
		?.split(",")
		.map((m) => m.trim())
		.sort()

describe("method resolution", () => {
	const verbs = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const

	// v0: 0b40b00bfb
	// v0: bba7582b67
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
	// v0: 53061962a5
	// v0: 191f79b6a7
	// v0: 4420fbc747
	// v0: a8d57951ba
	// v0: ba3f8329bb
	it("ALL answers any method, and an exact method on the same path wins over it", async () => {
		const app = echoApp([
			["ALL", "/resource"],
			["GET", "/resource"],
			["ALL", "/catch"],
		])
		expect(await echo(app, "/resource")).toEqual({ method: "GET", params: {}, path: "/resource", pattern: "/resource" })
		for (const method of ["PUT", "DELETE", "PATCH"])
			expect((await echo(app, "/resource", { method })).method).toBe(method)
		for (const method of ["GET", "POST", "DELETE"])
			expect(await echo(app, "/catch", { method })).toMatchObject({ method, pattern: "/catch" })
	})
})

describe("method resolution: the method's spelling", () => {
	// v0: 6f4b652983
	it("a method a runtime reports in lowercase reaches the route of its uppercase name", async () => {
		const app = echoApp([["GET", "/test"]])
		const req = new Request("http://localhost/test")
		Object.defineProperty(req, "method", { value: "get" })
		const res = await app.fetch(req, {})
		expect([res.status, ((await res.json()) as Echo).pattern]).toEqual([200, "/test"])
	})
})

describe("method resolution: on() with several methods", () => {
	// v0: 903360137b
	// v0: f57a7960d4
	// v0: c36bee0bde
	// v0: ae47f23316
	// v0: 77c1590a86
	it("on() registers one route per listed method, with its chain and meta; any other method is 405", async () => {
		const app = honey<{}>()
		app
			.meta<{ tag?: string }>()
			.use(createMiddleware((_ctx, next) => next({ injected: "yes" })))
			.on(["PUT", "PATCH"], "/items/:id")
			.meta({ tag: "items" })
			.handler((ctx) =>
				ctx.res.json("ok", { id: ctx.params.id, injected: ctx.injected, method: ctx.req.method, tag: ctx.meta.tag }),
			)
		app.on(["DELETE"], "/items/:id").handler((ctx) => ctx.res.json("ok", { deleted: ctx.params.id }))
		for (const method of ["PUT", "PATCH"])
			expect(await send(app, "/items/42", { method })).toEqual({
				allow: null,
				body: JSON.stringify({ id: "42", injected: "yes", method, tag: "items" }),
				status: 200,
			})
		expect(await send(app, "/items/42", { method: "DELETE" })).toEqual({
			allow: null,
			body: '{"deleted":"42"}',
			status: 200,
		})
		const wrong = await send(app, "/items/42")
		expect([wrong.status, sortedAllow(wrong.allow)]).toEqual([405, ["DELETE", "PATCH", "PUT"]])
	})
})

type Hit = readonly [method: string, target: string, pattern: string, params: Record<string, string>]

/** Each case: the routes in the order registered, and the route every request reaches. */
const PRECEDENCE: [string, ReadonlyArray<readonly [HttpMethod, string]>, readonly Hit[]][] = [
	[
		// v0: 1f86dd298e
		"a wildcard registered before a literal beside it",
		[
			["GET", "/files/*path"],
			["GET", "/files/readme"],
		],
		[
			["GET", "/files/readme", "/files/readme", {}],
			["GET", "/files/other.txt", "/files/*path", { path: "other.txt" }],
		],
	],
	[
		// v0: eb345244e4
		// v0: 631c6736df
		// v0: 0ebb71fe26
		// v0: a089599a6e
		"a literal beside a param at the same depth, the param registered first",
		[
			["GET", "/users/:id"],
			["GET", "/users/me"],
		],
		[
			["GET", "/users/me", "/users/me", {}],
			["GET", "/users/42", "/users/:id", { id: "42" }],
		],
	],
	[
		// v0: 6a43387f4e
		// v0: 5da3c4dd3c
		"a literal under a deeper branch, beside a param with different children",
		[
			["GET", "/users/:id/posts"],
			["GET", "/users/me/posts"],
			["GET", "/users/me/settings"],
		],
		[
			["GET", "/users/me/posts", "/users/me/posts", {}],
			["GET", "/users/me/settings", "/users/me/settings", {}],
			["GET", "/users/42/posts", "/users/:id/posts", { id: "42" }],
		],
	],
	[
		// v0: 2dd58c60af
		"a param takes one segment, a wildcard beside it the rest",
		[
			["GET", "/files/*path"],
			["GET", "/files/:name"],
		],
		[
			["GET", "/files/doc.txt", "/files/:name", { name: "doc.txt" }],
			["GET", "/files/a/b", "/files/*path", { path: "a/b" }],
		],
	],
	[
		// v0: 0c5ecbdcb4
		// v0: 67c721f4ac
		"a wildcard beside a literal takes every deeper path, whole",
		[
			["GET", "/static/*path"],
			["GET", "/static/readme"],
		],
		[
			["GET", "/static/readme", "/static/readme", {}],
			["GET", "/static/a/b/c", "/static/*path", { path: "a/b/c" }],
		],
	],
	[
		// v0: 1b31c6263d
		"a literal branch that dead-ends, or lacks the method, falls back to the param or wildcard beside it",
		[
			["GET", "/users/me/settings"],
			["GET", "/users/:id/profile"],
			["GET", "/files/static"],
			["GET", "/files/*path"],
			["GET", "/a/:id"],
			["GET", "/a/*rest"],
			["GET", "/u/me"],
			["DELETE", "/u/:id"],
		],
		[
			["GET", "/users/me/profile", "/users/:id/profile", { id: "me" }],
			["GET", "/files/static/x", "/files/*path", { path: "static/x" }],
			["GET", "/a/1/2", "/a/*rest", { rest: "1/2" }],
			["DELETE", "/u/me", "/u/:id", { id: "me" }],
		],
	],
	[
		// v0: 6e5aec2b2c
		"a request spelling the pattern itself is a param value, not a literal hit",
		[["GET", "/users/:id"]],
		[["GET", "/users/:id", "/users/:id", { id: ":id" }]],
	],
]

describe("which route a path reaches: literal, then param, then wildcard, in any registration order", () => {
	it.each(PRECEDENCE)("%s", async (_name, routes, hits) => {
		const app = echoApp(routes)
		const reached = []
		for (const [method, target] of hits) {
			const { params, pattern } = await echo(app, target, { method })
			reached.push([method, target, pattern, params])
		}
		expect(reached).toEqual(hits)
	})
})

describe("404 and 405", () => {
	// v0: ebb0d677ab
	// v0: e4fa75babc
	// v0: 3424191595
	// v0: e96839041f
	// v0: ac10ff582e
	// v0: 6abfdc07c5
	// v0: 731db302e5
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
	// v0: d582698c3f
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

describe("a resource behind an auth chain, beside a public route", () => {
	// v0: 18167919d0
	// v0: 1b2318a124
	// v0: e17e9607a9
	// v0: aa12d63617
	// v0: 754ffde8ad
	// v0: ea1334b3f4
	// v0: cdef041f42
	it("each method reaches its route with its status; without a token the chain answers 401 first", async () => {
		const app = honey<{}>()
		const api = app.basePath("/api")
		api.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		const authed = api.use(
			createMiddleware((ctx: { req: Request }, next) =>
				ctx.req.headers.get("authorization")?.startsWith("Bearer ")
					? next({ user: "u1" })
					: new Response(JSON.stringify({ error_key: "unauthorized" }), { status: 401 }),
			),
		)
		authed.get("/orgs").handler((ctx) => ctx.res.json("ok", { items: [{ id: "org1" }], total: 1 }))
		authed.get("/orgs/:orgId").handler((ctx) => ctx.res.json("ok", { id: ctx.params.orgId }))
		authed.post("/orgs").handler(async (ctx) => ctx.res.json("created", (await ctx.req.json()) as object))
		authed.delete("/orgs/:orgId").handler((ctx) => ctx.res.noContent())
		const auth = { authorization: "Bearer tok" }
		const answers = []
		for (const [method, path, headers, body] of [
			["GET", "/api/health", {}, undefined],
			["GET", "/api/orgs", {}, undefined],
			["GET", "/api/orgs", auth, undefined],
			["GET", "/api/orgs/org42", auth, undefined],
			["POST", "/api/orgs", auth, JSON.stringify({ slug: "new-org" })],
			["DELETE", "/api/orgs/org42", auth, undefined],
		] as const) {
			const res = await send(app, path, { body, headers, method })
			answers.push([method, path, res.status, res.body])
		}
		expect(answers).toEqual([
			["GET", "/api/health", 200, "ok"],
			["GET", "/api/orgs", 401, '{"error_key":"unauthorized"}'],
			["GET", "/api/orgs", 200, '{"items":[{"id":"org1"}],"total":1}'],
			["GET", "/api/orgs/org42", 200, '{"id":"org42"}'],
			["POST", "/api/orgs", 201, '{"slug":"new-org"}'],
			["DELETE", "/api/orgs/org42", 204, ""],
		])
	})
})
