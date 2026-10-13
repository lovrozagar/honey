import { describe, expectTypeOf, it } from "vitest"
import { defineErrors, honey } from "../../../src/index.ts"
import type { MiddlewareFn } from "../../../src/middleware.ts"
import { createMiddleware, defineMiddleware } from "../../../src/middleware.ts"
import type { InferBasePath, InferCtx, InferEnv } from "../../../src/types.ts"

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

const withAuth = createMiddleware<DbCtx & { req: Request }, AuthCtx>(async (ctx, next) => {
	void ctx.db
	return next({ orgId: "org-1", userId: "u-1" })
})

describe("createMiddleware return type", () => {
	it("no-dependency middleware infers TAdds", () => {
		const mw = createMiddleware(async (_ctx, next) => {
			return next({ requestId: "abc" })
		})
		expectTypeOf(mw).toMatchTypeOf<MiddlewareFn<{}, { requestId: string }>>()
	})

	it("dependency middleware infers TReqs + TAdds", () => {
		expectTypeOf(withAuth).toMatchTypeOf<MiddlewareFn<DbCtx & { req: Request }, AuthCtx>>()
	})
})

describe("middleware type accumulation via .use()", () => {
	it("single middleware adds fields to ctx", () => {
		const app = honey<{}>().use(withDb)
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<DbCtx>()
	})

	it("chained .use() accumulates fields", () => {
		const app = honey<{}>().use(withDb).use(withAuth)
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<DbCtx>()
		expectTypeOf<Ctx>().toMatchTypeOf<AuthCtx>()
	})

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

	it("env type preserved through middleware chain", () => {
		type TestEnv = { SECRET: string }
		const app = honey<TestEnv>().use(withDb)
		expectTypeOf<InferEnv<typeof app>>().toEqualTypeOf<TestEnv>()
	})

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

	it("passthrough middleware adds nothing", () => {
		const noop = createMiddleware(async (_ctx, next) => next())

		const app = honey<{}>().use(noop)
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<{}>()
	})

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

	it("middleware preserves basePath type", () => {
		const mw = createMiddleware(async (_ctx, next) => next({ traceId: "t-1" }))

		const app = honey<{}>().basePath("/api").use(mw)
		type BP = InferBasePath<typeof app>
		expectTypeOf<BP>().toEqualTypeOf<"/api">()
	})

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

	it("errors array on defineMiddleware fn is readonly", () => {
		const errs = defineErrors({ a: "bad_request", b: "forbidden" })

		const mw = defineMiddleware({
			errors: [errs, "a", "b"],
			fn: createMiddleware(async (_ctx, next) => next()),
		})

		expectTypeOf(mw.errors).toMatchTypeOf<readonly string[] | undefined>()
	})

	it("defineMiddleware without errors has string error type", () => {
		const mw = defineMiddleware({
			fn: createMiddleware(async (_ctx, next) => next({ x: 1 })),
		})

		expectTypeOf(mw).toMatchTypeOf<MiddlewareFn<{}, { x: number }>>()
	})
})

describe("middleware with dependency chain typing", () => {
	it("dependent middleware requires specific ctx shape", () => {
		type CacheCtx = { cache: Map<string, string> }

		const withCache = createMiddleware(async (_ctx, next) => {
			return next({ cache: new Map<string, string>() })
		})

		const withCachedUser = createMiddleware<CacheCtx & { req: Request }, { cachedName: string }>(async (ctx, next) => {
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

describe("parameter annotation createMiddleware", () => {
	it("infers both TReqs and TAdds from ctx annotation + next()", () => {
		type DbCtx = { db: { query: (sql: string) => unknown[] } }
		const mw = createMiddleware(async (ctx: DbCtx, next) => {
			void ctx.db
			return next({ userId: "u-1" })
		})
		expectTypeOf(mw).toMatchTypeOf<MiddlewareFn<DbCtx, { userId: string }>>()
	})

	it("narrowing middleware works via intersection collapse", () => {
		type Wide = { kind: "a" | "b" }

		const withWide = createMiddleware(async (_ctx, next) => next({ kind: "a" as "a" | "b" }))
		const withNarrow = createMiddleware(async (ctx: Wide, next) => {
			if (ctx.kind !== "a") throw new Error("expected a")
			return next({ kind: "a" as const })
		})

		honey<{}>()
			.use(withWide)
			.use(withNarrow)
			.get("/test")
			.handler((ctx) => {
				expectTypeOf(ctx.kind).toEqualTypeOf<"a">()
				return ctx.res.text("ok", "ok")
			})
	})

	it("non-overlapping middleware keys accumulate", () => {
		const mw1 = createMiddleware(async (_ctx, next) => next({ a: 1 }))
		const mw2 = createMiddleware(async (_ctx, next) => next({ b: "two" }))

		honey<{}>()
			.use(mw1)
			.use(mw2)
			.get("/test")
			.handler((ctx) => {
				expectTypeOf(ctx.a).toEqualTypeOf<number>()
				expectTypeOf(ctx.b).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("zero-dependency middleware needs no annotation", () => {
		const mw = createMiddleware(async (_ctx, next) => next({ ready: true }))
		expectTypeOf(mw).toMatchTypeOf<MiddlewareFn<{}, { ready: boolean }>>()
	})

	it("union branches infer TAdds as union via ExtractAdds", () => {
		type JwtPayload = { typ: "jwt"; sub: string }
		type ApiKeyPayload = { typ: "api_key"; kid: string }

		const withAuth = createMiddleware((ctx: { req: Request }, next) => {
			const isJwt = ctx.req.headers.get("x-layer") === "jwt"
			if (isJwt) {
				return next({ auth: { typ: "jwt", sub: "u-1" } satisfies JwtPayload })
			}
			return next({ auth: { typ: "api_key", kid: "k-1" } satisfies ApiKeyPayload })
		})

		honey<{}>()
			.use(withAuth)
			.get("/test")
			.handler((ctx) => {
				expectTypeOf(ctx.auth).toEqualTypeOf<JwtPayload | ApiKeyPayload>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("full chain: next() return types propagate through .use() correctly", () => {
		const withDb = createMiddleware(async (_ctx, next) => next({ db: "pg" as const }))
		const withCache = createMiddleware(async (_ctx, next) => next({ cache: new Map<string, string>() }))
		const withUser = createMiddleware(async (ctx: { db: "pg" }, next) => {
			void ctx.db
			return next({ userId: "u-1", role: "admin" as "admin" | "user" })
		})

		honey<{}>()
			.use(withDb)
			.use(withCache)
			.use(withUser)
			.get("/test")
			.handler((ctx) => {
				expectTypeOf(ctx.db).toEqualTypeOf<"pg">()
				expectTypeOf(ctx.cache).toEqualTypeOf<Map<string, string>>()
				expectTypeOf(ctx.userId).toEqualTypeOf<string>()
				expectTypeOf(ctx.role).toEqualTypeOf<"admin" | "user">()
				return ctx.res.text("ok", "ok")
			})
	})
})
