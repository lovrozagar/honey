import { describe, expectTypeOf, it } from "vitest"
import { honey } from "../../src/routing/app.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"

describe("route builder lifecycle — handler ctx types still correct", () => {
	// v0: 22d95f2a17
	it("meta types flow through after one-shot", () => {
		honey<{}>()
			.get("/test")
			.meta({ summary: "hello", tags: "Test" })
			.handler((ctx) => {
				expectTypeOf(ctx.meta).toMatchTypeOf<Readonly<{}>>()
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: 8464a3cf8a
	it("middleware types accumulate after .use()", () => {
		const mw1 = createMiddleware(async (_ctx, next) => next({ a: 1 }))
		const mw2 = createMiddleware(async (_ctx, next) => next({ b: "two" }))

		honey<{}>()
			.get("/test")
			.use(mw1)
			.use(mw2)
			.handler((ctx) => {
				expectTypeOf(ctx.a).toEqualTypeOf<number>()
				expectTypeOf(ctx.b).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("tap types: $taps phantom type", () => {
	// v0: 9bf8379dff
	it("$taps is empty object when no .taps() called", () => {
		const app = honey<{}>()
		type Taps = (typeof app)["$taps"]
		expectTypeOf<Taps>().toEqualTypeOf<{}>()
	})
})
