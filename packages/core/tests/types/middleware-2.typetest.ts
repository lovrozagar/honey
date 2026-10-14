import { describe, expectTypeOf, it } from "vitest"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { honey, type Honey } from "../../src/routing/app.ts"
import { defineErrors } from "../../src/errors/errors.ts"
import type {
	InferBasePath,
	InferCtx,
	InferEnv,
	InferErrorFactory,
	InferMeta,
	InferRoutes,
} from "../../src/routing/app-types.ts"
import type { HoneyContext } from "../../src/context/context.ts"

type Env = {}

const adminMw = createMiddleware(async (_c, next) => next({ adminOnly: "yes" }))

const billingMw = createMiddleware(async (_c, next) => next({ billing: 42 }))

const globalMw = createMiddleware(async (_c, next) => next({ globalField: "global" }))

const dbMw = createMiddleware(async (_c, next) => next({ db: { query: () => [] } }))

type DbCtx2 = { db: { query: () => unknown[] } }

describe("scoped middleware — type tests", () => {
	// v0: 220e22f5db
	it("T1. scoped add appears on matching route ctx", () => {
		honey<Env>()
			.use("/admin", adminMw)
			.get("/admin/x")
			.handler((c) => {
				expectTypeOf(c.adminOnly).toEqualTypeOf<string>()
				return c.res.text("ok", "x")
			})
	})

	// v0: 59825a6a62
	it("T2. scoped add appears on exact-prefix route ctx", () => {
		honey<Env>()
			.use("/admin", adminMw)
			.get("/admin")
			.handler((c) => {
				expectTypeOf(c.adminOnly).toEqualTypeOf<string>()
				return c.res.text("ok", "admin")
			})
	})

	// v0: 1e022ce9b3
	it("T3. scoped add does NOT appear on non-matching route ctx", () => {
		honey<Env>()
			.use("/admin", adminMw)
			.get("/public")
			.handler((c) => {
				expectTypeOf(c).not.toHaveProperty("adminOnly")
				return c.res.text("ok", "p")
			})
	})

	// v0: 6f6e5f1fa0
	it("T4. boundary — /admin scope does not leak to /administration", () => {
		honey<Env>()
			.use("/admin", adminMw)
			.get("/administration")
			.handler((c) => {
				expectTypeOf(c).not.toHaveProperty("adminOnly")
				return c.res.text("ok", "a")
			})
	})
})

describe("scoped middleware — type tests (2)", () => {
	// v0: 9f44961611
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

	// v0: c3a74f4b4c
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

	// v0: fa8a155692
	it("T7. unscoped .use(mw) still intersects globally", () => {
		honey<Env>()
			.use(globalMw)
			.get("/anything")
			.handler((c) => {
				expectTypeOf(c.globalField).not.toBeUndefined()
				return c.res.text("ok", "x")
			})
	})
})

describe("scoped middleware — type tests (3)", () => {
	// v0: 6ef67d8f0c
	it("T8. unscoped + scoped compose correctly", () => {
		honey<Env>()
			.use(globalMw)
			.use("/admin", adminMw)
			.get("/admin/x")
			.handler((c) => {
				expectTypeOf(c.globalField).not.toBeUndefined()
				expectTypeOf(c.adminOnly).toEqualTypeOf<string>()
				return c.res.text("ok", "x")
			})

		honey<Env>()
			.use(globalMw)
			.use("/admin", adminMw)
			.get("/public")
			.handler((c) => {
				expectTypeOf(c.globalField).not.toBeUndefined()
				// @ts-expect-error — adminOnly not on /public
				const a = c.adminOnly
				void a
				return c.res.text("ok", "p")
			})
	})

	// v0: 2378fb5d62
	it("T9. scope / equivalent to unscoped at type level", () => {
		honey<Env>()
			.use("/", adminMw)
			.get("/any")
			.handler((c) => {
				expectTypeOf(c.adminOnly).not.toBeUndefined()
				return c.res.text("ok", "any")
			})
	})
})

describe("scoped middleware — type tests (4)", () => {
	// v0: f31e874f4a
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

	// v0: 79fd0c5de3
	it("T11. .use overload resolution — single-arg and path+mw both type-check", () => {
		/* unscoped branch */
		honey<Env>()
			.use(globalMw)
			.get("/x")
			.handler((c) => {
				expectTypeOf(c.globalField).not.toBeUndefined()
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
})

describe("scoped middleware — type tests (5)", () => {
	// v0: bb446fe17c
	it("T12. scoped mw with TReqs enforces chain ordering at path-aware .use site", () => {
		const authNeedsDb = createMiddleware(async (ctx: DbCtx2, next) => {
			void ctx.db
			return next({ userId: "u-1" })
		})

		/* without prior .use(dbMw), it is a compile error at the call */
		// @ts-expect-error the chain does not provide `db`
		honey<Env>().use("/admin", authNeedsDb)

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

	// v0: 5585fcebc8
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

	// v0: 3625f5b63b
	it("T14. InferCtx of the chain itself is not polluted by scoped adds", () => {
		const app = honey<Env>().use("/admin", adminMw)
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().not.toMatchTypeOf<{ adminOnly: string }>()
	})
})

describe("scoped middleware — type tests (6)", () => {
	// v0: 53d944bd37
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

describe("scoped middleware — type regression tests", () => {
	// v0: d2adb9ab18
	it("T16. Honey<> with 8 positional generics (pre-feature shape) still resolves", () => {
		type Old = Honey<Env, HoneyContext<Env>, {}, never, never, never, "/", {}>
		type New = Honey<Env, HoneyContext<Env>, {}, never, never, never, "/", {}, []>

		expectTypeOf<New>().toEqualTypeOf<Old>()
	})

	// v0: 84c9f852a1
	it("T17. honey() factory return type unchanged for plain chains", () => {
		const app = honey<Env>()
		expectTypeOf(app).toMatchTypeOf<Honey<Env>>()
	})
})

describe("scoped middleware — type regression tests (2)", () => {
	// v0: 528d66bfcb
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

	// v0: d073246b66
	it("T20. Chain-level TCtx is UNPOLLUTED after scoped .use(path, mw)", () => {
		const app = honey<Env>().use("/admin", adminMw)
		type ChainCtx = (typeof app)["$ctx"]
		expectTypeOf<ChainCtx>().not.toMatchTypeOf<{ adminOnly: string }>()
	})
})
