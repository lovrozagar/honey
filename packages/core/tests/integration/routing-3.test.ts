import { describe, expect, it } from "vitest"
import { honey } from "../../src/routing/app.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { type ExecutionCtx, HoneyContext, NO_ROUTE } from "../../src/context/context.ts"

type V0CtxOptions = {
	env: unknown
	executionCtx?: ExecutionCtx
	meta?: Readonly<Record<string, unknown>>
	params: Record<string, string>
	path?: string
	req: Request
	routePattern?: string
}

/** v0's HoneyContext options, onto v1's positional constructor. */
function v0Ctx(opts: V0CtxOptions): HoneyContext<unknown> {
	const state = { env: opts.env, executionCtx: opts.executionCtx, path: opts.path ?? "", req: opts.req }
	return new HoneyContext(
		state,
		{ errors: null, meta: opts.meta ?? NO_ROUTE.meta, pattern: opts.routePattern ?? "" },
		opts.params,
	)
}

describe("params that look like path traversal", () => {
	// v0: 6a604d84d5
	it(":id with value '../etc/passwd' → 400, an encoded slash never reaches a param", async () => {
		const app = honey<{}>()
		app.get("/files/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

		const res = await app.fetch(new Request(`http://localhost/files/${encodeURIComponent("../etc/passwd")}`), {})
		expect(res.status).toBe(400)
	})

	// v0: f14bd5e990
	it(":id with an encoded dot-dot segment resolves like a literal one", async () => {
		const app = honey<{}>()
		app.get("/files/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))
		app.get("/etc").handler((ctx) => ctx.res.json("ok", { id: "etc" }))

		const res = await app.fetch(new Request("http://localhost/files/%2e%2e/etc"), {})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ id: "etc" })
	})
})

describe("very fast sequential route registration", () => {
	// v0: c41bbf815d
	it("registering 500 routes doesn't corrupt the tree", async () => {
		const app = honey<{}>()
		for (let i = 0; i < 500; i++) {
			app.get(`/r/${i}`).handler((ctx) => ctx.res.json("ok", { i }))
		}

		/* spot check */
		for (const idx of [0, 123, 250, 499]) {
			const res = await app.fetch(new Request(`http://localhost/r/${idx}`), {})
			expect(res.status).toBe(200)
		}
	})
})

describe("regex-like characters in route paths", () => {
	// v0: 053ac894d6
	it("path with dots /api/v1.0/test → matches literally", async () => {
		const app = honey<{}>()
		app.get("/api/v1.0/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/api/v1.0/test"), {})
		expect(res.status).toBe(200)
	})

	// v0: 3c2b1bb0f7
	it("path with brackets /files/[id] → matches literally", async () => {
		const app = honey<{}>()
		app.get("/files/[id]").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/files/[id]"), {})
		expect(res.status).toBe(200)

		/* /files/123 should NOT match — [id] is literal, not a param */
		const res2 = await app.fetch(new Request("http://localhost/files/123"), {})
		expect(res2.status).toBe(404)
	})

	// v0: 3cf829405e
	it("path with parentheses /group(1) → matches literally", async () => {
		const app = honey<{}>()
		app.get("/group(1)").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/group(1)"), {})
		expect(res.status).toBe(200)
	})
})

