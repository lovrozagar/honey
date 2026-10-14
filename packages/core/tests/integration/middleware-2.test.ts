import { describe, expect, it } from "vitest"
import { honey } from "../../src/routing/app.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"

describe("route-level middleware chaining", () => {
	// v0: c30939bc66
	it("multiple .use() on route → all execute in order", async () => {
		const order: string[] = []
		const mw1 = createMiddleware(async (_ctx, next) => {
			order.push("mw1")
			return next({ one: true })
		})
		const mw2 = createMiddleware(async (_ctx, next) => {
			order.push("mw2")
			return next({ two: true })
		})

		const app = honey<{}>()
		app
			.get("/test")
			.use(mw1)
			.use(mw2)
			.handler((ctx) => {
				order.push("handler")
				return ctx.res.json("ok", { one: ctx.one, two: ctx.two })
			})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		expect(order).toEqual(["mw1", "mw2", "handler"])
		const data = (await res.json()) as Record<string, boolean>
		expect(data.one).toBe(true)
		expect(data.two).toBe(true)
	})
})

describe("middleware response modification", () => {
	// v0: b0f1262e67
	it("middleware replaces response entirely", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			const res = await next()
			if (res.status === 404) {
				return new Response(JSON.stringify({ custom: true }), {
					headers: { "content-type": "application/json" },
					status: 200,
				})
			}
			return res
		})

		const app = honey<{}>().use(mw)
		app.get("/exists").handler((ctx) => ctx.res.json("ok", {}))

		/* existing route → normal response */
		const r1 = await app.fetch(new Request("http://localhost/exists"), {})
		expect(r1.status).toBe(200)

		/* 404 → middleware replaces with custom response */
		const r2 = await app.fetch(new Request("http://localhost/nope"), {})
		expect(r2.status).toBe(200)
		const data = (await r2.json()) as Record<string, boolean>
		expect(data.custom).toBe(true)
	})
})

describe("chain vs route middleware ordering", () => {
	// v0: 36dad156f7
	it("chain middleware → route middleware → handler", async () => {
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
			.get("/test")
			.use(routeMw)
			.handler((ctx) => {
				order.push("handler")
				return ctx.res.json("ok", { order })
			})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string[]>
		expect(data.order).toEqual(["chain", "route", "handler"])
	})
})

