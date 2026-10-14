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
	InferRouteMeta,
	InferRouteMethods,
	InferRoutePaths,
	InferRoutes,
	MergeRoute,
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
	it("a route under a basePath registers, and sees its pattern, with every prefix", () => {
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