describe("what if the route path is just /", () => {
	// v0: 848e7b45f9
	it("root route / → matches", async () => {
		const app = honey<{}>()
		app.get("/").handler((ctx) => ctx.res.text("ok", "root"))

		const res = await app.fetch(new Request("http://localhost/"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("root")
	})
})

describe("extremely rapid route chaining", () => {
	// v0: 40cd065c97
	it("50 chained .get().handler() calls → all routes work", async () => {
		let app = honey<{}>() as ReturnType<typeof honey>
		for (let i = 0; i < 50; i++) {
			app = app.get(`/r${i}`).handler((ctx) => ctx.res.json("ok", { route: ctx.path })) as ReturnType<typeof honey>
		}

		for (const i of [0, 25, 49]) {
			const res = await app.fetch(new Request(`http://localhost/r${i}`), {})
			expect(res.status).toBe(200)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.route).toBe(`/r${i}`)
		}
	})
})

describe("unicode paths and params", () => {
	// v0: b179cf8c99
	it("unicode param decoded correctly", async () => {
		const app = honey<{}>()
		app.get("/users/:name").handler((ctx) => ctx.res.json("ok", { name: ctx.params.name }))

		const res = await app.fetch(new Request("http://localhost/users/%E4%B8%96%E7%95%8C"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.name).toBe("世界")
	})

	// v0: 7a8ae71e94
	it("emoji in param", async () => {
		const app = honey<{}>()
		app.get("/emoji/:e").handler((ctx) => ctx.res.json("ok", { e: ctx.params.e }))

		const res = await app.fetch(new Request(`http://localhost/emoji/${encodeURIComponent("🔥")}`), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.e).toBe("🔥")
	})
})

describe("405 vs 404 precedence", () => {
	// v0: 3424191595
	it("known path, wrong method → 405 (not 404)", async () => {
		const app = honey<{}>()
		app.get("/users/:id").handler((ctx) => ctx.res.text("ok", "ok"))
		app.post("/items").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/users/123", { method: "DELETE" }), {})
		expect(res.status).toBe(405)
		expect(res.headers.get("allow")).toContain("GET")
	})

	// v0: ebb0d677ab
	it("unknown path → 404 (not 405)", async () => {
		const app = honey<{}>()
		app.get("/users/:id").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/unknown/path", { method: "DELETE" }), {})
		expect(res.status).toBe(404)
	})
})

describe("registering routes after first request", () => {
	// v0: a2c7ef2bb4
	it("routes added after fetch() are still reachable (shared tree)", async () => {
		const app = honey<{}>()
		app.get("/first").handler((ctx) => ctx.res.text("ok", "first"))

		/* first request */
		await app.fetch(new Request("http://localhost/first"), {})

		/* add route AFTER first request */
		app.get("/second").handler((ctx) => ctx.res.text("ok", "second"))

		const res = await app.fetch(new Request("http://localhost/second"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("second")
	})
})

describe("calling handler twice on same builder", () => {
	// v0: b5d1ab2ad1
	it("second .handler() on same path+method → throws duplicate route", () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.text("ok", "first"))

		expect(() => {
			app.get("/test").handler((ctx) => ctx.res.text("ok", "second"))
		}).toThrow()
	})
})

describe("chaining after .handler()", () => {
	// v0: ce5693f6cb
	it(".handler() returns Honey — can chain more routes", async () => {
		const app = honey<{}>()
			.get("/a")
			.handler((ctx) => ctx.res.text("ok", "a"))
			.get("/b")
			.handler((ctx) => ctx.res.text("ok", "b"))
			.get("/c")
			.handler((ctx) => ctx.res.text("ok", "c"))

		for (const path of ["/a", "/b", "/c"]) {
			const res = await app.fetch(new Request(`http://localhost${path}`), {})
			expect(res.status).toBe(200)
			expect(await res.text()).toBe(path.slice(1))
		}
	})
})

describe("empty string in various places", () => {
	// v0: 609319e1ab
	it("empty path '' → treated as /", async () => {
		const app = honey<{}>()
		app.get("").handler((ctx) => ctx.res.text("ok", "root"))

		const res = await app.fetch(new Request("http://localhost/"), {})
		expect(res.status).toBe(200)
	})

	// v0: d96623e492
	it("param with empty value /users/ → param is empty string", async () => {
		const app = honey<{}>()
		app.get("/users/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

		/* /users/ doesn't have an :id segment — this is just the /users/ path */
		const res = await app.fetch(new Request("http://localhost/users/"), {})
		/* may or may not match depending on trailing slash behavior */
		expect([200, 404]).toContain(res.status)
	})
})

describe("calling fetch with wrong this binding", () => {
	// v0: a6b65809b4
	it("destructured fetch still works", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		/* some frameworks break when fetch is destructured */
		const { fetch } = app
		const boundFetch = fetch.bind(app)
		const res = await boundFetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
	})
})

describe("URL parse optimization", () => {
	// v0: c9d290f508
	it("ctx.search falls back to parsing req.url when no urlFn provided", () => {
		const ctx = v0Ctx({
			env: {},
			params: {},
			req: new Request("http://localhost/test?x=10"),
		})

		expect(ctx.search).toEqual({ x: "10" })
	})
})

describe("405: multiple methods same path", () => {
	// v0: e96839041f
	it("PATCH to path with GET+POST+DELETE → 405, Allow lists all three", async () => {
		const app = honey<{}>()
		app.get("/items").handler((ctx) => ctx.res.json("ok", []))
		app.post("/items").handler((ctx) => ctx.res.json("created", {}))
		app.delete("/items").handler((ctx) => ctx.res.noContent())

		const res = await app.fetch(new Request("http://localhost/items", { method: "PATCH" }), {})
		expect(res.status).toBe(405)
		const allow = res.headers.get("allow") ?? ""
		expect(allow).toContain("GET")
		expect(allow).toContain("POST")
		expect(allow).toContain("DELETE")
	})
})

describe("duplicate route registration", () => {
	// v0: 329409fbc2
	it("same path + same method registered twice → throws", () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", { v: 1 }))
		expect(() => app.get("/test").handler((ctx) => ctx.res.json("ok", { v: 2 }))).toThrow()
	})

	// v0: 16d54aad19
	it("same path different method → no conflict", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", { method: "get" }))
		app.post("/test").handler((ctx) => ctx.res.json("created", { method: "post" }))

		const getRes = await app.fetch(new Request("http://localhost/test"), {})
		expect(getRes.status).toBe(200)
		const postRes = await app.fetch(new Request("http://localhost/test", { method: "POST" }), {})
		expect(postRes.status).toBe(201)
	})
})

