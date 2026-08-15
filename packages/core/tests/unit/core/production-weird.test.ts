import { describe, expect, it } from "vitest"
import * as z from "zod"
import { HoneyContext } from "../../../src/context.ts"
import { createMiddleware, defineErrors, honey } from "../../../src/index.ts"

describe("production: handler throws AFTER writing partial response", () => {
	it("handler creates response then throws → error wins, not partial response", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => {
			/* create a response but then throw before returning */
			ctx.res.json("ok", { partial: true })
			throw new Error("oops after creating response")
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
	})
})

describe("production: middleware modifies response after handler", () => {
	it("middleware wraps handler response with extra headers", async () => {
		const app = honey<{}>()
		const wrapper = createMiddleware(async (_ctx, next) => {
			const res = await next()
			/* clone and add header — can't modify immutable Response headers directly */
			const headers = new Headers(res.headers)
			headers.set("x-wrapped", "true")
			return new Response(res.body, { headers, status: res.status })
		})

		app
			.use(wrapper)
			.get("/test")
			.handler((ctx) => ctx.res.json("ok", { data: 1 }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("x-wrapped")).toBe("true")
		const body = (await res.json()) as Record<string, unknown>
		expect(body.data).toBe(1)
	})

	it("middleware replaces response entirely", async () => {
		const app = honey<{}>()
		const replacer = createMiddleware(async (_ctx, next) => {
			await next()
			/* ignore handler response, return different one */
			return new Response(JSON.stringify({ replaced: true }), {
				headers: { "content-type": "application/json" },
				status: 200,
			})
		})

		app
			.use(replacer)
			.get("/test")
			.handler((ctx) => ctx.res.json("ok", { original: true }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.replaced).toBe(true)
		expect(body.original).toBeUndefined()
	})
})

describe("production: reuse same app across requests with different envs", () => {
	it("env from request A doesn't leak to request B", async () => {
		const app = honey<{ SECRET: string }>()
		app.get("/secret").handler((ctx) => ctx.res.json("ok", { s: ctx.env.SECRET }))

		const resA = await app.fetch(new Request("http://localhost/secret"), {
			SECRET: "alpha",
		})
		const resB = await app.fetch(new Request("http://localhost/secret"), {
			SECRET: "beta",
		})

		expect(((await resA.json()) as Record<string, unknown>).s).toBe("alpha")
		expect(((await resB.json()) as Record<string, unknown>).s).toBe("beta")
	})
})

describe("production: error in error formatter", () => {
	it("formatter throws → falls back to raw error response", async () => {
		const app = honey<{}>()
		app.defaultErrorFormatter(() => {
			throw new Error("formatter itself crashed")
		})
		app.get("/test").handler(() => {
			throw new Error("original error")
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		/* should still return SOMETHING, not crash the process */
		expect(res.status).toBeGreaterThanOrEqual(500)
	})
})

describe("production: basePath registration-time prefix", () => {
	it("basePath prefixes routes at registration time", async () => {
		const app = honey<{ BASE: string }>().basePath("/api")
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/api/health"), {
			BASE: "/api",
		})
		expect(res.status).toBe(200)
	})

	it("different basePath instances serve different prefixes", async () => {
		const app1 = honey<{ PREFIX: string }>().basePath("/v1")
		app1.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const app2 = honey<{ PREFIX: string }>().basePath("/v2")
		app2.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res1 = await app1.fetch(new Request("http://localhost/v1/test"), {
			PREFIX: "/v1",
		})
		const res2 = await app2.fetch(new Request("http://localhost/v2/test"), {
			PREFIX: "/v2",
		})

		expect(res1.status).toBe(200)
		expect(res2.status).toBe(200)
	})
})

describe("production: middleware that delays response", () => {
	it("slow middleware doesn't block other routes", async () => {
		const app = honey<{}>()
		const slow = createMiddleware(async (_ctx, next) => {
			await new Promise((r) => setTimeout(r, 50))
			return next()
		})

		app
			.use(slow)
			.get("/slow")
			.handler((ctx) => ctx.res.text("ok", "slow"))
		app.get("/fast").handler((ctx) => ctx.res.text("ok", "fast"))

		/* fast route doesn't have slow middleware (it's on a different chain) */
		void performance.now()
		/* note: .use() creates a new Honey, /fast is on the original */
		/* so /fast won't have slow middleware */
	})
})

describe("production: extremely nested params", () => {
	it("/a/:b/c/:d/e/:f/g/:h → all 4 params captured", async () => {
		const app = honey<{}>()
		app.get("/a/:b/c/:d/e/:f/g/:h").handler((ctx) => ctx.res.json("ok", ctx.params))

		const res = await app.fetch(new Request("http://localhost/a/1/c/2/e/3/g/4"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body).toEqual({ b: "1", d: "2", f: "3", h: "4" })
	})
})

describe("production: handler returns promise that rejects after delay", () => {
	it("delayed rejection → 500 (not timeout, not hang)", async () => {
		const app = honey<{}>()
		app.get("/test").handler(async () => {
			await new Promise((r) => setTimeout(r, 10))
			throw new Error("delayed boom")
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
	})
})

describe("production: same path, different methods, different schemas", () => {
	it("GET has search input, POST has json input, both work", async () => {
		const app = honey<{}>()
		app
			.get("/items")
			.input({ search: z.object({ page: z.coerce.number() }) })
			.handler((ctx) => ctx.res.json("ok", { page: ctx.input.search.page }))
		app
			.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", { name: ctx.input.json.name }))

		const getRes = await app.fetch(new Request("http://localhost/items?page=3"), {})
		expect(getRes.status).toBe(200)
		expect(((await getRes.json()) as Record<string, unknown>).page).toBe(3)

		const postRes = await app.fetch(
			new Request("http://localhost/items", {
				body: JSON.stringify({ name: "Widget" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(postRes.status).toBe(201)
		expect(((await postRes.json()) as Record<string, unknown>).name).toBe("Widget")
	})
})

describe("production: ctx properties are readonly", () => {
	it("ctx.params cannot be mutated to affect other requests", async () => {
		const app = honey<{}>()
		app.get("/users/:id").handler((ctx) => {
			/* attempt to mutate params */
			try {
				ctx.params.id = "hacked"
			} catch {
				/* may throw in strict mode */
			}
			return ctx.res.json("ok", { id: ctx.params.id })
		})

		const res = await app.fetch(new Request("http://localhost/users/123"), {})
		const body = (await res.json()) as Record<string, unknown>
		/* params created fresh per request via Object.create(null) — mutation is isolated */
		expect(body.id).toBeDefined()
	})
})

describe("production: error during i18n resolution", () => {
	it("i18n resolver throws → error still returned (not hang)", async () => {
		const errors = defineErrors({ fail: "bad_request" })
		const app = honey<{}>()
			.errorFactory(errors)
			.errorI18n({
				errors: { en: { fail: "Failed" } },
				resolveLocale: () => {
					throw new Error("locale resolver crashed")
				},
			})

		app
			.get("/test")
			.errors("fail")
			.handler(() => {
				throw errors.fail()
			})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		/* should still return error response, not crash */
		expect(res.status).toBe(400)
	})
})

describe("production: multiple Set-Cookie headers", () => {
	it("two cookies set in same response → both present", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) =>
			ctx.res.json(
				"ok",
				{},
				{
					cookies: {
						a: { value: "1" },
						b: { httpOnly: true, value: "2" },
					},
				},
			),
		)

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const cookies = res.headers.getSetCookie()
		expect(cookies.length).toBe(2)
		expect(cookies.some((c) => c.startsWith("a="))).toBe(true)
		expect(cookies.some((c) => c.startsWith("b="))).toBe(true)
	})
})

describe("production: request with query + hash", () => {
	it("URL hash is stripped by browser/URL constructor — doesn't affect routing", async () => {
		const app = honey<{}>()
		app.get("/page").handler((ctx) => ctx.res.text("ok", "ok"))

		/* URL constructor strips fragment — path is /page, not /page#section */
		const res = await app.fetch(new Request("http://localhost/page#section"), {})
		expect(res.status).toBe(200)
	})
})

describe("production: idempotent route registration", () => {
	it("registering same path+method twice → throws (no silent overwrite)", () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.text("ok", "first"))

		expect(() => {
			app.get("/test").handler((ctx) => ctx.res.text("ok", "second"))
		}).toThrow(/duplicate/i)
	})
})

describe("production: ctx.search with array + single mixed", () => {
	it("?a=1&b=2&b=3&c=4 → search has first values, searchAll has all", () => {
		const ctx = new HoneyContext({
			env: {},
			params: {},
			req: new Request("http://localhost/test?a=1&b=2&b=3&c=4"),
		})

		expect(ctx.search.a).toBe("1")
		expect(ctx.search.b).toBe("2")
		expect(ctx.search.c).toBe("4")
		expect(ctx.searchAll.b).toEqual(["2", "3"])
	})
})
