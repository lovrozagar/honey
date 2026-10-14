import { describe, expect, it } from "vitest"
import { honey } from "../../src/routing/app.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"

describe("middleware double next()", () => {
	// v0: 5769e0c401
	it("calling next() twice → throws", async () => {
		const doubleMw = createMiddleware(async (_ctx, next) => {
			const res1 = await next()
			/* second call should throw */
			try {
				await next()
			} catch {
				/* expected */
			}
			return res1
		})

		const app = honey<{}>().use(doubleMw)
		app.get("/test").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		/* first next() succeeded, so response should be 200 */
		expect(res.status).toBe(200)
	})
})

describe("middleware additions — diverse types", () => {
	// v0: cf0b992a69
	it("additions with arrays, numbers, booleans, null", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			return next({
				count: 42,
				isAdmin: true,
				nothing: null,
				tags: ["a", "b"],
			})
		})

		const app = honey<{}>().use(mw)
		app.get("/test").handler((ctx) =>
			ctx.res.json("ok", {
				count: ctx.count,
				isAdmin: ctx.isAdmin,
				nothing: ctx.nothing,
				tags: ctx.tags,
			}),
		)

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.count).toBe(42)
		expect(data.isAdmin).toBe(true)
		expect(data.nothing).toBeNull()
		expect(data.tags).toEqual(["a", "b"])
	})
})

describe("global vs chain middleware behavior", () => {
	// v0: b2e28f0085
	it("chain middleware runs on 404, route middleware does not", async () => {
		const order: string[] = []

		const chainMw = createMiddleware(async (_ctx, next) => {
			order.push("chain")
			return next()
		})
		const routeMw = createMiddleware(async (_ctx, next) => {
			order.push("route")
			return next()
		})

		const app = honey<{}>().use(chainMw)
		app
			.get("/exists")
			.use(routeMw)
			.handler((ctx) => {
				order.push("handler")
				return ctx.res.json("ok", {})
			})

		/* 404 → only chain middleware runs */
		order.length = 0
		await app.fetch(new Request("http://localhost/nope"), {})
		expect(order).toEqual(["chain"])

		/* matched → chain + route + handler */
		order.length = 0
		await app.fetch(new Request("http://localhost/exists"), {})
		expect(order).toEqual(["chain", "route", "handler"])
	})
})

