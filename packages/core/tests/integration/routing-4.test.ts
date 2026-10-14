import { describe, expect, expectTypeOf, it } from "vitest"
import { honey } from "../../src/routing/app.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import type { InferRoutes } from "../../src/routing/app-types.ts"

type AppMeta = { security?: string; tags?: string }

describe("ctx.path and ctx.routePattern", () => {
	// v0: 6c8ea866ea
	it("dynamic route — path has value, pattern has :param", async () => {
		const app = honey<{}>()
		let capturedPath: string | undefined
		let capturedPattern: string | undefined

		app.get("/orgs/:orgId").handler((ctx) => {
			capturedPath = ctx.path
			capturedPattern = ctx.routePattern
			return ctx.res.text("ok", "ok")
		})

		await app.fetch(new Request("http://localhost/orgs/123"), {})
		expect(capturedPath).toBe("/orgs/123")
		expect(capturedPattern).toBe("/orgs/:orgId")
	})

	// v0: 83662f41a0
	it("basePath included in ctx.path", async () => {
		const app = honey<{}>().basePath("/api")
		let capturedPath: string | undefined

		app.get("/users").handler((ctx) => {
			capturedPath = ctx.path
			return ctx.res.text("ok", "ok")
		})

		await app.fetch(new Request("http://localhost/api/users"), {})
		expect(capturedPath).toBe("/api/users")
	})
})

