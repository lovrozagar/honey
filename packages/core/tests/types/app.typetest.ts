/**
 * The app, as typed: the Infer* ladder (ctx, env, basePath, meta, error factory, methods, paths,
 * a route's ctx) through use(), context() and meta<T>(), the public surface, and services typed
 * from the base app. Route-map types ($routes, MergeRoute, basePath registration) are in
 * app-routes.typetest.ts. Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import type { HoneyContext } from "../../src/context/context.ts"
import { defineErrors } from "../../src/errors/errors.ts"
import { createMiddleware, type MiddlewareFn } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"
import type {
	InferBasePath,
	InferCtx,
	InferEnv,
	InferErrorFactory,
	InferMeta,
	InferMethods,
	InferRouteCtx,
	InferRouteMethods,
	InferRoutePaths,
	InferRoutes,
} from "../../src/routing/app-types.ts"

type TestEnv = { DB: unknown; SECRET: string }
type Query = (sql: string) => unknown[]
type DbCtx = { db: { query: Query } }
type AuthCtx = { orgId: string; userId: string }
type AppMeta = { auth?: "public" | "required"; tags?: string }

const withDb: MiddlewareFn<{}, DbCtx> = (_ctx, next) => next({ db: { query: () => [] } })
const withAuth: MiddlewareFn<DbCtx & { req: Request }, AuthCtx> = (_ctx, next) =>
	next({ orgId: "org-1", userId: "u-1" })

describe("InferCtx", () => {
	// v0: 302eb8e2c0
	// v0: 2fa5d0c8f3
	it("is the handler ctx without res, and never for anything but an app", () => {
		expectTypeOf<InferCtx<ReturnType<typeof honey<TestEnv>>>>().toMatchTypeOf<Omit<HoneyContext<TestEnv>, "res">>()
		expectTypeOf<InferCtx<string>>().toBeNever()
	})

	// v0: d65ed4ba6b
	// v0: 6ed512cbb4
	// v0: 22f939dce9
	it("accumulates what each use() adds, beside context() values", () => {
		const app = honey<TestEnv>()
			.context({ region: "eu" })
			.use(withDb)
			.use(withAuth)
			.use(createMiddleware((_ctx, next) => next({ traceId: "t-1" })))
		expectTypeOf<InferCtx<typeof app>>().toMatchTypeOf<DbCtx & AuthCtx & { readonly region: string; traceId: string }>()
	})

	// v0: 4aa5223310
	// v0: 4af2f1ad51
	// v0: 15a01a5968
	// v0: 84dca20c67
	it("holds context() values readonly, accumulated across calls, a later value for a key winning", () => {
		const app = honey<{}>()
			.context({ config: { debug: true }, x: "first" as string })
			.context({ b: "two" })
			.context({ c: true, x: "second" as const })
		expectTypeOf<InferCtx<typeof app>>().toMatchTypeOf<{
			readonly b: string
			readonly c: boolean
			readonly config: { debug: boolean }
			readonly x: "second"
		}>()
		// @ts-expect-error context() values are readonly
		;(null as unknown as InferCtx<typeof app>).b = "changed"
	})
})

describe("the rest of the ladder through use(), context() and meta<T>()", () => {
	// v0: 640a7466f5
	// v0: 6077926dbd
	// v0: 1c2b55f706
	// v0: a05cd6822b
	// v0: ba08ca3116
	it("InferEnv and InferBasePath survive use() and context(), and InferEnv is never off an app", () => {
		const app = honey<TestEnv>().basePath("/api").use(withDb).context({ ready: true })
		expectTypeOf<InferEnv<typeof app>>().toEqualTypeOf<TestEnv>()
		expectTypeOf<InferBasePath<typeof app>>().toEqualTypeOf<"/api">()
		expectTypeOf<InferEnv<{ foo: string }>>().toBeNever()
	})

	// v0: aba963c487
	// v0: 93f4126e4b
	// v0: 05f38f4f3e
	// v0: 4bcc6a8d59
	// v0: 4c28e4b845
	// v0: 12aa68c1c5
	it("InferMeta is the meta<T>() type wherever use() and context() sit, and never without it", () => {
		const auth = createMiddleware((_ctx, next) => next({ userId: "u-1" }))
		expectTypeOf<InferMeta<ReturnType<typeof honey<TestEnv>>>>().toBeNever()
		const after = honey<TestEnv>().meta<AppMeta>().use(auth).context({ db: "sqlite" })
		const before = honey<TestEnv>().use(auth).context({ db: "sqlite" }).meta<AppMeta>()
		expectTypeOf<InferMeta<typeof after>>().toEqualTypeOf<AppMeta>()
		expectTypeOf<InferMeta<typeof before>>().toEqualTypeOf<AppMeta>()
	})

	// v0: dbe17bc0c7
	it("InferErrorFactory survives use(), so a route on the chain declares the factory's keys", () => {
		const errors = defineErrors({ email_taken: "conflict" })
		const chain = honey<{}>().errorFactory(errors).use(withDb)
		expectTypeOf<InferErrorFactory<typeof chain>>().toEqualTypeOf<typeof errors>()
		chain
			.get("/t")
			.errors("email_taken")
			.handler((ctx) => ctx.res.text("ok", ctx.db.query("SELECT 1").length.toString()))
	})
})

describe("methods, paths and a route's ctx", () => {
	// v0: 757503a9f7
	// v0: a38209a0e3
	// v0: b107988f66
	// v0: 96d6f69d98
	// v0: db0a6948ec
	it("InferMethods, InferRoutePaths and InferRouteMethods list what was registered, once each", () => {
		const app = honey<TestEnv>()
			.get("/health")
			.handler((ctx) => ctx.res.raw(new Response("ok")))
			.get("/users")
			.handler((ctx) => ctx.res.json("ok", []))
			.post("/users")
			.handler((ctx) => ctx.res.json("created", {}))
			.delete("/users/:id")
			.handler((ctx) => ctx.res.text("ok", ctx.params.id))
		expectTypeOf<InferMethods<typeof app>>().toEqualTypeOf<"delete" | "get" | "post">()
		expectTypeOf<InferRoutePaths<typeof app>>().toEqualTypeOf<"/health" | "/users" | "/users/:id">()
		expectTypeOf<InferRouteMethods<typeof app, "/users">>().toEqualTypeOf<"get" | "post">()
	})

	// v0: 0fc57e8be4
	// v0: 1a7aaf5581
	// v0: a836b6bac8
	it("InferRouteCtx is a registered route's full ctx, and only a registered route's", () => {
		const app = honey<TestEnv>()
			.use(withDb)
			.use(withAuth)
			.get("/orgs/:orgId")
			.handler((ctx) => ctx.res.json("ok", { orgs: ctx.db.query("SELECT 1") }))
		type Ctx = InferRouteCtx<typeof app, "/orgs/:orgId", "get">
		expectTypeOf<Ctx>().toMatchTypeOf<DbCtx & AuthCtx & { readonly params: { orgId: string } }>()
		// @ts-expect-error "/nope" is not a registered path
		expectTypeOf<InferRouteCtx<typeof app, "/nope", "get">>().not.toBeNever()
		// @ts-expect-error "post" is not registered for /orgs/:orgId
		expectTypeOf<InferRouteCtx<typeof app, "/orgs/:orgId", "post">>().not.toBeNever()
	})
})

describe("the public surface", () => {
	// v0: e76708eb15
	// v0: ef306ac48f
	// v0: b399066b8d
	// v0: 826cf2dd72
	// v0: 557604c912
	it("offers the builder and fetch, and none of the internals", () => {
		type App = ReturnType<typeof honey<{}>>
		expectTypeOf<App>().toHaveProperty("get")
		expectTypeOf<App>().toHaveProperty("post")
		expectTypeOf<App>().toHaveProperty("use")
		expectTypeOf<App>().toHaveProperty("meta")
		expectTypeOf<App>().toHaveProperty("context")
		expectTypeOf<App>().toHaveProperty("fetch")
		expectTypeOf<App>().toHaveProperty("route")
		expectTypeOf<App>().toHaveProperty("basePath")
		for (const internal of ["_tree", "_factory", "_boundaryKey", "_markWsRoutes"] as const)
			expectTypeOf<App>().not.toHaveProperty(internal)
	})
})

describe("services typed from the base app", () => {
	// v0: b79e634bd7
	it("a service takes InferCtx<typeof base>, and a route on the base passes its ctx", () => {
		const base = honey<TestEnv>().use(withDb).use(withAuth)
		const orgService = { list: (ctx: InferCtx<typeof base>) => ctx.db.query(`SELECT * FROM orgs WHERE ${ctx.orgId}`) }
		const app = base.get("/orgs").handler((ctx) => ctx.res.json("ok", orgService.list(ctx)))
		expectTypeOf<InferRoutes<typeof app>>().toHaveProperty("/orgs")
	})
})
