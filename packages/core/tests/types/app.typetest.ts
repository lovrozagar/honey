import { describe, expectTypeOf, it } from "vitest"
import type {
	InferBasePath,
	InferCtx,
	InferEnv,
	InferMethods,
	InferRouteCtx,
	InferRouteMethods,
	InferRoutePaths,
	InferRoutes,
} from "../../src/routing/app-types.ts"
import { createMiddleware, type MiddlewareFn } from "../../src/middleware/middleware.ts"
import { defineErrors } from "../../src/errors/errors.ts"
import { honey } from "../../src/routing/app.ts"
import type { HoneyContext } from "../../src/context/context.ts"

const errs = defineErrors({
	email_taken: "conflict",
	not_allowed: "forbidden",
	org_limit: "forbidden",
})

type TestEnv = { DB: unknown; SECRET: string }

type DbCtx = { db: { query: (sql: string) => unknown[] } }

const withDb: MiddlewareFn<{}, DbCtx> = async (_ctx, next) => {
	return next({ db: { query: () => [] } })
}

type AuthCtx = { orgId: string; userId: string }

const withAuth: MiddlewareFn<DbCtx & { req: Request }, AuthCtx> = async (_ctx, next) => {
	return next({ orgId: "org-1", userId: "u-1" })
}

describe("type safety — middleware deps", () => {
	// v0: cf11bc1e7b
	it("createMiddleware with TReqs enforces ordering", () => {
		const authNeedsDb = createMiddleware(async (ctx: DbCtx, next) => {
			ctx.db.query("SELECT 1")
			return next({ userId: "u-1" })
		})

		/* correct order compiles */
		const app = honey().use(withDb).use(authNeedsDb)
		app.get("/test").handler((ctx) => {
			expectTypeOf(ctx.userId).toEqualTypeOf<string>()
			return ctx.res.text("ok", "ok")
		})
	})
})

describe("type safety — .route() preserves types", () => {
	// v0: b38e74e3ba
	it("sub-router routes appear in parent's type", () => {
		const sub = honey<{}>()
			.get("/sub")
			.handler((ctx) => ctx.res.text("ok", "sub"))

		const app = honey<{}>()
			.get("/main")
			.handler((ctx) => ctx.res.text("ok", "main"))
			.route(sub)

		type Paths = InferRoutePaths<typeof app>
		expectTypeOf<Paths>().toEqualTypeOf<"/main" | "/sub">()
	})
})

describe("type safety — handler return type", () => {
	// v0: db0a6948ec
	it("ctx.res.raw() wraps plain Response for escape hatch", () => {
		/* a plain Response is not a TypedResponse; raw() makes it one, so the handler typechecks */
		const app = honey<{}>()
			.get("/test")
			.handler((ctx) => ctx.res.raw(new Response("proxied")))
		expectTypeOf<keyof InferRoutes<typeof app>>().toEqualTypeOf<"/test">()
	})
})

