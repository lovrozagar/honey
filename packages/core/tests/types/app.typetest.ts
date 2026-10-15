/**
 * The app, as typed: the Infer* ladder (ctx, env, basePath, meta, error factory, methods, paths,
 * a route's ctx) through use(), context() and meta<T>(), the public surface, and services typed
 * from the base app. Route-map types ($routes, MergeRoute, basePath registration) are in
 * app-routes.typetest.ts. Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import * as z from "zod"
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
	InferRouteErrors,
	InferRouteInput,
	InferRouteMeta,
	InferRouteMethods,
	InferRouteOutput,
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
	// v0: 61583f2251
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
	// v0: 46c948e313
	it("InferMeta is the meta<T>() type wherever use() and context() sit, and never without it", () => {
		const auth = createMiddleware((_ctx, next) => next({ userId: "u-1" }))
		expectTypeOf<InferMeta<ReturnType<typeof honey<TestEnv>>>>().toBeNever()
		const after = honey<TestEnv>().meta<AppMeta>().use(auth).context({ db: "sqlite" })
		const before = honey<TestEnv>().use(auth).context({ db: "sqlite" }).meta<AppMeta>()
		expectTypeOf<InferMeta<typeof after>>().toEqualTypeOf<AppMeta>()
		expectTypeOf<InferMeta<typeof before>>().toEqualTypeOf<AppMeta>()
	})

	// v0: dbe17bc0c7
	// v0: e89b534fd3
	// v0: 106673ab1b
	// v0: 415c216e89
	// v0: 75fe2e249d
	it("InferErrorFactory survives use(), so a route on the chain declares the factory's keys; never without one", () => {
		const errors = defineErrors({ email_taken: "conflict" })
		const chain = honey<{}>().errorFactory(errors).use(withDb)
		expectTypeOf<InferErrorFactory<typeof chain>>().toEqualTypeOf<typeof errors>()
		expectTypeOf<InferErrorFactory<ReturnType<typeof honey<TestEnv>>>>().toBeNever()
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
	// v0: 35f9728ea3
	// v0: c5991fd973
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

const errs = defineErrors({ a: "bad_request", b: "forbidden", c: "not_found", sub_err: "gone" })

describe("InferRouteErrors", () => {
	// v0: c4cca48881
	// v0: b387308a03
	// v0: 63f68628c4
	it("is the app's default keys beside the route's declared ones", () => {
		const app = honey<{}>()
			.errorFactory(errs)
			.defaultErrors("a")
			.get("/defaults")
			.handler((ctx) => ctx.res.text("ok", "ok"))
			.get("/both")
			.errors("b", "c")
			.handler((ctx) => ctx.res.text("ok", "ok"))
		expectTypeOf<InferRouteErrors<typeof app, "/defaults", "get">>().toEqualTypeOf<"a">()
		expectTypeOf<InferRouteErrors<typeof app, "/both", "get">>().toEqualTypeOf<"a" | "b" | "c">()
	})

	// v0: 26687b1a63
	// v0: 541352432f
	// v0: cbd135878d
	// v0: 2364c08270
	// v0: 5ec31325fa
	// v0: 6d05acb711
	// v0: e74a5a0747
	it("is each route's own keys, named with their factory; never for a route with none; kept through route(sub)", () => {
		const app = honey<{}>()
			.get("/a")
			.errors(errs, "a", "b")
			.handler((ctx) => ctx.res.text("ok", "ok"))
			.post("/b")
			.errors(errs, "c")
			.handler((ctx) => ctx.res.text("ok", "ok"))
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))
		expectTypeOf<InferRouteErrors<typeof app, "/a", "get">>().toEqualTypeOf<"a" | "b">()
		expectTypeOf<InferRouteErrors<typeof app, "/b", "post">>().toEqualTypeOf<"c">()
		expectTypeOf<InferRouteErrors<typeof app, "/health", "get">>().toBeNever()
		const sub = honey<{}>()
			.get("/items")
			.errors(errs, "sub_err")
			.handler((ctx) => ctx.res.text("ok", "ok"))
		const mounted = honey<{}>().route(sub)
		expectTypeOf<InferRouteErrors<typeof mounted, "/items", "get">>().toEqualTypeOf<"sub_err">()
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

describe("chain meta and the types around it", () => {
	const trace = createMiddleware((_ctx, next) => next({ traceId: "t-1" }))

	// v0: eec7376b03
	// v0: 742967526a
	// v0: 4fb96fc3e2
	// v0: 94c30f996f
	// v0: 5a9c31f6c4
	// v0: d40ff68d41
	// v0: 1179ee7a73
	// v0: 2220f8b4e7
	// v0: a783ced1ad
	it("InferMeta stays the meta<T>() type through chain values, use, basePath and context, per sub-chain; never without it", () => {
		const phantom = honey<{}>().meta<AppMeta>()
		const valued = honey<{}>().meta<AppMeta>({ tags: "Auth" })
		const chained = phantom.meta({ auth: "public" }).meta({ tags: "Auth" })
		const through = chained.use(trace).basePath("/api").context({ db: "sqlite" })
		const other = honey<{}>().meta<{ version?: number }>().meta({ version: 1 })
		const untyped = honey<{}>().meta({ summary: "hello", tags: "test" })
		expectTypeOf<InferMeta<typeof phantom>>().toEqualTypeOf<AppMeta>()
		expectTypeOf<InferMeta<typeof valued>>().toEqualTypeOf<AppMeta>()
		expectTypeOf<InferMeta<typeof chained>>().toEqualTypeOf<AppMeta>()
		expectTypeOf<InferMeta<typeof through>>().toEqualTypeOf<AppMeta>()
		expectTypeOf<InferMeta<typeof other>>().toEqualTypeOf<{ version?: number }>()
		expectTypeOf<InferMeta<typeof untyped>>().toBeNever()
	})

	// v0: ee72a529a9
	// v0: 7c891b2fe4
	// v0: 3f94d8a967
	// v0: 79c440bd65
	// v0: 872c60de41
	// v0: c1b08aeb6d
	it("leaves InferCtx, InferEnv and InferBasePath as they were", () => {
		const app = honey<TestEnv>().basePath("/api").meta<AppMeta>().meta({ auth: "public" }).use(trace)
		expectTypeOf<InferCtx<typeof app>>().toMatchTypeOf<{ env: TestEnv; traceId: string }>()
		expectTypeOf<InferEnv<typeof app>>().toEqualTypeOf<TestEnv>()
		expectTypeOf<InferBasePath<typeof app>>().toEqualTypeOf<"/api">()
	})
})

describe("ctx.meta beside chain meta", () => {
	const trace = createMiddleware((_ctx, next) => next({ traceId: "t-1" }))

	// v0: c6d39885ab
	// v0: 487a59c3bf
	// v0: 17e70b09ae
	// v0: 1805403000
	// v0: 8daeffc6c5
	// v0: 529072faf7
	// v0: 0181b14817
	// v0: f2386fc73a
	// v0: 4c13bd40c8
	// v0: 1e6272505d
	// v0: 28628ff81e
	// v0: 81869ea9bd
	it("ctx.meta beside chain meta: a route's values narrow it, DefaultMeta's keys beside TMeta's; a bare route gets the app type", () => {
		const base = honey<TestEnv>().meta<AppMeta>().meta({ auth: "required" }).context({ region: "eu" }).use(trace)
		base
			.post("/orgs/:orgId")
			.meta({ invalidate: ["GET /orgs"] as const, summary: "Create", tags: "Orgs" })
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => {
				expectTypeOf(ctx.meta.tags).toEqualTypeOf<string>()
				expectTypeOf(ctx.meta.invalidate).toEqualTypeOf<readonly ["GET /orgs"]>()
				expectTypeOf(ctx.region).toEqualTypeOf<string>()
				expectTypeOf(ctx.traceId).toEqualTypeOf<string>()
				expectTypeOf(ctx.input.json.name).toEqualTypeOf<string>()
				expectTypeOf(ctx.params.orgId).toEqualTypeOf<string>()
				expectTypeOf(ctx.env.SECRET).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
		base.get("/bare").handler((ctx) => {
			expectTypeOf(ctx.meta.tags).toEqualTypeOf<AppMeta["tags"]>()
			return ctx.res.text("ok", "ok")
		})
		// @ts-expect-error a key neither TMeta nor DefaultMeta has
		base.get("/x").meta({ unknown: true })
	})
})

describe("every Infer* over a get and a post on one path, without .meta()", () => {
	const withQuery = createMiddleware((_ctx, next) => next({ db: { query: (_sql: string): unknown[] => [] } }))
	const app = honey<TestEnv>()
		.use(withQuery)
		.get("/hello")
		.input({ search: z.object({ q: z.string() }) })
		.output({ "application/json": { ok: z.object({ q: z.string() }) } })
		.handler((c) => c.res.json("ok", { q: c.input.search.q }))
		.post("/hello")
		.input({ json: z.object({ q: z.string() }) })
		.output({ "application/json": { ok: z.object({ q: z.string() }) } })
		.handler((c) => c.res.json("ok", { q: c.input.json.q }))

	// v0: cdcd23a6ed
	// v0: ca3d66a61e
	// v0: 67004ab0ca
	// v0: 51bf890746
	// v0: 6abd3f6ae2
	// v0: 5c7ae7ae69
	it("the app-level Infer* types: routes, ctx, env, methods and paths", () => {
		expectTypeOf<InferRoutes<typeof app>>().toHaveProperty("/hello")
		expectTypeOf<InferCtx<typeof app>>().toMatchTypeOf<{ db: { query: (sql: string) => unknown[] } }>()
		expectTypeOf<InferEnv<typeof app>>().toEqualTypeOf<TestEnv>()
		expectTypeOf<InferMethods<typeof app>>().toEqualTypeOf<"get" | "post">()
		expectTypeOf<InferRoutePaths<typeof app>>().toEqualTypeOf<"/hello">()
		expectTypeOf<InferRouteMethods<typeof app, "/hello">>().toEqualTypeOf<"get" | "post">()
	})

	// v0: ec1e2f0b16
	// v0: 26d5e7650d
	// v0: 85b230d75c
	// v0: 41047b2bd0
	// v0: 2ab53d3ca1
	it("the per-route Infer* types: input, output, ctx, and an empty meta for a route without one", () => {
		expectTypeOf<InferRouteInput<typeof app, "/hello", "get">>().toEqualTypeOf<{ readonly search: { q: string } }>()
		expectTypeOf<InferRouteInput<typeof app, "/hello", "post">>().toEqualTypeOf<{ readonly json: { q: string } }>()
		expectTypeOf<InferRouteOutput<typeof app, "/hello", "get">["application/json"]>().toHaveProperty("ok")
		expectTypeOf<InferRouteCtx<typeof app, "/hello", "get">>().toMatchTypeOf<{
			db: { query: (sql: string) => unknown[] }
			input: { search: { q: string } }
		}>()
		expectTypeOf<InferRouteCtx<typeof app, "/hello", "post">>().toMatchTypeOf<{
			db: { query: (sql: string) => unknown[] }
			input: { json: { q: string } }
		}>()
		expectTypeOf<InferRouteMeta<typeof app, "/hello", "get">>().toEqualTypeOf<{}>()
	})
})

describe("the route builder's phantoms: what codegen's extractor reads", () => {
	it("a builder carries its middleware ctx (scoped and builder .use() included), its methods and its full path", () => {
		const scoped = createMiddleware((_ctx, next) => next({ scoped: 1 }))
		const added = createMiddleware((_ctx, next) => next({ added: "a" }))
		const app = honey<{ DB: string }>().basePath("/v1").use("/admin", scoped)
		const builder = app.on(["GET", "PUT"], "/admin/x").use(added)
		expectTypeOf(builder.$path).toEqualTypeOf<"/v1/admin/x">()
		expectTypeOf(builder.$method).toEqualTypeOf<"GET" | "PUT">()
		expectTypeOf(builder.$ctx).toEqualTypeOf<HoneyContext<{ DB: string }> & { scoped: number } & { added: string }>()
		/* the ctx before the handler re-declares params, meta, errors and input */
		expectTypeOf(builder.$ctx).not.toHaveProperty("input")
		expectTypeOf(app.get("/plain").$method).toEqualTypeOf<"GET">()
	})
})