describe("pure zero-middleware fast path", () => {
	// v0: 218eee8dac
	it("app with no middleware at all → handler called directly", async () => {
		const app = honey<{}>()
		app.get("/fast").handler((ctx) => ctx.res.json("ok", { fast: true }))

		const res = await app.fetch(new Request("http://localhost/fast"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, boolean>
		expect(data.fast).toBe(true)
	})

	// v0: 066c4587f9
	it("zero-middleware route still gets correct ctx properties", async () => {
		const app = honey<{ DB: string }>()
		app.get("/users/:id").handler((ctx) =>
			ctx.res.json("ok", {
				db: ctx.env.DB,
				hasRes: typeof ctx.res.json === "function",
				id: ctx.params.id,
				path: ctx.path,
				routePattern: ctx.routePattern,
			}),
		)

		const res = await app.fetch(new Request("http://localhost/users/42"), { DB: "postgres" })
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.id).toBe("42")
		expect(data.db).toBe("postgres")
		expect(data.path).toBe("/users/42")
		expect(data.routePattern).toBe("/users/:id")
		expect(data.hasRes).toBe(true)
	})
})

describe("middleware modifying response status", () => {
	// v0: a8a71bfe29
	it("middleware wraps response with different status", async () => {
		const wrapMw = createMiddleware(async (_ctx, next) => {
			const res = await next()
			/* force 202 Accepted for all responses */
			return new Response(res.body, {
				headers: res.headers,
				status: 202,
			})
		})

		const app = honey<{}>().use(wrapMw)
		app.get("/api").handler((ctx) => ctx.res.json("ok", { data: true }))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(202)
		const data = (await res.json()) as Record<string, boolean>
		expect(data.data).toBe(true)
	})
})

describe("middleware overwriting same ctx key", () => {
	// v0: 442fc94589
	it("two middlewares setting same key → last value wins", async () => {
		const mw1 = createMiddleware(async (_ctx, next) => next({ version: "v1" }))
		const mw2 = createMiddleware(async (_ctx, next) => next({ version: "v2" }))

		const app = honey<{}>().use(mw1).use(mw2)
		app.get("/test").handler((ctx) => ctx.res.json("ok", { version: ctx.version }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.version).toBe("v2")
	})
})

describe("ctx mutations accumulate across deep chain", () => {
	// v0: 07e91fb5ad
	it("5 middlewares each adding unique key → all visible in handler", async () => {
		const app = honey<{}>()
			.use(createMiddleware(async (_ctx, next) => next({ a: 1 })))
			.use(createMiddleware(async (_ctx, next) => next({ b: 2 })))
			.use(createMiddleware(async (_ctx, next) => next({ c: 3 })))
			.use(createMiddleware(async (_ctx, next) => next({ d: 4 })))
			.use(createMiddleware(async (_ctx, next) => next({ e: 5 })))

		app.get("/test").handler((ctx) =>
			ctx.res.json("ok", {
				a: ctx.a,
				b: ctx.b,
				c: ctx.c,
				d: ctx.d,
				e: ctx.e,
			}),
		)

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, number>
		expect(data.a).toBe(1)
		expect(data.b).toBe(2)
		expect(data.c).toBe(3)
		expect(data.d).toBe(4)
		expect(data.e).toBe(5)
	})
})

describe("slow middleware", () => {
	// v0: eeedfe98fd
	it("middleware with 50ms delay → response still correct", async () => {
		const slowMw = createMiddleware(async (_ctx, next) => {
			await new Promise((r) => setTimeout(r, 50))
			return next({ delayed: true })
		})

		const app = honey<{}>().use(slowMw)
		app.get("/api").handler((ctx) => ctx.res.json("ok", { delayed: ctx.delayed }))

		const start = performance.now()
		const res = await app.fetch(new Request("http://localhost/api"), {})
		const elapsed = performance.now() - start

		expect(res.status).toBe(200)
		expect(elapsed).toBeGreaterThan(40)
		const data = (await res.json()) as Record<string, boolean>
		expect(data.delayed).toBe(true)
	})
})

describe("middleware next() — empty additions", () => {
	// v0: 719374c20b
	it("next() → no ctx mutation, response passes through", async () => {
		const mw = createMiddleware(async (_ctx, next) => next())

		const app = honey<{}>().use(mw)
		app.get("/test").handler((ctx) => ctx.res.json("ok", { method: ctx.req.method }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.method).toBe("GET")
	})
})

describe("middleware interaction with 404/405", () => {
	// v0: 90604cf322
	it("chain middleware runs for 404 responses", async () => {
		let middlewareRan = false
		const app = honey<{}>().use(
			createMiddleware(async (_ctx, next) => {
				middlewareRan = true
				return next()
			}),
		)
		app.get("/exists").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/nope"), {})
		expect(res.status).toBe(404)
		expect(middlewareRan).toBe(true)
	})

	// v0: 493c1a37f1
	it("chain middleware runs for 405 responses", async () => {
		let middlewareRan = false
		const app = honey<{}>().use(
			createMiddleware(async (_ctx, next) => {
				middlewareRan = true
				return next()
			}),
		)
		app.get("/resource").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/resource", { method: "DELETE" }), {})
		expect(res.status).toBe(405)
		expect(middlewareRan).toBe(true)
	})
})

describe("middleware short-circuit without next()", () => {
	// v0: 8eaf16daf6
	it("middleware returning Response directly → works", async () => {
		const shortCircuit = createMiddleware(async () => {
			return new Response(JSON.stringify({ blocked: true }), {
				headers: { "content-type": "application/json" },
				status: 401,
			})
		})

		const app = honey<{}>().use(shortCircuit)
		app.get("/protected").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/protected"), {})
		expect(res.status).toBe(401)
		const data = (await res.json()) as Record<string, boolean>
		expect(data.blocked).toBe(true)
	})
})

describe("reserved key protection completeness", () => {
	// v0: 7c9e100a0f
	it("next({ req: ... }) doesn't overwrite ctx.req", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			const fakeReq = new Request("http://evil.com/hacked")
			return next({ req: fakeReq })
		})

		const app = honey<{}>().use(mw)
		app.get("/test").handler((ctx) => ctx.res.json("ok", { url: ctx.req.url }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.url).toContain("localhost")
		expect(data.url).not.toContain("evil.com")
	})

	// v0: 29fd214dac
	it("next({ env: ... }) doesn't overwrite ctx.env", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			return next({ env: { SECRET: "stolen" } })
		})

		const app = honey<{ DB: string }>().use(mw)
		app.get("/test").handler((ctx) => ctx.res.json("ok", { db: ctx.env.DB }))

		const res = await app.fetch(new Request("http://localhost/test"), { DB: "real-db" })
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.db).toBe("real-db")
	})

	// v0: a2a82f9c2a
	it("next({ res: ... }) doesn't overwrite ctx.res", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			return next({ res: "fake-res" })
		})

		const app = honey<{}>().use(mw)
		app.get("/test").handler((ctx) => ctx.res.json("ok", { type: typeof ctx.res.json }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.type).toBe("function")
	})
})