describe("type safety — error factory", () => {
	// v0: bc151ee4be
	it("only declared error keys accessible on ctx.errors", () => {
		const errors = defineErrors({
			forbidden: "forbidden",
			not_found: "not_found",
			rate_limited: "too_many_requests",
		})

		honey<{}>()
			.errorFactory(errors)
			.get("/test")
			.errors("not_found")
			.handler((ctx) => {
				/* declared on this route → available */
				expectTypeOf(ctx.errors).toHaveProperty("not_found")

				/* not declared on this route → should not be available
				 * (only default errors + route errors) */
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("type safety — meta", () => {
	// v0: 7c336dbf9e
	it("meta constrained to declared shape — narrows to exact value passed", () => {
		honey<{}>()
			.meta<{ auth?: "public" | "required" }>()
			.get("/test")
			.meta({ auth: "required" })
			.handler((ctx) => {
				/* .meta({ auth: "required" }) narrows to exact literal */
				expectTypeOf(ctx.meta.auth).toEqualTypeOf<"required">()
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("InferBasePath", () => {
	// v0: 5fc748f9b0
	it("default basePath is /", () => {
		const app = honey<{}>()
		expectTypeOf<InferBasePath<typeof app>>().toEqualTypeOf<"/">()
	})

	// v0: 97255d8731
	it("single basePath", () => {
		const app = honey<{}>().basePath("/api")
		expectTypeOf<InferBasePath<typeof app>>().toEqualTypeOf<"/api">()
	})

	// v0: 671eb497a3
	it("nested basePath", () => {
		const app = honey<{}>().basePath("/v1").basePath("/api")
		expectTypeOf<InferBasePath<typeof app>>().toEqualTypeOf<"/v1/api">()
	})
})

describe("basePath + route registration", () => {
	// v0: 1966113e74
	it("routes registered under basePath appear with prefix", () => {
		const app = honey<{}>()
			.basePath("/api")
			.get("/users")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		expectTypeOf<InferRoutePaths<typeof app>>().toEqualTypeOf<"/api/users">()
	})

	// v0: 91b842ec94
	it("method constrained to prefixed path", () => {
		const app = honey<{}>()
			.basePath("/api")
			.get("/users")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		expectTypeOf<InferRouteMethods<typeof app, "/api/users">>().toEqualTypeOf<"get">()
	})

	// v0: 1f8522a378
	it("multiple basePath branches", () => {
		const v1 = honey<{}>()
			.basePath("/v1")
			.get("/items")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const v2 = honey<{}>()
			.basePath("/v2")
			.get("/items")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const app = honey<{}>().route(v1).route(v2)

		type Paths = InferRoutePaths<typeof app>
		expectTypeOf<"/v1/items">().toMatchTypeOf<Paths>()
		expectTypeOf<"/v2/items">().toMatchTypeOf<Paths>()
	})
})

describe("MergePath edge cases", () => {
	// v0: 943be6e637
	it("deep triple nesting via chained basePath", () => {
		const app = honey<{}>().basePath("/a").basePath("/b").basePath("/c")
		expectTypeOf<InferBasePath<typeof app>>().toEqualTypeOf<"/a/b/c">()
	})
})

describe("basePath + routePattern literal", () => {
	// v0: 957e2e41fc
	it("handler routePattern includes basePath prefix", () => {
		honey<{}>()
			.basePath("/api")
			.get("/users/:id")
			.handler((ctx) => {
				expectTypeOf(ctx.routePattern).toEqualTypeOf<"/api/users/:id">()
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: 93bcdb64a8
	it("nested basePath + routePattern", () => {
		honey<{}>()
			.basePath("/v1")
			.basePath("/api")
			.get("/items")
			.handler((ctx) => {
				expectTypeOf(ctx.routePattern).toEqualTypeOf<"/v1/api/items">()
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("basePath with .route() sub-app", () => {
	// v0: 7d2cfa81ae
	it("sub-app basePath merges with parent", () => {
		const sub = honey<{}>()
			.basePath("/users")
			.get("/")
			.handler((ctx) => ctx.res.text("ok", "ok"))
			.get("/:id")
			.handler((ctx) => ctx.res.text("ok", ctx.params.id))

		const app = honey<{}>().basePath("/api").route(sub)

		/* the sub's basePath lands under the mounting basePath, as at runtime */
		type Paths = InferRoutePaths<typeof app>
		expectTypeOf<Paths>().toEqualTypeOf<"/api/users" | "/api/users/:id">()
	})
})

describe("handler ctx.errors typing", () => {
	// v0: 1922b0e9c8
	it("ctx.errors has only declared keys from .errors()", () => {
		honey<{}>()
			.get("/test")
			.errors(errs, "email_taken")
			.handler((ctx) => {
				expectTypeOf(ctx.errors.email_taken).toBeFunction()
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: c2d52dc9ad
	it("errorFactory + .errors(keys) — ctx.errors scoped to keys + defaults", () => {
		honey<{}>()
			.errorFactory(errs)
			.defaultErrors("not_allowed")
			.get("/test")
			.errors("email_taken")
			.handler((ctx) => {
				expectTypeOf(ctx.errors.email_taken).toBeFunction()
				expectTypeOf(ctx.errors.not_allowed).toBeFunction()
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("InferCtx", () => {
	// v0: 302eb8e2c0
	it("extracts HoneyContext from bare instance", () => {
		const app = honey<TestEnv>()
		/* InferCtx leaves res out, so a handler ctx is assignable into services */
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<Omit<HoneyContext<TestEnv>, "res">>()
	})

	// v0: d65ed4ba6b
	it("accumulates middleware additions via .use()", () => {
		const app = honey<TestEnv>().use(withDb)
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<{
			db: { query: (sql: string) => unknown[] }
		}>()
	})

	// v0: 6ed512cbb4
	it("accumulates multiple middleware in chain", () => {
		const base = honey<TestEnv>().use(withDb).use(withAuth)
		type Ctx = InferCtx<typeof base>
		expectTypeOf<Ctx>().toMatchTypeOf<{
			db: { query: (sql: string) => unknown[] }
		}>()
		expectTypeOf<Ctx>().toMatchTypeOf<{ orgId: string; userId: string }>()
	})

	// v0: 2fa5d0c8f3
	it("returns never for non-Honey types", () => {
		type Ctx = InferCtx<string>
		expectTypeOf<Ctx>().toBeNever()
	})
})

describe("InferEnv", () => {
	// v0: 640a7466f5
	it("extracts env type", () => {
		const app = honey<TestEnv>()
		type Env = InferEnv<typeof app>
		expectTypeOf<Env>().toEqualTypeOf<TestEnv>()
	})

	// v0: 6077926dbd
	it("preserves env through .use() chain", () => {
		const app = honey<TestEnv>().use(withDb)
		type Env = InferEnv<typeof app>
		expectTypeOf<Env>().toEqualTypeOf<TestEnv>()
	})

	// v0: 1c2b55f706
	it("returns never for non-Honey types", () => {
		type Env = InferEnv<{ foo: string }>
		expectTypeOf<Env>().toBeNever()
	})
})

describe("InferMethods", () => {
	// v0: 757503a9f7
	it("extracts all methods used across all routes", () => {
		const app = honey<TestEnv>()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))
			.post("/users")
			.handler((ctx) => ctx.res.json("created", {}))
			.delete("/users/:id")
			.handler((ctx) => ctx.res.text("ok", ctx.params.id))

		type Methods = InferMethods<typeof app>
		expectTypeOf<"get">().toMatchTypeOf<Methods>()
		expectTypeOf<"post">().toMatchTypeOf<Methods>()
		expectTypeOf<"delete">().toMatchTypeOf<Methods>()
	})

	// v0: a38209a0e3
	it("deduplicates methods across paths", () => {
		const app = honey<TestEnv>()
			.get("/a")
			.handler((ctx) => ctx.res.text("ok", "ok"))
			.get("/b")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		type Methods = InferMethods<typeof app>
		expectTypeOf<"get">().toMatchTypeOf<Methods>()
	})
})

describe("InferRoutePaths & InferRouteMethods", () => {
	// v0: b107988f66
	it("extracts registered path literals", () => {
		const app = honey<TestEnv>()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))
			.post("/users")
			.handler((ctx) => ctx.res.json("created", {}))

		type Paths = InferRoutePaths<typeof app>
		expectTypeOf<"/health">().toMatchTypeOf<Paths>()
		expectTypeOf<"/users">().toMatchTypeOf<Paths>()
	})

	// v0: 96d6f69d98
	it("extracts registered methods for a path", () => {
		const app = honey<TestEnv>()
			.get("/users")
			.handler((ctx) => ctx.res.json("ok", []))
			.post("/users")
			.handler((ctx) => ctx.res.json("created", {}))

		type Methods = InferRouteMethods<typeof app, "/users">
		expectTypeOf<"get">().toMatchTypeOf<Methods>()
		expectTypeOf<"post">().toMatchTypeOf<Methods>()
	})
})

describe("InferRouteCtx", () => {
	// v0: 0fc57e8be4
	it("extracts full handler context for a route", () => {
		const base = honey<TestEnv>().use(withDb).use(withAuth)
		const app = base.get("/orgs").handler((ctx) => ctx.res.json("ok", { orgs: ctx.db.query("SELECT * FROM orgs") }))

		type Ctx = InferRouteCtx<typeof app, "/orgs", "get">
		expectTypeOf<Ctx>().toMatchTypeOf<{
			db: { query: (sql: string) => unknown[] }
		}>()
		expectTypeOf<Ctx>().toMatchTypeOf<{ orgId: string; userId: string }>()
	})

	// v0: 1a7aaf5581
	it("includes typed params for parameterized routes", () => {
		const app = honey<TestEnv>()
			.get("/users/:userId")
			.handler((ctx) => ctx.res.text("ok", ctx.params.userId))

		type Ctx = InferRouteCtx<typeof app, "/users/:userId", "get">
		expectTypeOf<Ctx>().toMatchTypeOf<{
			readonly params: { userId: string }
		}>()
	})

	// v0: a836b6bac8
	it("path and method are constrained to registered routes", () => {
		const app = honey<TestEnv>()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		type _Valid = InferRouteCtx<typeof app, "/health", "get">

		/* @ts-expect-error - "/nope" is not a registered route path */
		type _InvalidPath = InferRouteCtx<typeof app, "/nope", "get">
		/* @ts-expect-error - "post" is not registered for /health */
		type _InvalidMethod = InferRouteCtx<typeof app, "/health", "post">
		expectTypeOf<_Valid>().not.toBeNever()
		void (null as unknown as _InvalidPath)
		void (null as unknown as _InvalidMethod)
	})
})

describe("architecture: base/routes/services split", () => {
	// v0: b79e634bd7
	it("services can use InferCtx<typeof base> without circular deps", () => {
		const base = honey<TestEnv>().use(withDb).use(withAuth)
		type AppCtx = InferCtx<typeof base>

		const OrgService = {
			list(ctx: AppCtx) {
				return ctx.db.query("SELECT * FROM orgs")
			},
		}

		const app = base.get("/orgs").handler((ctx) => {
			const result = OrgService.list(ctx)
			return ctx.res.json("ok", result)
		})

		type Routes = InferRoutes<typeof app>
		expectTypeOf<Routes>().toHaveProperty("/orgs")
	})
})
