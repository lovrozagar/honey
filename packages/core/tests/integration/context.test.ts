import { describe, expect, expectTypeOf, it } from "vitest"
import { honey } from "../../src/routing/app.ts"

describe("ctx.search uses pre-parsed URL", () => {
	// v0: cfceceb40b
	it("fetch provides pre-parsed URL → ctx.search uses it", async () => {
		const app = honey<{}>()
		app.get("/search").handler((ctx) => ctx.res.json("ok", { q: ctx.search.q }))

		/* app.fetch pre-parses the URL before passing to HoneyContext */
		const res = await app.fetch(new Request("http://localhost/search?q=from-url"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.q).toBe("from-url")
	})
})

describe("URL with fragment", () => {
	// v0: 8151808266
	it("URL with #fragment → fragment stripped, route matches", async () => {
		const app = honey<{}>()
		app.get("/page").handler((ctx) => ctx.res.json("ok", { matched: true }))

		/* Note: new URL("http://localhost/page#section") strips the fragment */
		const res = await app.fetch(new Request("http://localhost/page#section"), {})
		expect(res.status).toBe(200)
	})
})

describe("ctx.headers caching", () => {
	// v0: 4f155bcec2
	it("multiple accesses return same object reference", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => {
			const h1 = ctx.headers
			const h2 = ctx.headers
			return ctx.res.json("ok", { same: h1 === h2 })
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, boolean>
		expect(data.same).toBe(true)
	})
})

describe("ctx.search caching", () => {
	// v0: 78e98994c3
	it("multiple accesses return same object reference", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => {
			const s1 = ctx.search
			const s2 = ctx.search
			return ctx.res.json("ok", { same: s1 === s2 })
		})

		const res = await app.fetch(new Request("http://localhost/test?q=hello"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, boolean>
		expect(data.same).toBe(true)
	})
})

describe("ctx.search edge cases", () => {
	// v0: 4c42cc1508
	it("3+ occurrences of same param → searchAll returns array", async () => {
		const app = honey<{}>()
		app.get("/search").handler((ctx) => ctx.res.json("ok", { tags: ctx.searchAll.tags }))

		const res = await app.fetch(new Request("http://localhost/search?tags=a&tags=b&tags=c"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string[]>
		expect(data.tags).toEqual(["a", "b", "c"])
	})

	// v0: 4b97585409
	it("single param stays as string (not array)", async () => {
		const app = honey<{}>()
		app.get("/search").handler((ctx) => ctx.res.json("ok", { q: ctx.search.q }))

		const res = await app.fetch(new Request("http://localhost/search?q=hello"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.q).toBe("hello")
		expect(typeof data.q).toBe("string")
	})
})

describe("ctx.headers lazy init", () => {
	// v0: e505b572b9
	it("ctx.headers returns all request headers as record", async () => {
		const app = honey<{}>()
		app.get("/h").handler((ctx) =>
			ctx.res.json("ok", {
				auth: ctx.headers.authorization,
				ct: ctx.headers["content-type"],
				custom: ctx.headers["x-custom"],
			}),
		)

		const res = await app.fetch(
			new Request("http://localhost/h", {
				headers: {
					authorization: "Bearer tok",
					"x-custom": "hello",
				},
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.auth).toBe("Bearer tok")
		expect(data.custom).toBe("hello")
	})
})

describe("ctx.routePattern and ctx.path", () => {
	// v0: 7419f98248
	it("ctx.path is the matched path, ctx.routePattern is the template", async () => {
		const app = honey<{}>()
		app.get("/users/:id/posts/:postId").handler((ctx) =>
			ctx.res.json("ok", {
				path: ctx.path,
				routePattern: ctx.routePattern,
			}),
		)

		const res = await app.fetch(new Request("http://localhost/users/42/posts/7"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.routePattern).toBe("/users/:id/posts/:postId")
		expect(data.path).toBe("/users/42/posts/7")
	})
})

describe("route metadata", () => {
	// v0: 208fab9eae
	it("ctx.meta contains route metadata (frozen)", async () => {
		const app = honey<{}>().meta<{ auth?: boolean; rateLimit?: number }>()
		app
			.get("/api")
			.meta({ auth: true, rateLimit: 100 })
			.handler((ctx) => ctx.res.json("ok", { meta: ctx.meta }))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, Record<string, unknown>>
		expect(data.meta.auth).toBe(true)
		expect(data.meta.rateLimit).toBe(100)
	})
})

describe("ctx.background / waitUntil", () => {
	// v0: dd41ef2833
	it("background with waitUntil → delegates to waitUntil", async () => {
		let backgroundRan = false
		const app = honey<{}>()
		app.get("/bg").handler((ctx) => {
			ctx.background(
				new Promise<void>((resolve) => {
					backgroundRan = true
					resolve()
				}),
			)
			return ctx.res.json("ok", {})
		})

		const waitedPromises: Promise<unknown>[] = []
		await app.fetch(
			new Request("http://localhost/bg"),
			{},
			{
				waitUntil: (p) => waitedPromises.push(p),
			},
		)
		/* waitUntil should have received the background promise */
		expect(waitedPromises.length).toBe(1)
		await Promise.all(waitedPromises)
		expect(backgroundRan).toBe(true)
	})

	// v0: ac413420f7
	it("background without waitUntil → promise still runs (fire-and-forget)", async () => {
		let backgroundRan = false
		const app = honey<{}>()
		app.get("/bg").handler((ctx) => {
			ctx.background(
				new Promise<void>((resolve) => {
					setTimeout(() => {
						backgroundRan = true
						resolve()
					}, 10)
				}),
			)
			return ctx.res.json("ok", {})
		})

		await app.fetch(new Request("http://localhost/bg"), {})
		/* wait for the background task */
		await new Promise((r) => setTimeout(r, 50))
		expect(backgroundRan).toBe(true)
	})
})

describe("ctx.background / waitUntil (2)", () => {
	// v0: d4bf8a717c
	it("background with rejecting promise → doesn't crash", async () => {
		const app = honey<{}>()
		app.get("/bg").handler((ctx) => {
			ctx.background(Promise.reject(new Error("bg fail")))
			return ctx.res.json("ok", {})
		})

		/* should not crash the request */
		const res = await app.fetch(new Request("http://localhost/bg"), {})
		expect(res.status).toBe(200)
	})
})

describe("ctx.executionCtx", () => {
	// v0: d62bde9180
	it("executionCtx available when provided", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", { hasCtx: ctx.executionCtx !== undefined }))

		const res = await app.fetch(new Request("http://localhost/test"), {}, { waitUntil: () => {} })
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, boolean>
		expect(data.hasCtx).toBe(true)
	})

	// v0: 0f66931f2b
	it("executionCtx undefined when not provided", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", { hasCtx: ctx.executionCtx !== undefined }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, boolean>
		expect(data.hasCtx).toBe(false)
	})
})

describe("concurrent requests with different envs", () => {
	// v0: 06475db60a
	it("each request2 sees its own env", async () => {
		const app = honey<{ TENANT: string }>()
		app.get("/tenant").handler(async (ctx) => {
			await new Promise((r) => setTimeout(r, Math.random() * 10))
			return ctx.res.json("ok", { tenant: ctx.env.TENANT })
		})

		const promises = ["alpha", "beta", "gamma"].map((tenant) =>
			app.fetch(new Request("http://localhost/tenant"), { TENANT: tenant }),
		)
		const results = await Promise.all(promises)

		for (let i = 0; i < 3; i++) {
			const data = (await results[i].json()) as Record<string, string>
			expect(data.tenant).toBe(["alpha", "beta", "gamma"][i])
		}
	})
})

describe("3A: _ internals hidden from public type", () => {
	// v0: e76708eb15
	it("_tree not on public Honey type", () => {
		const app = honey<{}>()
		type App = typeof app
		type HasTree = "_tree" extends keyof App ? true : false
		expectTypeOf<HasTree>().toEqualTypeOf<false>()
	})

	// v0: ef306ac48f
	it("_factory not on public Honey type", () => {
		const app = honey<{}>()
		type App = typeof app
		type Has = "_factory" extends keyof App ? true : false
		expectTypeOf<Has>().toEqualTypeOf<false>()
	})

	// v0: b399066b8d
	it("_boundaryKey not on public Honey type", () => {
		const app = honey<{}>()
		type App = typeof app
		type Has = "_boundaryKey" extends keyof App ? true : false
		expectTypeOf<Has>().toEqualTypeOf<false>()
	})

	// v0: 826cf2dd72
	it("_markWsRoutes not on public Honey type", () => {
		const app = honey<{}>()
		type App = typeof app
		type Has = "_markWsRoutes" extends keyof App ? true : false
		expectTypeOf<Has>().toEqualTypeOf<false>()
	})
})

describe("3A: _ internals hidden from public type (2)", () => {
	// v0: 557604c912
	it("public API methods still accessible", () => {
		const app = honey<{}>()
		type App = typeof app
		type HasGet = "get" extends keyof App ? true : false
		type HasPost = "post" extends keyof App ? true : false
		type HasUse = "use" extends keyof App ? true : false
		type HasMeta = "meta" extends keyof App ? true : false
		type HasContext = "context" extends keyof App ? true : false
		type HasFetch = "fetch" extends keyof App ? true : false
		type HasRoute = "route" extends keyof App ? true : false
		type HasBasePath = "basePath" extends keyof App ? true : false

		expectTypeOf<HasGet>().toEqualTypeOf<true>()
		expectTypeOf<HasPost>().toEqualTypeOf<true>()
		expectTypeOf<HasUse>().toEqualTypeOf<true>()
		expectTypeOf<HasMeta>().toEqualTypeOf<true>()
		expectTypeOf<HasContext>().toEqualTypeOf<true>()
		expectTypeOf<HasFetch>().toEqualTypeOf<true>()
		expectTypeOf<HasRoute>().toEqualTypeOf<true>()
		expectTypeOf<HasBasePath>().toEqualTypeOf<true>()
	})

	// v0: 90d5fa2c11
	it("runtime still works — internals accessible via framework casts", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", { ok: true }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
	})
})

describe("env edge cases", () => {
	// v0: 8e7138fed3
	it("env with prototype methods doesn't interfere", async () => {
		const app = honey<{ toString: string }>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", { val: ctx.env.toString }))

		const res = await app.fetch(new Request("http://localhost/test"), {
			toString: "custom",
		})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.val).toBe("custom")
	})

	// v0: bb001daba7
	it("empty env object works", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
	})
})

describe("what if ctx is used after response is sent", () => {
	// v0: cecf528269
	it("reading ctx.search after returning response → no crash", async () => {
		let searchAfter: unknown
		const app = honey<{}>()
		app.get("/test").handler((ctx) => {
			const response = ctx.res.text("ok", "done")
			/* access ctx after creating response — should still work */
			searchAfter = ctx.search
			return response
		})

		await app.fetch(new Request("http://localhost/test?a=1"), {})
		expect(searchAfter).toEqual({ a: "1" })
	})
})