describe("URL fast path extraction", () => {
	// v0: eeaca59f7f
	it("standard URL routes correctly", async () => {
		const app = honey<{}>()
		app.get("/json").handler((ctx) => ctx.res.json("ok", { route: "json" }))

		const res = await app.fetch(new Request("http://localhost:3000/json"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.route).toBe("json")
	})

	// v0: faccadd062
	it("URL with fragment routes correctly, fragment stripped", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", { matched: true }))

		/* browsers strip fragments, but raw Request may preserve them */
		const res = await app.fetch(new Request("http://localhost:3000/test#section"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.matched).toBe(true)
	})

	// v0: 8884c869d8
	it("URL with non-standard port routes correctly", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", { port: true }))

		const res = await app.fetch(new Request("http://localhost:8080/test"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.port).toBe(true)
	})

	// v0: 14c341508e
	it("URL without explicit path defaults to /", async () => {
		const app = honey<{}>()
		app.get("/").handler((ctx) => ctx.res.json("ok", { root: true }))

		const res = await app.fetch(new Request("http://localhost:3000/"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.root).toBe(true)
	})
})

describe("response fast paths", () => {
	// v0: 4d2e62acfe
	it("ctx.res.json without opts uses pre-allocated JSON_HEADERS", async () => {
		const app = honey<{}>()
		app.get("/j").handler((ctx) => ctx.res.json("ok", { a: 1 }))

		const res = await app.fetch(new Request("http://localhost/j"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("application/json")
		const body = (await res.json()) as Record<string, unknown>
		expect(body.a).toBe(1)
	})

	// v0: 25cda3810d
	it("ctx.res.json with custom headers uses Headers instance (slow path)", async () => {
		const app = honey<{}>()
		app.get("/j2").handler((ctx) => ctx.res.json("ok", { b: 2 }, { headers: { "x-custom": "1" } }))

		const res = await app.fetch(new Request("http://localhost/j2"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("application/json")
		expect(res.headers.get("x-custom")).toBe("1")
	})

	// v0: 794aeec471
	it("ctx.res.text without opts uses pre-allocated TEXT_HEADERS", async () => {
		const app = honey<{}>()
		app.get("/t").handler((ctx) => ctx.res.text("ok", "hello"))

		const res = await app.fetch(new Request("http://localhost/t"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8")
		expect(await res.text()).toBe("hello")
	})

	// v0: 9b9d66294a
	it("ctx.res.html without opts uses pre-allocated HTML_HEADERS", async () => {
		const app = honey<{}>()
		app.get("/h").handler((ctx) => ctx.res.html("ok", "<h1>hi</h1>"))

		const res = await app.fetch(new Request("http://localhost/h"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8")
		expect(await res.text()).toBe("<h1>hi</h1>")
	})
})

describe("response fast paths (2)", () => {
	// v0: 8f2b994e56
	it("ctx.res.csv without opts uses pre-allocated CSV_HEADERS", async () => {
		const app = honey<{}>()
		app.get("/c").handler((ctx) => ctx.res.csv("ok", "a,b\n1,2"))

		const res = await app.fetch(new Request("http://localhost/c"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8")
	})

	// v0: 8b7e6d5a31
	it("ctx.res.text with custom headers falls back to Headers instance", async () => {
		const app = honey<{}>()
		app.get("/t2").handler((ctx) => ctx.res.text("ok", "hi", { headers: { "x-tag": "yes" } }))

		const res = await app.fetch(new Request("http://localhost/t2"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8")
		expect(res.headers.get("x-tag")).toBe("yes")
	})
})

describe("extremely nested params", () => {
	// v0: ddd8a7fc9a
	it("/a/:b/c/:d/e/:f/g/:h → all 4 params captured", async () => {
		const app = honey<{}>()
		app.get("/a/:b/c/:d/e/:f/g/:h").handler((ctx) => ctx.res.json("ok", ctx.params))

		const res = await app.fetch(new Request("http://localhost/a/1/c/2/e/3/g/4"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body).toEqual({ b: "1", d: "2", f: "3", h: "4" })
	})
})

describe("idempotent route registration", () => {
	// v0: b2703a71c5
	it("registering same path+method twice → throws (no silent overwrite)", () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.text("ok", "first"))

		expect(() => {
			app.get("/test").handler((ctx) => ctx.res.text("ok", "second"))
		}).toThrow(/duplicate/i)
	})
})

describe("routing stress", () => {
	// v0: b7dd87de75
	it("deeply nested path /a/b/c/d/e/f/g/h/i/j matches", async () => {
		const app = honey<{}>()
		app.get("/a/b/c/d/e/f/g/h/i/j").handler((ctx) => ctx.res.text("ok", "deep"))

		const res = await app.fetch(new Request("http://localhost/a/b/c/d/e/f/g/h/i/j"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("deep")
	})

	// v0: 0d8247d678
	it("wildcard captures everything after prefix", async () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		const res = await app.fetch(new Request("http://localhost/files/a/b/c.txt"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.path).toBe("a/b/c.txt")
	})

	// v0: 088d9fe73f
	it("wildcard with empty remainder", async () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		const res = await app.fetch(new Request("http://localhost/files/"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.path).toBe("")
	})

	// v0: bc9f716611
	it("param with encoded characters %20 %2B", async () => {
		const app = honey<{}>()
		app.get("/search/:query").handler((ctx) => ctx.res.json("ok", { query: ctx.params.query }))

		const res = await app.fetch(new Request("http://localhost/search/hello%20world"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.query).toBe("hello world")
	})
})

describe("routing stress (2)", () => {
	// v0: b8488bc5a6
	it("multiple params in one path", async () => {
		const app = honey<{}>()
		app
			.get("/orgs/:orgId/members/:memberId")
			.handler((ctx) => ctx.res.json("ok", { m: ctx.params.memberId, o: ctx.params.orgId }))

		const res = await app.fetch(new Request("http://localhost/orgs/o1/members/m2"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.o).toBe("o1")
		expect(body.m).toBe("m2")
	})
})

describe("method not allowed", () => {
	// v0: ac10ff582e
	it("multiple methods registered → Allow lists all", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))
		app.post("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/test", { method: "DELETE" }), {})
		expect(res.status).toBe(405)
		const allow = res.headers.get("allow") ?? ""
		expect(allow).toContain("GET")
		expect(allow).toContain("POST")
	})
})

describe("multiple methods on same path", () => {
	// v0: 6abfdc07c5
	it("GET and POST on /api/items → both work, DELETE → 405", async () => {
		const app = honey<{}>()
		app.get("/api/items").handler((ctx) => ctx.res.json("ok", { method: "GET" }))
		app.post("/api/items").handler((ctx) => ctx.res.json("created", { method: "POST" }))

		const get = await app.fetch(new Request("http://localhost/api/items"), {})
		expect(get.status).toBe(200)

		const post = await app.fetch(new Request("http://localhost/api/items", { method: "POST" }), {})
		expect(post.status).toBe(201)

		const del = await app.fetch(new Request("http://localhost/api/items", { method: "DELETE" }), {})
		expect(del.status).toBe(405)
		const allow = del.headers.get("allow") ?? ""
		expect(allow).toContain("GET")
		expect(allow).toContain("POST")
	})
})

describe("x-internal routes — runtime", () => {
	// v0: fbf7ced595
	it("internal route still responds to HTTP requests", async () => {
		const app = honey<{}>().meta<AppMeta>()

		app
			.get("/health")
			.meta({ internal: true })
			.handler((ctx) => ctx.res.json("ok", { status: "healthy" }))

		const res = await app.fetch(new Request("http://localhost/health"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.status).toBe("healthy")
	})

	// v0: 99359e229d
	it("ctx.meta['x-internal'] is true in handler", async () => {
		const app = honey<{}>().meta<AppMeta>()

		app
			.get("/health")
			.meta({ internal: true })
			.handler((ctx) => ctx.res.json("ok", { internal: ctx.meta.internal }))

		const res = await app.fetch(new Request("http://localhost/health"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.internal).toBe(true)
	})

	// v0: c90a72efd3
	it("chain-level x-internal applies to all downstream routes", async () => {
		const internal = honey<{}>().meta<AppMeta>().meta({ internal: true })

		internal.get("/metrics").handler((ctx) => ctx.res.json("ok", { internal: ctx.meta.internal }))
		internal.get("/debug").handler((ctx) => ctx.res.json("ok", { internal: ctx.meta.internal }))

		const r1 = await internal.fetch(new Request("http://localhost/metrics"), {})
		expect(((await r1.json()) as Record<string, unknown>).internal).toBe(true)

		const r2 = await internal.fetch(new Request("http://localhost/debug"), {})
		expect(((await r2.json()) as Record<string, unknown>).internal).toBe(true)
	})
})

describe("x-internal routes — runtime (2)", () => {
	// v0: 5ab1605dec
	it("public and internal routes coexist on same app", async () => {
		const app = honey<{}>().meta<AppMeta>()

		app
			.get("/api/users")
			.meta({ operationId: "user.list", tags: "Users" })
			.handler((ctx) => ctx.res.json("ok", { users: [] }))

		app
			.get("/health")
			.meta({ internal: true })
			.handler((ctx) => ctx.res.json("ok", { ok: true }))

		const r1 = await app.fetch(new Request("http://localhost/api/users"), {})
		expect(r1.status).toBe(200)

		const r2 = await app.fetch(new Request("http://localhost/health"), {})
		expect(r2.status).toBe(200)
	})
})

describe("x-internal routes — type exclusion", () => {
	// v0: 6c8d006dbb
	it("chain-level x-internal excludes all downstream from InferRoutes", () => {
		const base = honey<{}>()
			.meta<AppMeta>()
			.get("/api/users")
			.meta({ operationId: "user.list" })
			.handler((ctx) => ctx.res.json("ok", {}))

		const internal = base.meta({ internal: true })

		const step2 = internal.get("/metrics").handler((ctx) => ctx.res.json("ok", {}))

		const step3 = step2.get("/debug").handler((ctx) => ctx.res.json("ok", {}))

		type Routes = InferRoutes<typeof step3>

		type HasUsers = Routes extends { "/api/users": unknown } ? true : false
		expectTypeOf<HasUsers>().toEqualTypeOf<true>()

		type HasMetrics = Routes extends { "/metrics": unknown } ? true : false
		expectTypeOf<HasMetrics>().toEqualTypeOf<false>()

		type HasDebug = Routes extends { "/debug": unknown } ? true : false
		expectTypeOf<HasDebug>().toEqualTypeOf<false>()
	})

	// v0: 6242aa2673
	it("x-internal with middleware — still excluded from types", () => {
		const mw = createMiddleware(async (_ctx, next) => next({ added: true }))

		const step1 = honey<{}>()
			.meta<AppMeta>()
			.use(mw)
			.get("/public")
			.handler((ctx) => ctx.res.json("ok", {}))

		const step2 = step1
			.get("/x-internal")
			.meta({ internal: true })
			.handler((ctx) => ctx.res.json("ok", {}))

		type Routes = InferRoutes<typeof step2>

		type HasPublic = Routes extends { "/public": unknown } ? true : false
		expectTypeOf<HasPublic>().toEqualTypeOf<true>()

		type HasInternal = Routes extends { "/x-internal": unknown } ? true : false
		expectTypeOf<HasInternal>().toEqualTypeOf<false>()
	})
})
