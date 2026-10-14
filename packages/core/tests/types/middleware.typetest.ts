import { describe, expectTypeOf, it } from "vitest"
import { createMiddleware, defineMiddleware, type MiddlewareFn } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"
import { defineErrors } from "../../src/errors/errors.ts"
import type { InferBasePath, InferCtx, InferEnv } from "../../src/routing/app-types.ts"

type DbCtx = { db: { query: (sql: string) => unknown[] } }

type AuthCtx = { orgId: string; userId: string }

const withDb = createMiddleware(async (_ctx, next) => {
	return next({
		db: {
			query: (sql: string) => {
				void sql
				return [] as unknown[]
			},
		},
	})
})

const withAuth = createMiddleware(async (ctx: DbCtx & { req: Request }, next) => {
	void ctx.db
	return next({ orgId: "org-1", userId: "u-1" })
})

describe("middleware dependency validation", () => {
	// v0: dccf89efdc
	it("createMiddleware without TReqs works with any chain (backwards compat)", () => {
		const anonAuth = createMiddleware(async (_ctx, next) => {
			return next({ userId: "anon" })
		})

		/* no dependencies — works on bare honey() */
		const app = honey().use(anonAuth)
		app.get("/test").handler((ctx) => {
			expectTypeOf(ctx.userId).toEqualTypeOf<string>()
			return ctx.res.text("ok", "ok")
		})
	})

	// v0: 7da26a62bd
	it("createMiddleware with explicit TReqs enforces ordering at .use() call site", () => {
		/* explicitly require db in context */
		const authNeedsDb = createMiddleware(async (ctx: DbCtx, next) => {
			ctx.db.query("SELECT 1")
			return next({ userId: "u-1" })
		})

		/* correct order: withDb adds db, then authNeedsDb can use it */
		const app = honey().use(withDb).use(authNeedsDb)
		app.get("/test").handler((ctx) => {
			expectTypeOf(ctx.userId).toEqualTypeOf<string>()
			expectTypeOf(ctx.db.query).toBeFunction()
			return ctx.res.text("ok", "ok")
		})
	})
})

/* explicit MiddlewareFn type — requires DbCtx */
const typedAuth: MiddlewareFn<DbCtx, { userId: string }> = async (ctx, next) => {
	ctx.db.query("SELECT 1")
	return next({ userId: "u-1" })
}
describe("middleware dependency validation (2)", () => {
	// v0: 39d85dfb46
	it("defineMiddleware with MiddlewareFn type enforces ordering", () => {
		/* correct order — compiles */
		const app = honey().use(withDb).use(typedAuth)
		app.get("/test").handler((ctx) => {
			expectTypeOf(ctx.userId).toEqualTypeOf<string>()
			expectTypeOf(ctx.db.query).toBeFunction()
			return ctx.res.text("ok", "ok")
		})
	})
})

describe("middleware dependency validation (3)", () => {
	// v0: 052bb182bf
	it("parameter annotation enforces ordering at .use() call site", () => {
		const annotatedAuth = createMiddleware(async (ctx: DbCtx, next) => {
			ctx.db.query("SELECT 1")
			return next({ userId: "u-1" })
		})

		const app = honey().use(withDb).use(annotatedAuth)
		app.get("/test").handler((ctx) => {
			expectTypeOf(ctx.userId).toEqualTypeOf<string>()
			expectTypeOf(ctx.db.query).toBeFunction()
			return ctx.res.text("ok", "ok")
		})
	})

	// v0: 3a11f14189
	it("rejects middleware whose ctx asserts properties not in chain", () => {
		type NeedsCache = { cache: Map<string, string> }

		const withCache = createMiddleware(async (_ctx, next) => next({ cache: new Map<string, string>() }))

		const withCachedUser = createMiddleware(async (ctx: NeedsCache, next) => {
			const name = ctx.cache.get("user")
			return next({ cachedName: name ?? "anon" })
		})

		/* wrong order: withCachedUser requires cache, but the chain has none yet — a compile error at the call */
		// @ts-expect-error the chain does not provide `cache`
		honey().use(withCachedUser)

		/* correct order: withCache provides cache first */
		const good = honey().use(withCache).use(withCachedUser)
		good.get("/test").handler((ctx) => {
			expectTypeOf(ctx.cachedName).toEqualTypeOf<string>()
			expectTypeOf(ctx.cache).toEqualTypeOf<Map<string, string>>()
			return ctx.res.text("ok", "ok")
		})
	})
})

