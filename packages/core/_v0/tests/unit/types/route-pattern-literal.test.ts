import { describe, expectTypeOf, it } from "vitest"
import { createMiddleware, honey } from "../../../src/index.ts"

describe("ctx.routePattern literal type", () => {
	it("simple route — routePattern is literal", () => {
		const app = honey<{}>()
		app.get("/users").handler((ctx) => {
			expectTypeOf(ctx.routePattern).toEqualTypeOf<"/users">()
			return ctx.res.text("ok", "ok")
		})
	})

	it("basePath route — routePattern is merged literal", () => {
		const app = honey<{}>().basePath("/api")
		app.get("/users").handler((ctx) => {
			expectTypeOf(ctx.routePattern).toEqualTypeOf<"/api/users">()
			return ctx.res.text("ok", "ok")
		})
	})

	it("param route — routePattern is literal with :param", () => {
		const app = honey<{}>()
		app.get("/users/:id").handler((ctx) => {
			expectTypeOf(ctx.routePattern).toEqualTypeOf<"/users/:id">()
			return ctx.res.text("ok", "ok")
		})
	})

	it("root route — routePattern is /", () => {
		const app = honey<{}>()
		app.get("/").handler((ctx) => {
			expectTypeOf(ctx.routePattern).toEqualTypeOf<"/">()
			return ctx.res.text("ok", "ok")
		})
	})

	it("with middleware chain + input + output — routePattern is still literal", () => {
		const mw = createMiddleware(async (_ctx, next) => next({ userId: "u1" }))
		const app = honey<{}>().use(mw)
		app
			.get("/")
			.input({})
			.output({})
			.handler((ctx) => {
				expectTypeOf(ctx.routePattern).toEqualTypeOf<"/">()
				return ctx.res.json("ok", {})
			})
	})

	it("middleware chain + basePath — routePattern is merged literal", () => {
		const mw = createMiddleware(async (_ctx, next) => next({ userId: "u1" }))
		const app = honey<{}>().use(mw).basePath("/api")
		app
			.get("/items/:id")
			.input({})
			.output({})
			.handler((ctx) => {
				expectTypeOf(ctx.routePattern).toEqualTypeOf<"/api/items/:id">()
				return ctx.res.json("ok", {})
			})
	})
})
