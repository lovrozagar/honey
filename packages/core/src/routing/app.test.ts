import { describe, expect, expectTypeOf, it } from "vitest"
import { createMiddleware } from "../middleware/middleware.ts"
import { GRAPH, Honey, honey } from "./app.ts"

const req = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init)
const makeRequest = (method: string, path: string) => req(path, { method })

describe("honey() — full request flow", () => {
	// v0: bba7582b67
	it("GET /health → 200", async () => {
		const h = honey<{}>()
		h.get("/health").handler((ctx) => ctx.res.json("ok", { status: "healthy" }))
		const res = await h.fetch(req("/health"), {})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ status: "healthy" })
	})

	// v0: e4fa75babc
	it("404 for unknown path", async () => {
		const h = honey<{}>()
		h.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		expect((await h.fetch(req("/missing"), {})).status).toBe(404)
	})

	// v0: 53061962a5
	it(".all() route matches multiple methods", async () => {
		const h = honey<{}>()
		h.all("/catch").handler((ctx) => ctx.res.text("ok", "caught"))
		for (const method of ["GET", "POST", "PUT", "DELETE"])
			expect((await h.fetch(makeRequest(method, "/catch"), {})).status).toBe(200)
	})
})

describe("middleware chain", () => {
	// v0: 810e8e8e6b
	it("3 middlewares execute in correct order", async () => {
		const order: number[] = []
		const around = (before: number, after: number) =>
			createMiddleware(async (_ctx, next) => {
				order.push(before)
				const res = await next()
				order.push(after)
				return res
			})
		const h = honey<{}>()
		h.use(around(1, 6))
			.use(around(2, 5))
			.use(around(3, 4))
			.get("/test")
			.handler((ctx) => {
				order.push(0)
				return ctx.res.text("ok", "ok")
			})
		await h.fetch(req("/test"), {})
		expect(order).toEqual([1, 2, 3, 0, 4, 5, 6])
	})

	// v0: 205bbd2d9d
	it("middleware short-circuit", async () => {
		const h = honey<{}>()
		let handlerCalled = false
		h.use(createMiddleware(async () => new Response("cached", { status: 200 })))
			.get("/test")
			.handler((ctx) => {
				handlerCalled = true
				return ctx.res.text("ok", "fresh")
			})
		expect(await (await h.fetch(req("/test"), {})).text()).toBe("cached")
		expect(handlerCalled).toBe(false)
	})

	// v0: fcc562aa1a
	it("middleware next with additions", async () => {
		const h = honey<{}>()
		h.use(createMiddleware(async (_ctx, next) => next({ db: "connected" })))
			.get("/test")
			.handler((ctx) => ctx.res.text("ok", ctx.db))
		expect(await (await h.fetch(req("/test"), {})).text()).toBe("connected")
	})
})

const flagged = () => {
	const state = { called: false }
	const mw = createMiddleware(async (_ctx, next) => {
		state.called = true
		return next({ db: "pg" })
	})
	return { mw, state }
}

describe("global vs chain .use()", () => {
	// v0: e52312b8b1
	it("chain .use() with context additions returns new instance", () => {
		const h = honey<{}>()
		const chain = h.use(flagged().mw)
		expect(chain).not.toBe(h)
		chain.get("/x").handler((ctx) => ctx.res.text("ok", ctx.db))
	})

	// v0: 1dbac94283
	it("chain .use() middleware runs on routes registered on the chain", async () => {
		const h = honey<{}>()
		const { mw, state } = flagged()
		h.use(mw)
			.get("/test")
			.handler((ctx) => ctx.res.text("ok", ctx.db))
		await h.fetch(req("/test"), {})
		expect(state.called).toBe(true)
	})

	// v0: 597d267652
	it("no-context middleware still works via chain", async () => {
		const h = honey<{}>()
		let mwCalled = false
		h.use(
			createMiddleware(async (_ctx, next) => {
				mwCalled = true
				return next()
			}),
		)
			.get("/test")
			.handler((ctx) => ctx.res.text("ok", "ok"))
		await h.fetch(req("/test"), {})
		expect(mwCalled).toBe(true)
	})
})