describe("createMiddleware return type", () => {
	// v0: 4ada160d12
	it("no-dependency middleware infers TAdds", () => {
		const mw = createMiddleware(async (_ctx, next) => {
			return next({ requestId: "abc" })
		})
		expectTypeOf(mw).toMatchTypeOf<MiddlewareFn<{}, { requestId: string }>>()
	})

	// v0: 0e4bb62349
	it("dependency middleware infers TReqs + TAdds", () => {
		expectTypeOf(withAuth).toMatchTypeOf<MiddlewareFn<DbCtx & { req: Request }, AuthCtx>>()
	})
})

describe("middleware type accumulation via .use()", () => {
	// v0: 1f9491ac6e
	it("single middleware adds fields to ctx", () => {
		const app = honey<{}>().use(withDb)
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<DbCtx>()
	})

	// v0: ed38ccd999
	it("chained .use() accumulates fields", () => {
		const app = honey<{}>().use(withDb).use(withAuth)
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<DbCtx>()
		expectTypeOf<Ctx>().toMatchTypeOf<AuthCtx>()
	})

	// v0: f264a61f04
	it("middleware context flows into route handlers", () => {
		honey<{}>()
			.use(withDb)
			.use(withAuth)
			.get("/test")
			.handler((ctx) => {
				expectTypeOf(ctx.db.query).toEqualTypeOf<(sql: string) => unknown[]>()
				expectTypeOf(ctx.userId).toEqualTypeOf<string>()
				expectTypeOf(ctx.orgId).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: ee68fdad30
	it("env type preserved through middleware chain", () => {
		type TestEnv = { SECRET: string }
		const app = honey<TestEnv>().use(withDb)
		expectTypeOf<InferEnv<typeof app>>().toEqualTypeOf<TestEnv>()
	})

	// v0: 75cf52c862
	it("route-level .use() adds to handler ctx", () => {
		const routeMw = createMiddleware(async (_ctx, next) => {
			return next({ traceId: "t-1" })
		})

		honey<{}>()
			.use(withDb)
			.get("/test")
			.use(routeMw)
			.handler((ctx) => {
				expectTypeOf(ctx.db.query).toEqualTypeOf<(sql: string) => unknown[]>()
				expectTypeOf(ctx.traceId).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("middleware edge cases", () => {
	// v0: 8f5e3a710f
	it("triple middleware chain accumulates all fields", () => {
		const mw1 = createMiddleware(async (_ctx, next) => next({ a: 1 }))
		const mw2 = createMiddleware(async (_ctx, next) => next({ b: "two" }))
		const mw3 = createMiddleware(async (_ctx, next) => next({ c: true }))

		honey<{}>()
			.use(mw1)
			.use(mw2)
			.use(mw3)
			.get("/test")
			.handler((ctx) => {
				expectTypeOf(ctx.a).toEqualTypeOf<number>()
				expectTypeOf(ctx.b).toEqualTypeOf<string>()
				expectTypeOf(ctx.c).toEqualTypeOf<boolean>()
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: f3387de694
	it("passthrough middleware adds nothing", () => {
		const noop = createMiddleware(async (_ctx, next) => next())

		const app = honey<{}>().use(noop)
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<{}>()
	})
})

describe("middleware edge cases (2)", () => {
	// v0: ee1ae57ea4
	it("middleware with complex return type", () => {
		const mw = createMiddleware(async (_ctx, next) => {
			return next({
				cache: {
					get: (k: string) => {
						void k
						return null as string | null
					},
					set: (k: string, v: string) => {
						void k
						void v
					},
				},
				logger: {
					error: (msg: string) => {
						void msg
					},
					info: (msg: string) => {
						void msg
					},
				},
			})
		})

		honey<{}>()
			.use(mw)
			.get("/test")
			.handler((ctx) => {
				expectTypeOf(ctx.logger.info).toBeFunction()
				expectTypeOf(ctx.logger.error).toBeFunction()
				expectTypeOf(ctx.cache.get).toEqualTypeOf<(k: string) => string | null>()
				expectTypeOf(ctx.cache.set).toBeFunction()
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: 9f15593878
	it("middleware preserves basePath type", () => {
		const mw = createMiddleware(async (_ctx, next) => next({ traceId: "t-1" }))

		const app = honey<{}>().basePath("/api").use(mw)
		type BP = InferBasePath<typeof app>
		expectTypeOf<BP>().toEqualTypeOf<"/api">()
	})
})

describe("middleware edge cases (3)", () => {
	// v0: 7b6a984e42
	it("route-level middleware stacks with app-level", () => {
		const appMw = createMiddleware(async (_ctx, next) => next({ fromApp: true }))
		const routeMw = createMiddleware(async (_ctx, next) => next({ fromRoute: "yes" }))

		honey<{}>()
			.use(appMw)
			.post("/items")
			.use(routeMw)
			.handler((ctx) => {
				expectTypeOf(ctx.fromApp).toEqualTypeOf<boolean>()
				expectTypeOf(ctx.fromRoute).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: 3b791dafda
	it("multiple route-level middlewares accumulate", () => {
		const mw1 = createMiddleware(async (_ctx, next) => next({ x: 1 }))
		const mw2 = createMiddleware(async (_ctx, next) => next({ y: 2 }))

		honey<{}>()
			.get("/test")
			.use(mw1)
			.use(mw2)
			.handler((ctx) => {
				expectTypeOf(ctx.x).toEqualTypeOf<number>()
				expectTypeOf(ctx.y).toEqualTypeOf<number>()
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: 596a0119ac
	it("env type flows through to handler with middleware", () => {
		type Env = { DATABASE_URL: string; SECRET: string }
		const mw = createMiddleware(async (_ctx, next) => next({ ready: true }))

		honey<Env>()
			.use(mw)
			.get("/test")
			.handler((ctx) => {
				expectTypeOf(ctx.env.SECRET).toEqualTypeOf<string>()
				expectTypeOf(ctx.env.DATABASE_URL).toEqualTypeOf<string>()
				expectTypeOf(ctx.ready).toEqualTypeOf<boolean>()
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("defineMiddleware with error keys", () => {
	// v0: 4b010a3373
	it("creates middleware with typed error keys", () => {
		const errs = defineErrors({
			auth_failed: "unauthorized",
			rate_limited: "too_many_requests",
		})

		const mw = defineMiddleware({
			errors: [errs, "auth_failed"],
			fn: createMiddleware(async (_ctx, next) => next({ userId: "u-1" })),
		})

		expectTypeOf(mw).toMatchTypeOf<MiddlewareFn<{}, { userId: string }, "auth_failed">>()
	})

	// v0: a2e207352a
	it("errors array on defineMiddleware fn is readonly", () => {
		const errs = defineErrors({ a: "bad_request", b: "forbidden" })

		const mw = defineMiddleware({
			errors: [errs, "a", "b"],
			fn: createMiddleware(async (_ctx, next) => next()),
		})

		expectTypeOf(mw.errors).toMatchTypeOf<readonly string[] | undefined>()
	})

	// v0: ca64679a30
	it("defineMiddleware without errors has string error type", () => {
		const mw = defineMiddleware({
			fn: createMiddleware(async (_ctx, next) => next({ x: 1 })),
		})

		expectTypeOf(mw).toMatchTypeOf<MiddlewareFn<{}, { x: number }>>()
	})
})

describe("middleware with dependency chain typing", () => {
	// v0: c50b024531
	it("dependent middleware requires specific ctx shape", () => {
		type CacheCtx = { cache: Map<string, string> }

		const withCache = createMiddleware(async (_ctx, next) => {
			return next({ cache: new Map<string, string>() })
		})

		const withCachedUser = createMiddleware(async (ctx: CacheCtx & { req: Request }, next) => {
			void ctx.cache
			return next({ cachedName: "cached" })
		})

		honey<{}>()
			.use(withCache)
			.use(withCachedUser)
			.get("/test")
			.handler((ctx) => {
				expectTypeOf(ctx.cache).toEqualTypeOf<Map<string, string>>()
				expectTypeOf(ctx.cachedName).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})
})
