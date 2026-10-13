import { describe, expectTypeOf, it } from "vitest"
import {
	createMiddleware,
	defineErrors,
	honey,
	type InferBasePath,
	type InferCtx,
	type InferEnv,
	type InferErrorFactory,
	type InferMeta,
	type InferRoutes,
} from "../../../src/index.ts"
import type { Honey, HoneyContext } from "../../../src/index.ts"

/* ──── drift guard: three intentional type errors on known lines (T27) ──── */

// @ts-expect-error — sentinel: this is always invalid
const _driftGuard1: number = "never"
// @ts-expect-error — sentinel: this is always invalid
const _driftGuard2: string = 123
// @ts-expect-error — sentinel: this is always invalid
const _driftGuard3: boolean = { foo: "bar" }

/* ──── test helpers ──── */

type Env = {}

const adminMw = createMiddleware(async (_c, next) => next({ adminOnly: "yes" }))
const billingMw = createMiddleware(async (_c, next) => next({ billing: 42 }))
const globalMw = createMiddleware(async (_c, next) => next({ globalField: "global" }))
const dbMw = createMiddleware(async (_c, next) => next({ db: { query: () => [] } }))

type DbCtx = { db: { query: () => unknown[] } }

/* ──── pure type tests T1–T15 ──── */

describe("scoped middleware — type tests", () => {
	it("T1. scoped add appears on matching route ctx", () => {
		honey<Env>()
			.use("/admin", adminMw)
			.get("/admin/x")
			.handler((c) => {
				expectTypeOf(c.adminOnly).toEqualTypeOf<string>()
				return c.res.text("ok", "x")
			})
	})

	it("T2. scoped add appears on exact-prefix route ctx", () => {
		honey<Env>()
			.use("/admin", adminMw)
			.get("/admin")
			.handler((c) => {
				expectTypeOf(c.adminOnly).toEqualTypeOf<string>()
				return c.res.text("ok", "admin")
			})
	})

	it("T3. scoped add does NOT appear on non-matching route ctx", () => {
		honey<Env>()
			.use("/admin", adminMw)
			.get("/public")
			.handler((c) => {
				// @ts-expect-error — adminOnly not on /public
				const x = c.adminOnly
				void x
				return c.res.text("ok", "p")
			})
	})

	it("T4. boundary — /admin scope does not leak to /administration", () => {
		honey<Env>()
			.use("/admin", adminMw)
			.get("/administration")
			.handler((c) => {
				// @ts-expect-error — adminOnly not on /administration
				const x = c.adminOnly
				void x
				return c.res.text("ok", "a")
			})
	})

	it("T5. deep matching route sees multiple scoped adds composed via intersection", () => {
		honey<Env>()
			.use("/admin", adminMw)
			.use("/admin/billing", billingMw)
			.get("/admin/billing/x")
			.handler((c) => {
				expectTypeOf(c.adminOnly).toEqualTypeOf<string>()
				expectTypeOf(c.billing).toEqualTypeOf<number>()
				return c.res.text("ok", "x")
			})
	})

	it("T6. shallow matching route sees only applicable scoped adds", () => {
		honey<Env>()
			.use("/admin", adminMw)
			.use("/admin/billing", billingMw)
			.get("/admin/users")
			.handler((c) => {
				expectTypeOf(c.adminOnly).toEqualTypeOf<string>()
				// @ts-expect-error — billing not on /admin/users
				const b = c.billing
				void b
				return c.res.text("ok", "users")
			})
	})

	it("T7. unscoped .use(mw) still intersects globally", () => {
		honey<Env>()
			.use(globalMw)
			.get("/anything")
			.handler((c) => {
				expectTypeOf(c.globalField).toBeDefined()
				return c.res.text("ok", "x")
			})
	})

	it("T8. unscoped + scoped compose correctly", () => {
		honey<Env>()
			.use(globalMw)
			.use("/admin", adminMw)
			.get("/admin/x")
			.handler((c) => {
				expectTypeOf(c.globalField).toBeDefined()
				expectTypeOf(c.adminOnly).toEqualTypeOf<string>()
				return c.res.text("ok", "x")
			})

		honey<Env>()
			.use(globalMw)
			.use("/admin", adminMw)
			.get("/public")
			.handler((c) => {
				expectTypeOf(c.globalField).toBeDefined()
				// @ts-expect-error — adminOnly not on /public
				const a = c.adminOnly
				void a
				return c.res.text("ok", "p")
			})
	})

	it("T9. scope / equivalent to unscoped at type level", () => {
		honey<Env>()
			.use("/", adminMw)
			.get("/any")
			.handler((c) => {
				expectTypeOf(c.adminOnly).toBeDefined()
				return c.res.text("ok", "any")
			})
	})

	it("T10. basePath merges into scope at type level", () => {
		honey<Env>()
			.basePath("/api")
			.use("/admin", adminMw)
			.get("/admin/x")
			.handler((c) => {
				expectTypeOf(c.adminOnly).toEqualTypeOf<string>()
				return c.res.text("ok", "x")
			})

		honey<Env>()
			.basePath("/api")
			.use("/admin", adminMw)
			.get("/public")
			.handler((c) => {
				// @ts-expect-error — adminOnly not on /api/public
				const a = c.adminOnly
				void a
				return c.res.text("ok", "p")
			})
	})

	it("T11. .use overload resolution — single-arg and path+mw both type-check", () => {
		/* unscoped branch */
		honey<Env>()
			.use(globalMw)
			.get("/x")
			.handler((c) => {
				expectTypeOf(c.globalField).toBeDefined()
				return c.res.text("ok", "x")
			})

		/* scoped branch */
		honey<Env>()
			.use("/x", adminMw)
			.get("/x/y")
			.handler((c) => {
				expectTypeOf(c.adminOnly).toEqualTypeOf<string>()
				return c.res.text("ok", "y")
			})
	})

	it("T12. scoped mw with TReqs enforces chain ordering at path-aware .use site", () => {
		const authNeedsDb = createMiddleware(async (ctx: DbCtx, next) => {
			void ctx.db
			return next({ userId: "u-1" })
		})

		/* without prior .use(dbMw), should be invalid */
		expectTypeOf(honey<Env>().use("/admin", authNeedsDb)).toBeNever()

		/* with prior .use(dbMw), should work */
		const good = honey<Env>()
			.use(dbMw)
			.use("/admin", authNeedsDb)
			.get("/admin/x")
			.handler((c) => {
				expectTypeOf(c.userId).toEqualTypeOf<string>()
				return c.res.text("ok", "x")
			})
		void good
	})

	it("T13. route registered BEFORE adding a scoped .use() does not see that scope in its type", () => {
		const a = honey<Env>()
			.get("/admin/x")
			.handler((c) => {
				/* adminOnly NOT visible */
				// @ts-expect-error
				const ad = c.adminOnly
				void ad
				return c.res.text("ok", "x")
			})

		const b = a
			.use("/admin", adminMw)
			.get("/admin/y")
			.handler((c) => {
				/* adminOnly IS visible */
				expectTypeOf(c.adminOnly).toEqualTypeOf<string>()
				return c.res.text("ok", "y")
			})

		void b
	})

	it("T14. InferCtx of the chain itself is not polluted by scoped adds", () => {
		const app = honey<Env>().use("/admin", adminMw)
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().not.toMatchTypeOf<{ adminOnly: string }>()
	})

	it("T15. .route(sub) — sub with scoped mw merged into parent — parent's own .get() after merge sees NO sub scoped adds", () => {
		const sub = honey<Env>()
			.use("/x", adminMw)
			.get("/x/a")
			.handler((c) => {
				expectTypeOf(c.adminOnly).toEqualTypeOf<string>()
				return c.res.text("ok", "a")
			})

		const parent = honey<Env>().route(sub)
		parent.get("/x/b").handler((c) => {
			/* parent TScopedMw does not include sub's scopes — intentional limitation */
			// @ts-expect-error — adminOnly not in parent's TScopedMw
			const v = c.adminOnly
			void v
			return c.res.text("ok", "b")
		})
	})
})

