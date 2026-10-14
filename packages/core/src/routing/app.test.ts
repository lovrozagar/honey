import { describe, expect, expectTypeOf, it } from "vitest"
import { createMiddleware } from "../middleware/middleware.ts"
import { GRAPH, Honey, honey } from "./app.ts"

const req = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init)
const makeRequest = (method: string, path: string) => req(path, { method })

describe("the app handle", () => {
	// v0: e52312b8b1
	it("use, basePath, context and meta return a new handle on the same graph", () => {
		const app = honey<{}>()
		const pass = createMiddleware((_ctx, next) => next({ db: "pg" }))
		const handles = [app.use(pass), app.basePath("/v1"), app.context({ a: 1 }), app.meta({ summary: "s" })]
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
