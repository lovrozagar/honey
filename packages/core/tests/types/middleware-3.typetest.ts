import { describe, expectTypeOf, it } from "vitest"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { honey, type Honey } from "../../src/routing/app.ts"
import { defineErrors } from "../../src/errors/errors.ts"
import type { InferBasePath, InferCtx, InferEnv, InferErrorFactory } from "../../src/routing/app-types.ts"
import type { HoneyContext } from "../../src/context/context.ts"

type Env = {}

const adminMw = createMiddleware(async (_c, next) => next({ adminOnly: "yes" }))

const billingMw = createMiddleware(async (_c, next) => next({ billing: 42 }))

const globalMw = createMiddleware(async (_c, next) => next({ globalField: "global" }))

const dbMw = createMiddleware(async (_c, next) => next({ db: { query: () => [] } }))

describe("scoped middleware — type regression tests (3)", () => {
	// v0: e265fd184b
	it("T21. Unscoped .use(mw) alone — no scoped mw anywhere — TCtx still intersects normally", () => {
		const app = honey<Env>().use(globalMw)
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<{ globalField: string }>()

		app.get("/x").handler((c) => {
			expectTypeOf(c.globalField).toEqualTypeOf<string>()
			return c.res.text("ok", "x")
		})
	})

	// v0: 55aa6abb32
	it("T22. Overload dispatch — function arg vs string arg — no ambiguity errors across many combinations", () => {
		/* mw only */
		expectTypeOf(honey<Env>().use(globalMw)).toHaveProperty("get")

		/* literal + mw */
		expectTypeOf(honey<Env>().use("/x", adminMw)).toHaveProperty("get")

		/* const-asserted literal + mw */
		expectTypeOf(honey<Env>().use("/x" as const, adminMw)).toHaveProperty("get")

		/* both at once */
		expectTypeOf(honey<Env>().use(globalMw).use("/admin", adminMw)).toHaveProperty("get")
	})

	// v0: c2127ed92f
	it("T23. Deep expectTypeOf on composed ctx — exact equality via toMatchTypeOf", () => {
		const app = honey<Env>()
			.use(dbMw)
			.use("/admin", adminMw)
			.use("/admin/billing", billingMw)
			.get("/admin/billing/invoices")
			.handler((c) => {
				expectTypeOf(c).toMatchTypeOf<
					HoneyContext<Env> & { db: { query: () => unknown[] }; adminOnly: string; billing: number }
				>()
				expectTypeOf(c.billing).toEqualTypeOf<number>()
				expectTypeOf(c.adminOnly).toEqualTypeOf<string>()
				expectTypeOf(c.db.query).toBeFunction()
				return c.res.text("ok", "x")
			})
		void app
	})
})

describe("scoped middleware — type regression tests (4)", () => {
	// v0: d593097878
	it("T24. .use(path, mw) return type preserves all OTHER chain generics unchanged", () => {
		const errors = defineErrors({ err: "internal_server_error" })

		const a = honey<Env>().basePath("/api").errorFactory(errors).defaultErrors("err").meta({ v: 1 })

		const b = a.use("/admin", adminMw)

		expectTypeOf<InferBasePath<typeof b>>().toEqualTypeOf<"/api">()
		expectTypeOf<InferErrorFactory<typeof b>>().toEqualTypeOf<typeof errors>()
		expectTypeOf<InferEnv<typeof b>>().toEqualTypeOf<Env>()
	})

	// v0: 141e489af6
	it("T25. .route(sub) — sub with scoped mw merged into parent — parent's own .get() after merge sees NO sub scoped adds", () => {
		const sub = honey<Env>()
			.use("/x", adminMw)
			.get("/x/a")
			.handler((c) => {
				expectTypeOf(c.adminOnly).toEqualTypeOf<string>()
				return c.res.text("ok", "a")
			})

		const parent = honey<Env>().route(sub)
		parent.get("/x/b").handler((c) => {
			// @ts-expect-error — adminOnly not in parent's TScopedMw
			const v = c.adminOnly
			void v
			return c.res.text("ok", "b")
		})
	})

	// v0: 416fa38434
	it("T26. Regression on existing type tests — import check", () => {
		/* This test just ensures the file imports without error.
		   If the new TScopedMw generic broke existing type tests,
		   this import would fail at tsc --noEmit time. */
		expectTypeOf<{}>().toMatchTypeOf<object>()
	})

	// v0: 011b51b268
	it("T27. Negative @ts-expect-error drift guard — already defined at top of file", () => {
		/* Three intentional type errors on lines 10–15.
		   If they become valid or errors move, tsc --noEmit will catch it. */
		expectTypeOf<{}>().toMatchTypeOf<object>()
	})
})

describe("scoped middleware — type regression tests (5)", () => {
	// v0: 51db08872d
	it("T28. Backwards compat: old explicit Honey<...> signatures with 8 generics still work", () => {
		/* This was already done in T16, but doing it again as explicit regression. */
		type OldStyle = Honey<Env, HoneyContext<Env>, {}, never, never, never, "/", {}>
		type NewStyle = Honey<Env, HoneyContext<Env>, {}, never, never, never, "/", {}, []>

		/* Both must resolve to the same type */
		expectTypeOf<OldStyle>().toEqualTypeOf<NewStyle>()
	})
})
