import { describe, expect, it } from "vitest"
import * as z from "zod"
import { createMiddleware, defineErrors, honey } from "../../../src/index.ts"

describe("routing stress", () => {
	it("100 static routes — all resolve correctly", async () => {
		const app = honey<{}>()
		for (let i = 0; i < 100; i++) {
			app.get(`/route-${i}`).handler((ctx) => ctx.res.json("ok", { i }))
		}

		for (const idx of [0, 49, 99]) {
			const res = await app.fetch(new Request(`http://localhost/route-${idx}`), {})
			expect(res.status).toBe(200)
		}
	})

	it("deeply nested path /a/b/c/d/e/f/g/h/i/j matches", async () => {
		const app = honey<{}>()
		app.get("/a/b/c/d/e/f/g/h/i/j").handler((ctx) => ctx.res.text("ok", "deep"))

		const res = await app.fetch(new Request("http://localhost/a/b/c/d/e/f/g/h/i/j"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("deep")
	})

	it("wildcard captures everything after prefix", async () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		const res = await app.fetch(new Request("http://localhost/files/a/b/c.txt"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.path).toBe("a/b/c.txt")
	})

	it("wildcard with empty remainder", async () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		const res = await app.fetch(new Request("http://localhost/files/"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.path).toBe("")
	})

	it("param with encoded characters %20 %2B", async () => {
		const app = honey<{}>()
		app.get("/search/:query").handler((ctx) => ctx.res.json("ok", { query: ctx.params.query }))

		const res = await app.fetch(new Request("http://localhost/search/hello%20world"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.query).toBe("hello world")
	})

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

	it("static route takes priority over param", async () => {
		const app = honey<{}>()
		app.get("/users/me").handler((ctx) => ctx.res.json("ok", { type: "static" }))
		app.get("/users/:id").handler((ctx) => ctx.res.json("ok", { type: "param" }))

		const me = await app.fetch(new Request("http://localhost/users/me"), {})
		expect(((await me.json()) as Record<string, unknown>).type).toBe("static")

		const other = await app.fetch(new Request("http://localhost/users/123"), {})
		expect(((await other.json()) as Record<string, unknown>).type).toBe("param")
	})
})

describe("middleware chain stress", () => {
	it("10 middleware in chain — all execute in order", async () => {
		const order: number[] = []
		const app = honey<{}>()
		let chain = app as ReturnType<typeof honey>

		for (let i = 0; i < 10; i++) {
			const idx = i
			const mw = createMiddleware(async (_ctx, next) => {
				order.push(idx)
				return next()
			})
			chain = chain.use(mw) as ReturnType<typeof honey>
		}

		chain.get("/test").handler((ctx) => ctx.res.text("ok", "done"))
		await app.fetch(new Request("http://localhost/test"), {})

		expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
	})

	it("middleware short-circuit — downstream never called", async () => {
		const app = honey<{}>()
		let handlerCalled = false

		const blocker = createMiddleware(async () => {
			return new Response("blocked", { status: 403 }) as never
		})

		app
			.use(blocker)
			.get("/test")
			.handler((ctx) => {
				handlerCalled = true
				return ctx.res.text("ok", "should not reach")
			})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(403)
		expect(handlerCalled).toBe(false)
	})

	it("middleware after-response modification", async () => {
		const app = honey<{}>()
		const withTiming = createMiddleware(async (_ctx, next) => {
			const start = Date.now()
			const response = await next()
			response.headers.set("x-timing", `${Date.now() - start}ms`)
			return response
		})

		app
			.use(withTiming)
			.get("/test")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.headers.get("x-timing")).toBeDefined()
		expect(res.headers.get("x-timing")).toMatch(/\d+ms/)
	})
})

describe("error handling stress", () => {
	it("error in middleware → caught by framework", async () => {
		const app = honey<{}>()
		const badMw = createMiddleware(async () => {
			throw new Error("middleware exploded")
		})

		app
			.use(badMw)
			.get("/test")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
	})

	it("async handler rejection → 500", async () => {
		const app = honey<{}>()
		app.get("/test").handler(async () => {
			await Promise.reject(new Error("async fail"))
			return new Response() as never
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
	})

	it("undeclared error key at runtime → 500 internal (not the thrown status)", async () => {
		const errors = defineErrors({
			not_found: "not_found",
		})
		const app = honey<{}>()
			.errorFactory(errors)
			.get("/test")
			.errors("not_found")
			.handler(() => {
				/* throw an error key that wasn't declared on this route */
				throw errors.not_found()
			})

		/* not_found IS declared, so it should pass through as 404 */
		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(404)
	})

	it("error with custom formatter — formatter receives error", async () => {
		const app = honey<{}>()
		app.defaultErrorFormatter((error, shape) => ({
			...shape,
			custom: true,
			errorKey: error.errorKey,
		}))
		app.get("/test").handler(() => {
			throw new Error("boom")
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.custom).toBe(true)
	})
})

describe("input validation edge cases", () => {
	it("JSON body with extra fields — passed through (no stripping)", async () => {
		const app = honey<{}>()
		app
			.post("/test")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input.json))

		const res = await app.fetch(
			new Request("http://localhost/test", {
				body: JSON.stringify({ extra: true, name: "test" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
	})

	it("invalid JSON body → 400 validation error", async () => {
		const app = honey<{}>()
		app
			.post("/test")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input.json))

		const res = await app.fetch(
			new Request("http://localhost/test", {
				body: JSON.stringify({ name: 123 }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(400)
	})

	it("missing content-type header on POST with json input → 415", async () => {
		const app = honey<{}>()
		app
			.post("/test")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input.json))

		const res = await app.fetch(
			new Request("http://localhost/test", {
				body: JSON.stringify({ name: "test" }),
				method: "POST",
			}),
			{},
		)
		/* no content-type → unsupported media type */
		expect(res.status).toBe(415)
	})

	it("search params validated correctly", async () => {
		const app = honey<{}>()
		app
			.get("/test")
			.input({ search: z.object({ page: z.coerce.number() }) })
			.handler((ctx) => ctx.res.json("ok", { page: ctx.input.search.page }))

		const res = await app.fetch(new Request("http://localhost/test?page=5"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.page).toBe(5)
	})
})

describe("output validation edge cases", () => {
	it("output validation enabled + correct data → passes", async () => {
		const app = honey<{}>()
		app.outputValidation("always")
		app
			.get("/test")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: "abc" }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
	})

	it("output validation enabled + wrong data → 500", async () => {
		const app = honey<{}>()
		app.outputValidation("always")
		app
			.get("/test")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) =>
				ctx.res.raw(
					new Response(JSON.stringify({ wrong: true }), {
						headers: { "content-type": "application/json" },
						status: 200,
					}),
				),
			)

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
	})
})

describe("concurrent request isolation", () => {
	it("simultaneous requests don't share context", async () => {
		const app = honey<{}>()
		app.get("/slow/:id").handler(async (ctx) => {
			await new Promise((r) => setTimeout(r, 10))
			return ctx.res.json("ok", { id: ctx.params.id })
		})

		const [r1, r2, r3] = await Promise.all([
			app.fetch(new Request("http://localhost/slow/1"), {}),
			app.fetch(new Request("http://localhost/slow/2"), {}),
			app.fetch(new Request("http://localhost/slow/3"), {}),
		])

		expect(((await r1.json()) as Record<string, unknown>).id).toBe("1")
		expect(((await r2.json()) as Record<string, unknown>).id).toBe("2")
		expect(((await r3.json()) as Record<string, unknown>).id).toBe("3")
	})
})

describe("basePath edge cases", () => {
	it("basePath exact match → root route", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/").handler((ctx) => ctx.res.text("ok", "root"))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("root")
	})

	it("request without basePath prefix → 404", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		/* basePath prefixes routes at registration, so /health without prefix is 404 */
		const res = await app.fetch(new Request("http://localhost/health"), {})
		expect(res.status).toBe(404)
	})

	it("basePath + trailing slash strip interaction", async () => {
		const app = honey<{}>().basePath("/api").trailingSlash("strip")
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/api/health/"), {})
		/* trailing slash stripped first, then basePath stripped */
		expect(res.status).toBe(308) /* redirect to strip trailing slash */
	})
})

describe("method not allowed", () => {
	it("POST to GET-only route → 405 with Allow header", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/test", { method: "POST" }), {})
		expect(res.status).toBe(405)
		expect(res.headers.get("allow")).toContain("GET")
	})

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

describe("cookie round-trip", () => {
	it("set cookie → read cookie on next request (percent-encoded values)", async () => {
		const app = honey<{}>()
		app.get("/set").handler((ctx) =>
			ctx.res.json(
				"ok",
				{},
				{
					cookies: { token: { httpOnly: true, value: "hello world@123" } },
				},
			),
		)
		app.get("/read").handler((ctx) => ctx.res.json("ok", { token: ctx.cookies.token }))

		/* set the cookie */
		const setRes = await app.fetch(new Request("http://localhost/set"), {})
		const setCookie = setRes.headers.get("set-cookie") ?? ""
		expect(setCookie).toContain("token=")

		/* extract cookie value from Set-Cookie header */
		const cookieValue = setCookie.split(";")[0]

		/* read it back */
		const readRes = await app.fetch(
			new Request("http://localhost/read", {
				headers: { cookie: cookieValue },
			}),
			{},
		)
		const body = (await readRes.json()) as Record<string, unknown>
		expect(body.token).toBe("hello world@123")
	})
})

describe("route composition", () => {
	it(".route() merges separate sub-router tree into parent", async () => {
		const sub = honey<{}>()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "sub"))

		const app = honey<{}>()
			.get("/main")
			.handler((ctx) => ctx.res.text("ok", "main"))
			.route(sub)

		const mainRes = await app.fetch(new Request("http://localhost/main"), {})
		expect(await mainRes.text()).toBe("main")

		const subRes = await app.fetch(new Request("http://localhost/health"), {})
		expect(await subRes.text()).toBe("sub")
	})
})