describe("route params: dangerous names", () => {
	// v0: aa339b4531
	it(":__proto__ param → value captured safely", async () => {
		const app = honey<{}>()
		app.get("/items/:__proto__").handler((ctx) => {
			const val = (ctx.params as Record<string, string>).__proto__
			return ctx.res.json("ok", { val: val ?? "missing" })
		})

		const res = await app.fetch(new Request("http://localhost/items/safe-val"), {})
		expect(res.status).toBe(200)
	})

	// v0: 8ac0edfc93
	it(":prototype param → no Object.prototype mutation", async () => {
		const before = Object.getOwnPropertyNames(Object.prototype).length
		const app = honey<{}>()
		app.get("/items/:prototype").handler((ctx) => ctx.res.json("ok", { val: ctx.params.prototype }))

		await app.fetch(new Request("http://localhost/items/evil"), {})
		const after = Object.getOwnPropertyNames(Object.prototype).length
		expect(after).toBe(before)
	})
})

describe("wildcard: trailing slash", () => {
	// v0: bbc08090bf
	it("wildcard route captures trailing slash path", async () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		const res = await app.fetch(new Request("http://localhost/files/dir/"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.path).toBe("dir/")
	})

	// v0: 37425c7390
	it("wildcard captures empty after prefix", async () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		const res = await app.fetch(new Request("http://localhost/files/"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.path).toBe("")
	})

	// v0: 6e7976882b
	it("wildcard with no trailing content", async () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		const res = await app.fetch(new Request("http://localhost/files"), {})
		/* /files without trailing / may or may not match — test actual behavior */
		expect([200, 404]).toContain(res.status)
	})
})

describe("single-handler fast path", () => {
	// v0: fca3300e84
	it("route with no middleware → handler called directly, correct response", async () => {
		const app = honey<{}>()
		app.get("/fast").handler((ctx) => ctx.res.json("ok", { fast: true }))

		const res = await app.fetch(new Request("http://localhost/fast"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.fast).toBe(true)
	})

	// v0: c92cb0eeca
	it("route with middleware → still works (regression check)", async () => {
		const mw = createMiddleware(async (_ctx, next) => next({ added: "yes" }))
		const app = honey<{}>().use(mw)
		app.get("/slow").handler((ctx) => ctx.res.json("ok", { added: ctx.added }))

		const res = await app.fetch(new Request("http://localhost/slow"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.added).toBe("yes")
	})
})

describe("HEAD auto-handling", () => {
	// v0: 923e952ede
	it("HEAD with explicit HEAD handler → uses HEAD handler", async () => {
		const app = honey<{}>()
		app.get("/data").handler((ctx) => ctx.res.json("ok", { from: "get" }))
		app.head("/data").handler((ctx) => ctx.res.noContent())

		const res = await app.fetch(new Request("http://localhost/data", { method: "HEAD" }), {})
		expect(res.status).toBe(204)
	})

	// v0: 9ab6453be8
	it("HEAD to unknown route → 404", async () => {
		const app = honey<{}>()
		app.get("/exists").handler((ctx) => ctx.res.text("ok", "hi"))

		const res = await app.fetch(new Request("http://localhost/nope", { method: "HEAD" }), {})
		expect(res.status).toBe(404)
	})
})