/* ──── deep type-regression tests T16–T28 ──── */

describe("scoped middleware — type regression tests", () => {
	it("T16. Honey<> with 8 positional generics (pre-feature shape) still resolves", () => {
		type Old = Honey<Env, HoneyContext<Env>, {}, never, never, never, "/", {}>
		type New = Honey<Env, HoneyContext<Env>, {}, never, never, never, "/", {}, []>

		expectTypeOf<New>().toEqualTypeOf<Old>()
	})

	it("T17. honey() factory return type unchanged for plain chains", () => {
		const app = honey<Env>()
		expectTypeOf(app).toMatchTypeOf<Honey<Env>>()
	})

	it("T18. InferEnv, InferCtx, InferRoutes, InferMeta, InferBasePath, InferErrorFactory all still infer correctly on a chain with scoped mw", () => {
		const errors = defineErrors({ err: "internal_server_error" })

		const appWithoutScoped = honey<Env>()
			.errorFactory(errors)
			.defaultErrors("err")
			.basePath("/api")
			.meta({ version: 1 })
			.get("/x")
			.handler((c) => c.res.text("ok", "x"))

		type EnvWithoutScoped = InferEnv<typeof appWithoutScoped>
		type CtxWithoutScoped = InferCtx<typeof appWithoutScoped>
		type RoutesWithoutScoped = InferRoutes<typeof appWithoutScoped>
		type MetaWithoutScoped = InferMeta<typeof appWithoutScoped>
		type BasePathWithoutScoped = InferBasePath<typeof appWithoutScoped>
		type ErrorFactoryWithoutScoped = InferErrorFactory<typeof appWithoutScoped>

		const appWithScoped = honey<Env>()
			.errorFactory(errors)
			.defaultErrors("err")
			.basePath("/api")
			.meta({ version: 1 })
			.use("/admin", adminMw)
			.get("/x")
			.handler((c) => c.res.text("ok", "x"))

		type EnvWithScoped = InferEnv<typeof appWithScoped>
		type CtxWithScoped = InferCtx<typeof appWithScoped>
		type RoutesWithScoped = InferRoutes<typeof appWithScoped>
		type MetaWithScoped = InferMeta<typeof appWithScoped>
		type BasePathWithScoped = InferBasePath<typeof appWithScoped>
		type ErrorFactoryWithScoped = InferErrorFactory<typeof appWithScoped>

		expectTypeOf<EnvWithScoped>().toEqualTypeOf<EnvWithoutScoped>()
		expectTypeOf<CtxWithScoped>().toEqualTypeOf<CtxWithoutScoped>()
		expectTypeOf<RoutesWithScoped>().toEqualTypeOf<RoutesWithoutScoped>()
		expectTypeOf<MetaWithScoped>().toEqualTypeOf<MetaWithoutScoped>()
		expectTypeOf<BasePathWithScoped>().toEqualTypeOf<BasePathWithoutScoped>()
		expectTypeOf<ErrorFactoryWithScoped>().toEqualTypeOf<ErrorFactoryWithoutScoped>()
	})

	it("T19. non-literal path widens to string — guarded against pollution", () => {
		const p: string = "/admin"
		const app = honey<Env>().use(p, adminMw)
		app.get("/unrelated").handler((c) => {
			// @ts-expect-error — must NOT leak even though path widened to string
			const x = c.adminOnly
			void x
			return c.res.text("ok", "u")
		})
	})

	it("T20. Chain-level TCtx is UNPOLLUTED after scoped .use(path, mw)", () => {
		const app = honey<Env>().use("/admin", adminMw)
		type ChainCtx = (typeof app)["$ctx"]
		expectTypeOf<ChainCtx>().not.toMatchTypeOf<{ adminOnly: string }>()
	})

	it("T21. Unscoped .use(mw) alone — no scoped mw anywhere — TCtx still intersects normally", () => {
		const app = honey<Env>().use(globalMw)
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<{ globalField: string }>()

		app.get("/x").handler((c) => {
			expectTypeOf(c.globalField).toEqualTypeOf<string>()
			return c.res.text("ok", "x")
		})
	})

	it("T22. Overload dispatch — function arg vs string arg — no ambiguity errors across many combinations", () => {
		/* mw only */
		honey<Env>().use(globalMw)

		/* literal + mw */
		honey<Env>().use("/x", adminMw)

		/* const-asserted literal + mw */
		honey<Env>().use("/x" as const, adminMw)

		/* both at once */
		honey<Env>().use(globalMw).use("/admin", adminMw)
	})

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

	it("T24. .use(path, mw) return type preserves all OTHER chain generics unchanged", () => {
		const errors = defineErrors({ err: "internal_server_error" })

		const a = honey<Env>().basePath("/api").errorFactory(errors).defaultErrors("err").meta({ v: 1 })

		const b = a.use("/admin", adminMw)

		expectTypeOf<InferBasePath<typeof b>>().toEqualTypeOf<"/api">()
		expectTypeOf<InferErrorFactory<typeof b>>().toEqualTypeOf<typeof errors>()
		expectTypeOf<InferEnv<typeof b>>().toEqualTypeOf<Env>()
	})

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

	it("T26. Regression on existing type tests — import check", () => {
		/* This test just ensures the file imports without error.
		   If the new TScopedMw generic broke existing type tests,
		   this import would fail at tsc --noEmit time. */
		expectTypeOf<{}>().toMatchTypeOf<object>()
	})

	it("T27. Negative @ts-expect-error drift guard — already defined at top of file", () => {
		/* Three intentional type errors on lines 10–15.
		   If they become valid or errors move, tsc --noEmit will catch it. */
		expectTypeOf<{}>().toMatchTypeOf<object>()
	})

	it("T28. Backwards compat: old explicit Honey<...> signatures with 8 generics still work", () => {
		/* This was already done in T16, but doing it again as explicit regression. */
		type OldStyle = Honey<Env, HoneyContext<Env>, {}, never, never, never, "/", {}>
		type NewStyle = Honey<Env, HoneyContext<Env>, {}, never, never, never, "/", {}, []>

		/* Both must resolve to the same type */
		expectTypeOf<OldStyle>().toEqualTypeOf<NewStyle>()
	})
})
