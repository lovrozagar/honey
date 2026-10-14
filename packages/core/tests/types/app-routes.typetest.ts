/**
 * The app's route map, as typed: $routes through MergeRoute at depth and per method, route meta on
 * the map (internal routes left out), basePath in registered paths and patterns, and route(sub)
 * merging a sub's routes under the mounting basePath. Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"
import type {
	InferBasePath,
	InferRouteCtx,
	InferRouteMeta,
	InferRouteMethods,
	InferRoutePaths,
	InferRoutes,
	MergeRoute,
	RouteRecord,
} from "../../src/routing/app-types.ts"

/** `n` GET routes /r1 … /rn merged one at a time, each answering `{ n: i }`. */
type Chain<N extends number, Acc = {}, I extends unknown[] = [0]> = I["length"] extends N
	? MergeRoute<Acc, `/r${I["length"]}`, "GET", {}, { n: I["length"] }, unknown>
	: Chain<N, MergeRoute<Acc, `/r${I["length"]}`, "GET", {}, { n: I["length"] }, unknown>, [...I, 0]>

describe("$routes", () => {
	// v0: 9bf8379dff
	it("a fresh app has no routes and no taps", () => {
		const app = honey<{}>()
		expectTypeOf<InferRoutes<typeof app>>().toEqualTypeOf<{}>()
		expectTypeOf<(typeof app)["$taps"]>().toEqualTypeOf<{}>()
	})

	// v0: 85569eeaad
	// v0: 6098a315b7
	// v0: ba3eadf318
	// v0: 870a6969bc
	// v0: f4a4d8751a
	// v0: 316a2b15d7
	// v0: 25cca07c4b
	// v0: d4a541c2b8
	// v0: 506e0c6f5c
	// v0: 983307d2e3
	// v0: 494247cfce
	it("keeps every route through 10, 20 and 30 merges: first, middle and last", () => {
		expectTypeOf<Chain<10>["/r1"]["get"]["output"]>().toEqualTypeOf<{ n: 1 }>()
		expectTypeOf<Chain<10>["/r5"]["get"]["output"]>().toEqualTypeOf<{ n: 5 }>()
		expectTypeOf<Chain<10>["/r10"]["get"]["output"]>().toEqualTypeOf<{ n: 10 }>()
		expectTypeOf<Chain<20>["/r1"]["get"]["output"]>().toEqualTypeOf<{ n: 1 }>()
		expectTypeOf<Chain<20>["/r15"]["get"]["output"]>().toEqualTypeOf<{ n: 15 }>()
		expectTypeOf<Chain<20>["/r20"]["get"]["output"]>().toEqualTypeOf<{ n: 20 }>()
		expectTypeOf<Chain<30>["/r1"]["get"]["output"]>().toEqualTypeOf<{ n: 1 }>()
		expectTypeOf<Chain<30>["/r25"]["get"]["output"]>().toEqualTypeOf<{ n: 25 }>()
		expectTypeOf<Chain<30>["/r30"]["get"]["output"]>().toEqualTypeOf<{ n: 30 }>()
	})
})

/** An app built through the builder with 25 GET routes, /r1 … /r25. */
const deep = honey<{}>()
	.get("/r1")
	.handler((ctx) => ctx.res.text("ok", "1"))
	.get("/r2")
	.handler((ctx) => ctx.res.text("ok", "2"))
	.get("/r3")
	.handler((ctx) => ctx.res.text("ok", "3"))
	.get("/r4")
	.handler((ctx) => ctx.res.text("ok", "4"))
	.get("/r5")
	.handler((ctx) => ctx.res.text("ok", "5"))
	.get("/r6")
	.handler((ctx) => ctx.res.text("ok", "6"))
	.get("/r7")
	.handler((ctx) => ctx.res.text("ok", "7"))
	.get("/r8")
	.handler((ctx) => ctx.res.text("ok", "8"))
	.get("/r9")
	.handler((ctx) => ctx.res.text("ok", "9"))
	.get("/r10")
	.handler((ctx) => ctx.res.text("ok", "10"))
	.get("/r11")
	.handler((ctx) => ctx.res.text("ok", "11"))
	.get("/r12")
	.handler((ctx) => ctx.res.text("ok", "12"))
	.get("/r13")
	.handler((ctx) => ctx.res.text("ok", "13"))
	.get("/r14")
	.handler((ctx) => ctx.res.text("ok", "14"))
	.get("/r15")
	.handler((ctx) => ctx.res.text("ok", "15"))
	.get("/r16")
	.handler((ctx) => ctx.res.text("ok", "16"))
	.get("/r17")
	.handler((ctx) => ctx.res.text("ok", "17"))
	.get("/r18")
	.handler((ctx) => ctx.res.text("ok", "18"))
	.get("/r19")
	.handler((ctx) => ctx.res.text("ok", "19"))
	.get("/r20")
	.handler((ctx) => ctx.res.text("ok", "20"))
	.get("/r21")
	.handler((ctx) => ctx.res.text("ok", "21"))
	.get("/r22")
	.handler((ctx) => ctx.res.text("ok", "22"))
	.get("/r23")
	.handler((ctx) => ctx.res.text("ok", "23"))
	.get("/r24")
	.handler((ctx) => ctx.res.text("ok", "24"))
	.get("/r25")
	.handler((ctx) => ctx.res.text("ok", "25"))

