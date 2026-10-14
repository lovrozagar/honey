/**
 * The handler's ctx, as typed: params and routePattern from the pattern (basePath included),
 * ctx.errors from the declared and default keys, ctx.meta narrowed per route, what context(),
 * chain and route middleware add, and the request fields. Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import { defineErrors } from "../../src/errors/errors.ts"
import { createMiddleware, type MiddlewareFn } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"
import type { InferCtx } from "../../src/routing/app-types.ts"

describe("ctx.params", () => {
	// v0: 8d3b08b315
	// v0: ff90c7202d
	// v0: 89fdb4aad5
	// v0: 7736027c21
	// v0: 6b6144b460
	// v0: 2feb2fc30d
	// v0: 85d5006667
	// v0: 7c0132f759
	// v0: d6cc3e11ca
	it("types each param and wildcard the pattern names as string, under a basePath too", () => {
		const app = honey<{}>()
		app.get("/users/:id").handler((ctx) => {
			expectTypeOf(ctx.params.id).toEqualTypeOf<string>()
			return ctx.res.text("ok", "ok")
		})
		app.get("/orgs/:orgId/teams/:teamId/members/:memberId").handler((ctx) => {
			expectTypeOf(ctx.params.orgId).toEqualTypeOf<string>()
			expectTypeOf(ctx.params.teamId).toEqualTypeOf<string>()
			expectTypeOf(ctx.params.memberId).toEqualTypeOf<string>()
			return ctx.res.text("ok", "ok")
		})
		app.get("/files/*path").handler((ctx) => {
			expectTypeOf(ctx.params.path).toEqualTypeOf<string>()
			return ctx.res.text("ok", "ok")
		})
		app
			.basePath("/api")
			.get("/users/:userId/posts/:postId")
			.handler((ctx) => {
				expectTypeOf(ctx.params.userId).toEqualTypeOf<string>()
				expectTypeOf(ctx.params.postId).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: 3f6106e491
	it("is Record<string, string> on a route without params", () => {
		honey<{}>()
			.get("/static")
			.handler((ctx) => {
				expectTypeOf(ctx.params).toEqualTypeOf<Record<string, string>>()
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("ctx.routePattern", () => {
	// v0: 45a652f26b
	// v0: 47d24793b5
	// v0: 8511e270c9
	// v0: 1a48196937
	// v0: c6543756c1
	it("is the full pattern as a literal: plain, param, root, and under a basePath", () => {
		const app = honey<{}>()
		app.get("/users").handler((ctx) => {
			expectTypeOf(ctx.routePattern).toEqualTypeOf<"/users">()
			return ctx.res.text("ok", "ok")
		})
		app.get("/users/:id").handler((ctx) => {
			expectTypeOf(ctx.routePattern).toEqualTypeOf<"/users/:id">()
			return ctx.res.text("ok", "ok")
		})
		app.get("/").handler((ctx) => {
			expectTypeOf(ctx.routePattern).toEqualTypeOf<"/">()
			return ctx.res.text("ok", "ok")
		})
		app
			.basePath("/api")
			.get("/users/:id")
			.handler((ctx) => {
				expectTypeOf(ctx.routePattern).toEqualTypeOf<"/api/users/:id">()
				return ctx.res.text("ok", "ok")
			})
	})
})

const errors = defineErrors({ email_taken: "conflict", invalid_input: "bad_request", org_limit: "forbidden" })

describe("ctx.errors", () => {
	// v0: a53900b1cd
	// v0: 055a967c28
	// v0: 04f36d619c
	// v0: bc151ee4be
	// v0: 1922b0e9c8
	it("holds exactly the keys the route declares, named alone or with their factory", () => {
		const app = honey<{}>().errorFactory(errors)
		app
			.get("/a")
			.errors("email_taken")
			.handler((ctx) => {
				expectTypeOf(ctx.errors.email_taken).toEqualTypeOf(errors.email_taken)
				expectTypeOf(ctx.errors).not.toHaveProperty("org_limit")
				expectTypeOf(ctx.errors).not.toHaveProperty("invalid_input")
				return ctx.res.text("ok", "ok")
			})
		honey<{}>()
			.get("/b")
			.errors(errors, "email_taken", "org_limit")
			.handler((ctx) => {
				expectTypeOf(ctx.errors.email_taken).toEqualTypeOf(errors.email_taken)
				expectTypeOf(ctx.errors.org_limit).toEqualTypeOf(errors.org_limit)
				expectTypeOf(ctx.errors).not.toHaveProperty("invalid_input")
				expectTypeOf(ctx.errors).not.toHaveProperty("other")
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: 7754770a73
	// v0: c2d52dc9ad
	it("always holds the app's default keys, which a route may not declare again", () => {
		const route = honey<{}>().errorFactory(errors).defaultErrors("invalid_input").get("/t")
		// @ts-expect-error invalid_input is already a default error
		route.errors("invalid_input")
		route.errors("email_taken").handler((ctx) => {
			expectTypeOf(ctx.errors.email_taken).toBeFunction()
			expectTypeOf(ctx.errors.invalid_input).toBeFunction()
			expectTypeOf(ctx.errors).not.toHaveProperty("org_limit")
			return ctx.res.text("ok", "ok")
		})
	})
})

type AppMeta = { auth?: "public" | "required"; worker?: string }

describe("ctx.meta", () => {
	// v0: 6a2f0d03de
	// v0: cc3ecf16f8
	// v0: 22d95f2a17
	// v0: 7c336dbf9e
	it("is narrowed to each route's own values, and readonly", () => {
		const base = honey<{}>().meta<AppMeta>()
		base
			.get("/public")
			.meta({ auth: "public" })
			.handler((ctx) => {
				expectTypeOf(ctx.meta.auth).toEqualTypeOf<"public">()
				expectTypeOf(ctx.meta).toMatchTypeOf<Readonly<{ auth: "public" }>>()
				return ctx.res.text("ok", "ok")
			})
		base
			.get("/private")
			.meta({ auth: "required" })
			.handler((ctx) => {
				expectTypeOf(ctx.meta.auth).toEqualTypeOf<"required">()
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: 1460dc840b
	it("is the app's meta type on a route that sets none, a catch-all included", () => {
		honey<{}>()
			.meta<AppMeta>()
			.all("*")
			.handler((ctx) => {
				expectTypeOf(ctx.meta.auth).toEqualTypeOf<AppMeta["auth"]>()
				expectTypeOf(ctx.meta.worker).toEqualTypeOf<AppMeta["worker"]>()
				return ctx.res.text("ok", "ok")
			})
	})
})

type DbCtx = { db: string }
const withDb: MiddlewareFn<{}, DbCtx> = (_ctx, next) => next({ db: "test-db" })
const withAuth: MiddlewareFn<DbCtx, { user: { id: string } }> = (_ctx, next) => next({ user: { id: "u1" } })

describe("what context() and chain middleware add", () => {
	// v0: 3bc43be1a6
	// v0: 10be49f6aa
	// v0: 70672703cc
	it("context() values and chain additions are typed on ctx, complex values kept whole", () => {
		type Cache = { get: (key: string) => string | null; set: (key: string, value: string) => void }
		const cache: Cache = { get: () => null, set: () => undefined }
		const app = honey<{}>()
			.context({ appName: "test", cache, config: { timeout: 5000 } })
			.use(createMiddleware((_ctx, next) => next({ traceId: "t-1" })))
		app.get("/t").handler((ctx) => {
			expectTypeOf(ctx.appName).toEqualTypeOf<string>()
			expectTypeOf(ctx.cache).toEqualTypeOf<Cache>()
			expectTypeOf(ctx.config).toEqualTypeOf<{ timeout: number }>()
			expectTypeOf(ctx.traceId).toEqualTypeOf<string>()
			expectTypeOf(ctx.env).toEqualTypeOf<{}>()
			return ctx.res.text("ok", "ok")
		})
		expectTypeOf<InferCtx<typeof app>>().toMatchTypeOf<{ readonly cache: Cache }>()
	})

	// v0: 8521d1da18
	// v0: 7c994b6cd7
	it("middleware may require what context() provides, at chain and route level", () => {
		const needsDb = createMiddleware((_ctx: { db: string }, next) => next({ queried: true }))
		const needsConfig = createMiddleware((_ctx: { config: { timeout: number } }, next) =>
			next({ validated: true as const }),
		)
		const app = honey<{}>()
			.context({ config: { timeout: 5000 }, db: "sqlite" })
			.use(needsDb)
		expectTypeOf<InferCtx<typeof app>>().toMatchTypeOf<{ readonly db: string; queried: boolean }>()
		app
			.get("/t")
			.use(needsConfig)
			.handler((ctx) => {
				expectTypeOf(ctx.validated).toEqualTypeOf<true>()
				return ctx.res.text("ok", "ok")
			})
		// @ts-expect-error a chain without context({ db }) cannot use needsDb
		honey<{}>().use(needsDb)
	})
})

describe("what route middleware adds", () => {
	// v0: 28c9af69a7
	// v0: f95826d9d6
	// v0: 8464a3cf8a
	it("route-level use() calls accumulate, each seeing what the earlier ones added", () => {
		honey<{}>()
			.get("/t")
			.use(withDb)
			.use(withAuth)
			.use(createMiddleware((_ctx, next) => next({ b: "two" })))
			.handler((ctx) => {
				expectTypeOf(ctx.db).toEqualTypeOf<string>()
				expectTypeOf(ctx.user.id).toEqualTypeOf<string>()
				expectTypeOf(ctx.b).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
		// @ts-expect-error withAuth needs db, which nothing added yet
		honey<{}>().get("/t").use(withAuth)
	})
})

describe("the request fields", () => {
	// v0: 3296607f56
	// v0: b5ebb2d677
	// v0: 0cdc648c4b
	it("ctx.req is a Request, ctx.env the app's env type, and there is no input without .input()", () => {
		honey<{ API_KEY: string; DB_URL: string }>()
			.get("/t")
			.handler((ctx) => {
				expectTypeOf(ctx.req).toEqualTypeOf<Request>()
				expectTypeOf(ctx.env).toEqualTypeOf<{ API_KEY: string; DB_URL: string }>()
				expectTypeOf(ctx).not.toHaveProperty("input")
				return ctx.res.text("ok", "ok")
			})
	})
})
