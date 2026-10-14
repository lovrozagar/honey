import { describe, expect, expectTypeOf, it } from "vitest"
import { honey } from "../../src/routing/app.ts"
import { createMiddleware, defineMiddleware } from "../../src/middleware/middleware.ts"

type AppMeta4 = { auth: string; worker: string }

describe("middleware-contributed meta", () => {
	// v0: 989f510b71
	it('rejects "internal" — a middleware must not remove routes from generated artifacts', () => {
		expect(() => createMiddleware(async (_c, n) => n({}), { meta: { internal: true } })).toThrow(
			/cannot set "internal"/,
		)
		expect(() => defineMiddleware({ fn: async (_c, n) => n({}), meta: { internal: false } })).toThrow(
			/cannot set "internal"/,
		)
	})
})

describe("ctx.meta type from .meta<T>()", () => {
	// v0: 1460dc840b
	it("catch-all handler inherits app-level meta type", () => {
		honey<{}>()
			.meta<AppMeta4>()
			.all("*")
			.handler((ctx) => {
				expectTypeOf(ctx.meta.auth).toEqualTypeOf<AppMeta4["auth"]>()
				expectTypeOf(ctx.meta.worker).toEqualTypeOf<AppMeta4["worker"]>()
				return ctx.res.text("ok", "x")
			})
	})
})
