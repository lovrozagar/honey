/**
 * Middleware, as typed: what createMiddleware infers (requirements from the ctx annotation,
 * additions from next()), requirements checked where use() is called, what a chain accumulates
 * for its handlers, defineMiddleware's error keys, and the route builder's one-shot methods.
 * Scoped use(path, mw) types are in middleware-scoped.typetest.ts. Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import * as z from "zod"
import { defineErrors } from "../../src/errors/errors.ts"
import { createMiddleware, defineMiddleware, type MiddlewareFn } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"
import type { InferBasePath, InferCtx, InferEnv } from "../../src/routing/app-types.ts"

type Query = (sql: string) => unknown[]
type DbCtx = { db: { query: Query } }

const withDb = createMiddleware((_ctx, next) => next({ db: { query: ((_sql: string) => []) as Query } }))
const withAuth = createMiddleware((ctx: DbCtx & { req: Request }, next) => {
	void ctx.db
	return next({ orgId: "org-1", userId: "u-1" })
})

const typed: MiddlewareFn<DbCtx, { userId: string }> = (ctx, next) => {
	ctx.db.query("SELECT 1")
	return next({ userId: "u-1" })
}

describe("what createMiddleware infers", () => {
	// v0: 4ada160d12
	// v0: b7218553fa
	// v0: f3387de694
	// v0: ee1ae57ea4
	it("additions from next(), whole and exact, and nothing when next() adds nothing", () => {
		type Cache = { get: (key: string) => string | null; set: (key: string, value: string) => void }
		const cache: Cache = { get: () => null, set: () => undefined }
		expectTypeOf(createMiddleware((_ctx, next) => next({ requestId: "abc" }))).toMatchTypeOf<
			MiddlewareFn<{}, { requestId: string }>
		>()
		expectTypeOf(createMiddleware((_ctx, next) => next({ cache, ready: true }))).toMatchTypeOf<
			MiddlewareFn<{}, { cache: Cache; ready: boolean }>
		>()
		const noop = createMiddleware((_ctx, next) => next())
		expectTypeOf(noop).toMatchTypeOf<MiddlewareFn<{}, {}>>()
		const bare = honey<{}>()
		expectTypeOf<keyof InferCtx<ReturnType<typeof bare.use<typeof noop>>>>().toEqualTypeOf<
			keyof InferCtx<typeof bare>
		>()
	})

	// v0: 0e4bb62349
	// v0: 324340b36e
	// v0: 39d85dfb46
	it("requirements from the ctx annotation, or from an explicit MiddlewareFn", () => {
		expectTypeOf(withAuth).toMatchTypeOf<MiddlewareFn<DbCtx & { req: Request }, { orgId: string; userId: string }>>()
		expectTypeOf(typed).toMatchTypeOf<MiddlewareFn<DbCtx, { userId: string }>>()
	})

	// v0: 47d4ca6f15
	it("a union of additions when next() is called with different shapes", () => {
		type Jwt = { sub: string; typ: "jwt" }
		type ApiKey = { kid: string; typ: "api_key" }
		const auth = createMiddleware((ctx: { req: Request }, next) =>
			ctx.req.headers.get("x-layer") === "jwt"
				? next({ auth: { sub: "u-1", typ: "jwt" } satisfies Jwt })
				: next({ auth: { kid: "k-1", typ: "api_key" } satisfies ApiKey }),
		)
		honey<{}>()
			.use(auth)
			.get("/t")
			.handler((ctx) => {
				expectTypeOf(ctx.auth).toEqualTypeOf<Jwt | ApiKey>()
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("requirements are checked where use() is called", () => {
	// v0: dccf89efdc
	// v0: 7da26a62bd
	// v0: 052bb182bf
	// v0: 3a11f14189
	// v0: c50b024531
	// v0: cf11bc1e7b
	// v0: fb9d3b3996
	it("a middleware without requirements fits any chain; one with them fits only after its providers", () => {
		const anon = createMiddleware((_ctx, next) => next({ userId: "anon" }))
		honey().use(anon)
		const needsDb = createMiddleware((ctx: DbCtx, next) => {
			ctx.db.query("SELECT 1")
			return next({ userId: "u-1" })
		})
		// @ts-expect-error the chain does not provide db yet
		honey().use(needsDb)
		honey()
			.use(withDb)
			.use(needsDb)
			.get("/t")
			.handler((ctx) => {
				expectTypeOf(ctx.userId).toEqualTypeOf<string>()
				expectTypeOf(ctx.db.query).toEqualTypeOf<Query>()
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: f43d4ed03e
	it("a middleware may narrow what an earlier one added", () => {
		const wide = createMiddleware((_ctx, next) => next({ kind: "a" as "a" | "b" }))
		const narrow = createMiddleware((ctx: { kind: "a" | "b" }, next) => {
			if (ctx.kind !== "a") throw new Error("expected a")
			return next({ kind: "a" as const })
		})
		honey<{}>()
			.use(wide)
			.use(narrow)
			.get("/t")
			.handler((ctx) => {
				expectTypeOf(ctx.kind).toEqualTypeOf<"a">()
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("what a chain accumulates", () => {
	// v0: 1f9491ac6e
	// v0: ed38ccd999
	// v0: f264a61f04
	// v0: 8f5e3a710f
	// v0: 25778170ed
	// v0: 5dafa280e7
	it("every use() adds its additions, on InferCtx and in handlers", () => {
		const app = honey<{}>()
			.use(withDb)
			.use(withAuth)
			.use(
				createMiddleware((_ctx, next) => next({ cache: new Map<string, string>(), role: "admin" as "admin" | "user" })),
			)
		expectTypeOf<InferCtx<typeof app>>().toMatchTypeOf<DbCtx & { orgId: string; userId: string }>()
		app.get("/t").handler((ctx) => {
			expectTypeOf(ctx.db.query).toEqualTypeOf<Query>()
			expectTypeOf(ctx.orgId).toEqualTypeOf<string>()
			expectTypeOf(ctx.cache).toEqualTypeOf<Map<string, string>>()
			expectTypeOf(ctx.role).toEqualTypeOf<"admin" | "user">()
			return ctx.res.text("ok", "ok")
		})
	})

	// v0: ee68fdad30
	// v0: 596a0119ac
	// v0: 9f15593878
	it("use() keeps the env and basePath types", () => {
		type Env = { DATABASE_URL: string; SECRET: string }
		const app = honey<Env>().basePath("/api").use(withDb)
		expectTypeOf<InferEnv<typeof app>>().toEqualTypeOf<Env>()
		expectTypeOf<InferBasePath<typeof app>>().toEqualTypeOf<"/api">()
		app.get("/t").handler((ctx) => {
			expectTypeOf(ctx.env.SECRET).toEqualTypeOf<string>()
			return ctx.res.text("ok", "ok")
		})
	})

	// v0: 75cf52c862
	// v0: 7b6a984e42
	// v0: 3b791dafda
	it("route-level use() stacks on the chain's additions", () => {
		honey<{}>()
			.use(createMiddleware((_ctx, next) => next({ fromApp: true })))
			.post("/items")
			.use(createMiddleware((_ctx, next) => next({ fromRoute: "yes" })))
			.use(createMiddleware((_ctx, next) => next({ y: 2 })))
			.handler((ctx) => {
				expectTypeOf(ctx.fromApp).toEqualTypeOf<boolean>()
				expectTypeOf(ctx.fromRoute).toEqualTypeOf<string>()
				expectTypeOf(ctx.y).toEqualTypeOf<number>()
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("defineMiddleware and its error keys", () => {
	const errs = defineErrors({ auth_failed: "unauthorized", rate_limited: "too_many_requests" })

	// v0: 4b010a3373
	// v0: a2e207352a
	// v0: ca64679a30
	it("types the keys it names from the factory, readonly, and none when it names none", () => {
		const named = defineMiddleware({
			errors: [errs, "auth_failed"],
			fn: createMiddleware((_ctx, next) => next({ userId: "u-1" })),
		})
		expectTypeOf(named).toMatchTypeOf<MiddlewareFn<{}, { userId: string }, "auth_failed">>()
		expectTypeOf(named.errors).toMatchTypeOf<readonly string[] | undefined>()
		const plain = defineMiddleware({ fn: createMiddleware((_ctx, next) => next({ x: 1 })) })
		expectTypeOf(plain).toMatchTypeOf<MiddlewareFn<{}, { x: number }>>()
		// @ts-expect-error a key the factory does not have
		defineMiddleware({ errors: [errs, "missing"], fn: createMiddleware((_ctx, next) => next()) })
	})
})

describe("the route builder's one-shot methods", () => {
	// v0: 75cec192da
	// v0: 9d3ec7169b
	it("a one-shot method is gone once used; use() and handler() stay", () => {
		const errs = defineErrors({ internal_server_error: "internal_server_error" })
		const bounded = honey<{}>().errorFactory(errs).get("/t").boundary("internal_server_error")
		expectTypeOf(bounded).not.toHaveProperty("boundary")
		const used = honey<{}>()
			.get("/t")
			.use(createMiddleware((_ctx, next) => next({ a: 1 })))
			.use(createMiddleware((_ctx, next) => next({ b: 2 })))
		expectTypeOf(used).toHaveProperty("use")
		expectTypeOf(used).toHaveProperty("handler")
	})
})

const ONE_SHOTS = ["boundary", "errors", "input", "meta", "output"] as const

describe("the route builder's one-shots: what stays and what goes", () => {
	// v0: 3cdd42041d
	// v0: f84705bad9
	// v0: d097b40cac
	it("a fresh builder has every one-shot, use() and handler(), whatever its methods", () => {
		for (const builder of [honey<{}>().get("/t"), honey<{}>().post("/t"), honey<{}>().on(["GET", "POST"], "/t")]) {
			for (const method of [...ONE_SHOTS, "use", "handler"] as const) expectTypeOf(builder).toHaveProperty(method)
		}
	})

	// v0: 424196d93d
	// v0: d80b5d7c80
	// v0: 2d8fde8b4b
	// v0: d936b826ba
	// v0: 18ec8dd64f
	// v0: 59f27c5468
	// v0: 9e1cec2375
	it("each one-shot goes once used, every other one stays", () => {
		const errs = defineErrors({
			forbidden: "forbidden",
			internal_server_error: "internal_server_error",
			not_found: "not_found",
		})
		const route = honey<{}>().errorFactory(errs).get("/t")
		const input = route.input({ json: z.object({ name: z.string() }) })
		const errors = route.errors("not_found", "forbidden")
		const boundary = route.boundary("internal_server_error")
		const meta = route.meta({ summary: "x" })
		expectTypeOf(meta).not.toHaveProperty("meta")
		for (const method of ["boundary", "errors", "input", "output", "use", "handler"] as const) {
			expectTypeOf(meta).toHaveProperty(method)
		}
		expectTypeOf(input).not.toHaveProperty("input")
		expectTypeOf(errors).not.toHaveProperty("errors")
		expectTypeOf(boundary).not.toHaveProperty("boundary")
		for (const method of ["boundary", "errors", "meta", "output", "use", "handler"] as const) {
			expectTypeOf(input).toHaveProperty(method)
		}
		for (const method of ["boundary", "input", "meta", "output", "handler"] as const) {
			expectTypeOf(errors).toHaveProperty(method)
		}
		for (const method of ["errors", "input", "meta", "output", "handler"] as const) {
			expectTypeOf(boundary).toHaveProperty(method)
		}
	})
})

describe("the route builder's one-shots through later calls", () => {
	// v0: 07cf0d14fc
	// v0: 3e32c59f4d
	// v0: 83c49ae0f2
	// v0: 8444cc701a
	// v0: 8b89fae5a3
	it("a used one-shot stays gone through later calls; use() stays through all of them", () => {
		const errs = defineErrors({ bad_request: "bad_request" })
		const pass = createMiddleware((_ctx, next) => next({ x: 1 }))
		const afterErrors = honey<{}>()
			.errorFactory(errs)
			.get("/t")
			.input({ json: z.object({ n: z.string() }) })
			.errors("bad_request")
		const afterUse = honey<{}>()
			.get("/t")
			.input({ json: z.object({ n: z.string() }) })
			.use(pass)
		const afterMeta = honey<{}>()
			.get("/t")
			.input({ json: z.object({ n: z.string() }) })
			.meta({ summary: "x" })
		const afterOutput = honey<{}>()
			.get("/t")
			.meta({ summary: "x" })
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
		const everything = afterOutput.input({ json: z.object({ n: z.string() }) }).use(pass)
		expectTypeOf(afterErrors).not.toHaveProperty("input")
		expectTypeOf(afterErrors).not.toHaveProperty("errors")
		expectTypeOf(afterUse).not.toHaveProperty("input")
		expectTypeOf(afterMeta).not.toHaveProperty("input")
		expectTypeOf(afterOutput).not.toHaveProperty("meta")
		expectTypeOf(afterOutput).not.toHaveProperty("output")
		expectTypeOf(afterOutput).toHaveProperty("input")
		expectTypeOf(everything).toHaveProperty("use")
		expectTypeOf(everything).toHaveProperty("handler")
	})
})