describe("reserved key protection completeness (2)", () => {
	// v0: ae9413ff7d
	it("next({ params: ... }) doesn't overwrite ctx.params", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			return next({ params: { id: "hijacked" } })
		})

		const app = honey<{}>().use(mw)
		app.get("/items/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

		const res = await app.fetch(new Request("http://localhost/items/42"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.id).toBe("42")
	})

	// v0: 7c3d73cf11
	it("next({ search: ... }) doesn't overwrite ctx.search", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			return next({ search: { q: "hacked" } })
		})

		const app = honey<{}>().use(mw)
		app.get("/s").handler((ctx) => ctx.res.json("ok", { q: ctx.search.q }))

		const res = await app.fetch(new Request("http://localhost/s?q=real"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.q).toBe("real")
	})

	// v0: 7b0b7ae2b7
	it("next({ background: ... }) doesn't overwrite ctx.background", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			return next({ background: "not-a-function" })
		})

		const app = honey<{}>().use(mw)
		app.get("/test").handler((ctx) => {
			/* background should still be a function */
			return ctx.res.json("ok", { type: typeof ctx.background })
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.type).toBe("function")
	})
})

describe("deep middleware chains", () => {
	// v0: 619e672b14
	it("20 middlewares in chain → all execute in order", async () => {
		const order: number[] = []
		let app = honey<{}>()
		for (let i = 0; i < 20; i++) {
			const idx = i
			app = app.use(
				createMiddleware(async (_ctx, next) => {
					order.push(idx)
					return next()
				}),
			) as typeof app
		}
		app.get("/test").handler((ctx) => ctx.res.json("ok", { order }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, number[]>
		expect(data.order).toEqual(Array.from({ length: 20 }, (_, i) => i))
	})
})

describe("all 8 reserved keys overwrite attempt", () => {
	// v0: 2b0757df51
	it("next() with all reserved keys → all silently dropped", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			return next({
				background: "fake",
				cookies: "fake",
				env: "fake",
				headers: "fake",
				params: "fake",
				req: "fake",
				res: "fake",
				search: "fake",
			})
		})

		const app = honey<{ DB: string }>().use(mw)
		app.get("/test").handler((ctx) =>
			ctx.res.json("ok", {
				bgType: typeof ctx.background,
				envType: typeof ctx.env,
				reqType: typeof ctx.req,
				resType: typeof ctx.res,
			}),
		)

		const res = await app.fetch(new Request("http://localhost/test"), { DB: "real" })
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.bgType).toBe("function")
		expect(data.envType).toBe("object")
		expect(data.reqType).toBe("object")
		expect(data.resType).toBe("object")
	})
})