describe("$routes through the builder at depth, and per method", () => {
	// v0: 6265a25f30
	// v0: a6dc3175d9
	// v0: 68ecfacfe9
	// v0: bb01275b04
	it("a builder chain of 25 routes keeps its first and last, and is neither any nor never", () => {
		expectTypeOf(deep).not.toBeAny()
		expectTypeOf<InferRoutes<typeof deep>>().not.toBeAny()
		expectTypeOf<InferRoutes<typeof deep>>().not.toBeNever()
		expectTypeOf<InferRoutes<typeof deep>>().toHaveProperty("/r1")
		expectTypeOf<InferRoutes<typeof deep>>().toHaveProperty("/r25")
		expectTypeOf<InferRouteCtx<typeof deep, "/r1", "get">>().toMatchTypeOf<{ req: Request }>()
	})

	// v0: 626265f3f4
	// v0: de2ac9c5b7
	// v0: 3ed539499b
	it("keeps each method on one path with its own input and output", () => {
		type Users = MergeRoute<
			MergeRoute<
				MergeRoute<{}, "/users", "GET", {}, { list: true }, unknown>,
				"/users",
				"POST",
				{ json: { name: string } },
				{ created: true },
				unknown
			>,
			"/users",
			"DELETE",
			{},
			{ deleted: true },
			unknown
		>["/users"]
		expectTypeOf<Users["get"]["output"]>().toEqualTypeOf<{ list: true }>()
		expectTypeOf<Users["post"]["input"]>().toEqualTypeOf<{ json: { name: string } }>()
		expectTypeOf<Users["post"]["output"]>().toEqualTypeOf<{ created: true }>()
		expectTypeOf<Users["delete"]["output"]>().toEqualTypeOf<{ deleted: true }>()
	})
})

describe("MergeRoute and RouteRecord", () => {
	// v0: 765d7ff2b3
	// v0: f6abbb637b
	it("RouteRecord is path → lowercased method → the route's types", () => {
		expectTypeOf<RouteRecord<"GET", "/users", { json: { name: string } }, {}>>().toEqualTypeOf<{
			"/users": {
				get: { ctx: unknown; errors: never; errorsByStatus: never; input: { json: { name: string } }; output: {} }
			}
		}>()
		expectTypeOf<keyof RouteRecord<"POST", "/items", {}, {}, unknown, "not_found">["/items"]>().toEqualTypeOf<"post">()
	})

	// v0: 6217b769b1
	// v0: 7121db6861
	// v0: 5acdc3b4de
	// v0: f3316e55be
	it("MergeRoute adds a path, adds a method beside one, keeps errors, and intersects a repeated path and method", () => {
		type First = MergeRoute<{}, "/users", "GET", {}, {}, unknown>
		expectTypeOf<First>().toMatchTypeOf<{ "/users": { get: { ctx: unknown; input: {}; output: {} } } }>()
		expectTypeOf<keyof MergeRoute<First, "/users", "POST", {}, {}, unknown>["/users"]>().toEqualTypeOf<"get" | "post">()
		type Erring = MergeRoute<{}, "/t", "GET", {}, {}, unknown, {}, "forbidden" | "not_found">
		expectTypeOf<Erring["/t"]["get"]["errors"]>().toEqualTypeOf<"forbidden" | "not_found">()
		type Twice = MergeRoute<
			MergeRoute<{}, "/t", "GET", {}, { a: true }, unknown>,
			"/t",
			"GET",
			{},
			{ b: true },
			unknown
		>
		expectTypeOf<Twice["/t"]["get"]["output"]>().toEqualTypeOf<{ a: true } & { b: true }>()
	})
})

type AppMeta = { auth?: "public" | "required"; operationId?: string }