describe("middleware additions visible in handler", () => {
	// v0: 31b9b2ca5c
	it("multiple middlewares each add context → all visible", async () => {
		const mw1 = createMiddleware(async (_ctx, next) => next({ db: "postgres" }))
		const mw2 = createMiddleware(async (_ctx, next) => next({ cache: "redis" }))

		const app = honey<{}>().use(mw1).use(mw2)
		app.get("/test").handler((ctx) => ctx.res.json("ok", { cache: ctx.cache, db: ctx.db }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.db).toBe("postgres")
		expect(data.cache).toBe("redis")
	})
})

describe("Symbol and non-string keys", () => {
	// v0: 48ec040348
	it("middleware additions with numeric keys", async () => {
		const app = honey<{}>()
		const mw = createMiddleware(async (_ctx, next) => {
			return next({ count: 42 })
		})
		app
			.use(mw)
			.get("/test")
			.handler((ctx) => ctx.res.json("ok", { count: ctx.count }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.count).toBe(42)
	})
})

describe("empty handler chain edge cases", () => {
	// v0: 305088dc1e
	it("app with only middleware, no routes → 404", async () => {
		const mw = createMiddleware(async (_ctx, next) => next({ added: true }))
		const app = honey<{}>().use(mw)

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(404)
	})
})

describe("what if middleware mutates ctx in unexpected ways", () => {
	// v0: b50f04581b
	it("middleware deletes ctx.req → handler still gets 500, not crash", async () => {
		const app = honey<{}>()
		const evil = createMiddleware(async (ctx, next) => {
			delete (ctx as Record<string, unknown>).req
			return next()
		})

		app
			.use(evil)
			.get("/test")
			.handler((ctx) => {
				return ctx.res.text("ok", String(ctx.req))
			})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		/* either works (req still accessible) or 500 — must not crash process */
		expect([200, 500]).toContain(res.status)
	})

	// v0: 2d82b9571f
	it("middleware replaces ctx.res with garbage → handler gets 500", async () => {
		const app = honey<{}>()
		const evil = createMiddleware(async (ctx, next) => {
			;(ctx as Record<string, unknown>).res = "not-a-HoneyRes"
			return next()
		})

		app
			.use(evil)
			.get("/test")
			.handler((ctx) => {
				return ctx.res.json("ok", {})
			})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
	})
})

describe("concurrent shared middleware state", () => {
	// v0: b04e106a45
	it("concurrent requests don't corrupt shared counter", async () => {
		let counter = 0
		const app = honey<{}>()
		const counting = createMiddleware(async (_ctx, next) => {
			counter++
			const res = await next()
			return res
		})

		app
			.use(counting)
			.get("/test")
			.handler(async (ctx) => {
				await new Promise((r) => setTimeout(r, Math.random() * 10))
				return ctx.res.json("ok", { count: counter })
			})

		const promises = Array.from({ length: 20 }, () => app.fetch(new Request("http://localhost/test"), {}))
		await Promise.all(promises)
		expect(counter).toBe(20)
	})
})

describe("using same middleware instance on multiple apps", () => {
	// v0: 3a39e3ef4d
	it("shared middleware works on both apps independently", async () => {
		const shared = createMiddleware(async (_ctx, next) => next({ shared: true }))

		const app1 = honey<{}>().use(shared)
		app1.get("/test").handler((ctx) => ctx.res.json("ok", { app: 1, shared: ctx.shared }))

		const app2 = honey<{}>().use(shared)
		app2.get("/test").handler((ctx) => ctx.res.json("ok", { app: 2, shared: ctx.shared }))

		const r1 = await app1.fetch(new Request("http://localhost/test"), {})
		const r2 = await app2.fetch(new Request("http://localhost/test"), {})

		expect(((await r1.json()) as Record<string, unknown>).app).toBe(1)
		expect(((await r2.json()) as Record<string, unknown>).app).toBe(2)
	})
})

describe("middleware ordering", () => {
	// v0: 8d9c33c410
	it("global middleware runs before route middleware", async () => {
		const order: string[] = []

		const globalMw = createMiddleware(async (_ctx, next) => {
			order.push("global")
			return next()
		})
		const routeMw = createMiddleware(async (_ctx, next) => {
			order.push("route")
			return next()
		})

		const app = honey<{}>().use(globalMw)
		app
			.get("/test")
			.use(routeMw)
			.handler((ctx) => {
				order.push("handler")
				return ctx.res.json("ok", {})
			})

		await app.fetch(new Request("http://localhost/test"), {})
		expect(order).toEqual(["global", "route", "handler"])
	})

	// v0: a27bc83725
	it("multiple global middlewares run in registration order", async () => {
		const order: string[] = []

		const mw1 = createMiddleware(async (_ctx, next) => {
			order.push("first")
			return next()
		})
		const mw2 = createMiddleware(async (_ctx, next) => {
			order.push("second")
			return next()
		})

		const app = honey<{}>().use(mw1).use(mw2)
		app.get("/test").handler((ctx) => {
			order.push("handler")
			return ctx.res.json("ok", {})
		})

		await app.fetch(new Request("http://localhost/test"), {})
		expect(order).toEqual(["first", "second", "handler"])
	})
})

describe("middleware: short-circuit without calling next", () => {
	// v0: ae4cef7f27
	it("middleware returns response directly → handler never runs", async () => {
		let handlerRan = false
		const app = honey<{}>()
		app
			.get("/guarded")
			.use(async () => new Response("blocked", { status: 401 }))
			.handler((ctx) => {
				handlerRan = true
				return ctx.res.json("ok", {})
			})

		const res = await app.fetch(new Request("http://localhost/guarded"), {})
		expect(res.status).toBe(401)
		expect(await res.text()).toBe("blocked")
		expect(handlerRan).toBe(false)
	})
})

describe("middleware modifies response after handler", () => {
	// v0: f08eb180b6
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

	// v0: a4fb5e2222
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

describe("middleware that delays response", () => {
	// v0: 13c20aab5e
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

		/* /fast is on the original handle, so it answers while /slow is still in its middleware */
		const order: string[] = []
		const slowDone = Promise.resolve(app.fetch(new Request("http://localhost/slow"), {})).then(() => order.push("slow"))
		await Promise.resolve(app.fetch(new Request("http://localhost/fast"), {})).then(() => order.push("fast"))
		await slowDone
		expect(order).toEqual(["fast", "slow"])
	})
})

describe("middleware chain stress", () => {
	// v0: e73c0454ac
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

	// v0: 1f5d595ad4
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
})

describe("middleware chain stress (2)", () => {
	// v0: 0d2f414a43
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

describe("404/405 with global middleware", () => {
	// v0: b2638db3b2
	it("middleware every route runs also runs for 404", async () => {
		let mwCalled = false
		const app = honey<{}>()
		const mw = createMiddleware(async (_ctx, next) => {
			mwCalled = true
			return next()
		})
		app
			.use(mw)
			.get("/exists")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/missing"), {})
		/* every route runs mw, so it is app-wide: an unknown path runs it too, whichever handle serves */
		expect(res.status).toBe(404)
		expect(mwCalled).toBe(true)
	})
})