describe(".on() multi-method routing", () => {
	// v0: 903360137b
	it("matches GET and POST on same path", async () => {
		const app = new Honey()
			.on(["GET", "POST"], "/users")
			.handler((ctx) => ctx.res.json("ok", { method: ctx.req.method }))
		expect(await (await app.fetch(makeRequest("GET", "/users"), {} as never)).json()).toEqual({ method: "GET" })
		expect(await (await app.fetch(makeRequest("POST", "/users"), {} as never)).json()).toEqual({ method: "POST" })
	})

	// v0: f57a7960d4
	it("returns 405 for methods not in the list", async () => {
		const app = new Honey().on(["GET", "POST"], "/users").handler((ctx) => ctx.res.json("ok", { ok: true }))
		expect((await app.fetch(makeRequest("DELETE", "/users"), {} as never)).status).toBe(405)
	})

	// v0: c36bee0bde
	it("works with middleware chain", async () => {
		const app = new Honey()
			.use(async (_ctx, next) => next({ injected: "yes" }))
			.on(["PUT", "PATCH"], "/items/:id")
			.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id, injected: ctx.injected }))
		expect(await (await app.fetch(makeRequest("PUT", "/items/42"), {} as never)).json()).toEqual({
			id: "42",
			injected: "yes",
		})
	})

	// v0: ae47f23316
	it("works with meta", async () => {
		const app = new Honey()
			.meta<{ tag: string }>()
			.on(["GET", "POST"], "/data")
			.meta({ tag: "data-route" })
			.handler((ctx) => ctx.res.json("ok", { tag: ctx.meta.tag }))
		expect(await (await app.fetch(makeRequest("GET", "/data"), {} as never)).json()).toEqual({ tag: "data-route" })
	})

	// v0: 77c1590a86
	it("single method array acts like individual method", async () => {
		const app = new Honey()
			.on(["DELETE"], "/items/:id")
			.handler((ctx) => ctx.res.json("ok", { deleted: ctx.params.id }))
		expect(await (await app.fetch(makeRequest("DELETE", "/items/99"), {} as never)).json()).toEqual({ deleted: "99" })
	})
})

describe("the app handle", () => {
	it("basePath, context and meta return a new handle on the same graph", () => {
		const app = honey<{}>()
		const handles = [app.basePath("/v1"), app.context({ a: 1 }), app.meta({ summary: "s" })]
		for (const handle of handles) {
			expect(handle).not.toBe(app)
			expect(handle[GRAPH]).toBe(app[GRAPH])
		}
		expect(app.meta()).toBe(app)
	})

	it("context() refuses a key the framework owns, and merges over earlier values", async () => {
		expect(() => honey<{}>().context({ req: 1 })).toThrow('context() cannot set reserved key "req"')
		const app = honey<{}>().context({ a: 1, b: 1 }).context({ b: 2 })
		app.get("/c").handler((ctx) => ctx.res.json("ok", { a: ctx.a, b: ctx.b }))
		expect(await (await app.fetch(req("/c"), {})).json()).toEqual({ a: 1, b: 2 })
	})

	// v0: 500fe0c015
	it("the settings setters return the handle they were called on, typed the same", () => {
		const app = honey<{ k: string }>()
		const same = app
			.trailingSlash("strip")
			.encodedSlashes("allow")
			.onError(() => undefined)
		expect(same).toBe(app)
		expectTypeOf(same).toEqualTypeOf(app)
	})

	it("serving from a new handle re-finalizes once, so 404 runs that handle's chain when there are no routes", async () => {
		const seen: string[] = []
		const app = honey<{}>().use(
			createMiddleware((_ctx, next) => {
				seen.push("logged")
				return next()
			}),
		)
		expect((await app.fetch(req("/anything"), {})).status).toBe(404)
		expect((await app.fetch(req("/anything"), {})).status).toBe(404)
		expect(seen).toEqual(["logged", "logged"])
	})

	it("registers each method verb under its own method", async () => {
		const app = honey<{}>()
		app.delete("/v").handler((ctx) => ctx.res.text("ok", "delete"))
		app.head("/v").handler((ctx) => ctx.res.noContent())
		app.options("/v").handler((ctx) => ctx.res.text("ok", "options"))
		app.put("/v").handler((ctx) => ctx.res.text("ok", "put"))
		for (const method of ["DELETE", "OPTIONS", "PUT"])
			expect(await (await app.fetch(makeRequest(method, "/v"), {})).text()).toBe(method.toLowerCase())
		expect((await app.fetch(makeRequest("HEAD", "/v"), {})).status).toBe(204)
	})

	it("honey() with no env type takes an unknown env", () => {
		expectTypeOf(honey()).toEqualTypeOf<Honey<unknown>>()
	})
})