describe("route meta on the map", () => {
	// v0: 62fc72d2e4
	// v0: 27a2cae06c
	// v0: 8f635df394
	it("InferRouteMeta is the app meta type with the route's own values, however many routes came before, or a route map's meta", () => {
		const app = honey<{}>()
			.meta<AppMeta>()
			.get("/r1")
			.handler((ctx) => ctx.res.text("ok", "1"))
			.get("/r2")
			.handler((ctx) => ctx.res.text("ok", "2"))
			.get("/orgs")
			.meta({ auth: "required" })
			.handler((ctx) => ctx.res.text("ok", "orgs"))
			.get("/r6")
			.meta({ operationId: "r6" })
			.handler((ctx) => ctx.res.text("ok", "6"))
		expectTypeOf<InferRouteMeta<typeof app, "/orgs", "get">>().toEqualTypeOf<{
			auth: "required"
			operationId?: string
		}>()
		expectTypeOf<InferRouteMeta<typeof app, "/r6", "get">>().toEqualTypeOf<{
			auth?: "public" | "required"
			operationId: string
		}>()
		type Routes = { "/orgs": { get: { ctx: unknown; input: {}; meta: { auth: "required" }; output: {} } } }
		expectTypeOf<InferRouteMeta<{ $routes: Routes }, "/orgs", "get">>().toEqualTypeOf<{ auth: "required" }>()
	})

	// v0: 6242aa2673
	// v0: 6c8d006dbb
	// v0: 2d308b01b9
	it("an internal route, marked on itself or on its chain, is left out of the map", () => {
		const base = honey<{}>()
			.meta<AppMeta>()
			.use(createMiddleware((_ctx, next) => next({ added: true })))
			.get("/public")
			.handler((ctx) => ctx.res.json("ok", {}))
			.get("/own")
			.meta({ internal: true })
			.handler((ctx) => ctx.res.json("ok", {}))
		const internal = base.meta({ internal: true })
		const app = internal
			.get("/metrics")
			.handler((ctx) => ctx.res.json("ok", {}))
			.get("/debug")
			.handler((ctx) => ctx.res.json("ok", {}))
		expectTypeOf<keyof InferRoutes<typeof app>>().toEqualTypeOf<"/public">()
	})
})

describe("basePath in the map", () => {
	// v0: 5fc748f9b0
	// v0: 97255d8731
	// v0: 671eb497a3
	// v0: 943be6e637
	it("InferBasePath is /, one prefix, or every chained prefix joined", () => {
		expectTypeOf<InferBasePath<ReturnType<typeof honey<{}>>>>().toEqualTypeOf<"/">()
		const app = honey<{}>()
		expectTypeOf<InferBasePath<ReturnType<typeof app.basePath<"/api">>>>().toEqualTypeOf<"/api">()
		const nested = app.basePath("/a").basePath("/b").basePath("/c")
		expectTypeOf<InferBasePath<typeof nested>>().toEqualTypeOf<"/a/b/c">()
	})

	// v0: 1966113e74
	// v0: 91b842ec94
	// v0: 957e2e41fc
	// v0: 93bcdb64a8
	// v0: a57bbf193e
	it("a route under a basePath registers, and sees its pattern, with every prefix", () => {
		const items = honey<{}>()
			.basePath("/api")
			.get("/items")
			.handler((ctx) => ctx.res.text("ok", "ok"))
			.post("/items")
			.handler((ctx) => ctx.res.json("created", { id: "1" }))
		expectTypeOf<InferRouteMethods<typeof items, "/api/items">>().toEqualTypeOf<"get" | "post">()
		const app = honey<{}>()
			.basePath("/v1")
			.basePath("/api")
			.get("/users/:id")
			.handler((ctx) => {
				expectTypeOf(ctx.routePattern).toEqualTypeOf<"/v1/api/users/:id">()
				return ctx.res.text("ok", ctx.params.id)
			})
		expectTypeOf<InferRoutePaths<typeof app>>().toEqualTypeOf<"/v1/api/users/:id">()
		expectTypeOf<InferRouteMethods<typeof app, "/v1/api/users/:id">>().toEqualTypeOf<"get">()
	})
})

describe("route(sub) in the map", () => {
	// v0: b38e74e3ba
	// v0: 1f8522a378
	// v0: 7d2cfa81ae
	// v0: 16b03bc5b2
	it("merges each sub's routes beside the parent's, the sub's basePath under the mounting one", () => {
		const v1 = honey<{}>()
			.basePath("/v1")
			.get("/items")
			.handler((ctx) => ctx.res.text("ok", "v1"))
		const users = honey<{}>()
			.basePath("/users")
			.get("/")
			.handler((ctx) => ctx.res.text("ok", "list"))
			.get("/:id")
			.handler((ctx) => ctx.res.text("ok", ctx.params.id))
		const app = honey<{}>()
			.get("/main")
			.handler((ctx) => ctx.res.text("ok", "main"))
			.route(v1)
		const api = honey<{}>().basePath("/api").route(users)
		expectTypeOf<InferRoutePaths<typeof app>>().toEqualTypeOf<"/main" | "/v1/items">()
		expectTypeOf<InferRoutePaths<typeof api>>().toEqualTypeOf<"/api/users" | "/api/users/:id">()
	})
})
