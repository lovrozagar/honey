import { describe, expectTypeOf, it } from "vitest"
import * as z from "zod"
import { honey } from "../../../src/index.ts"
import type {
	InferBasePath,
	InferRouteInput,
	InferRouteMethods,
	InferRouteOutput,
	InferRoutePaths,
	MergePath,
} from "../../../src/types.ts"

describe("MergePath", () => {
	it("/ + /users = /users", () => {
		expectTypeOf<MergePath<"/", "/users">>().toEqualTypeOf<"/users">()
	})

	it("/api + /users = /api/users", () => {
		expectTypeOf<MergePath<"/api", "/users">>().toEqualTypeOf<"/api/users">()
	})

	it("/api + / = /api", () => {
		expectTypeOf<MergePath<"/api", "/">>().toEqualTypeOf<"/api">()
	})

	it("/ + / = /", () => {
		expectTypeOf<MergePath<"/", "/">>().toEqualTypeOf<"/">()
	})

	it("/v1 + /api = /v1/api", () => {
		expectTypeOf<MergePath<"/v1", "/api">>().toEqualTypeOf<"/v1/api">()
	})

	it("triple nesting", () => {
		expectTypeOf<MergePath<MergePath<"/v1", "/api">, "/users">>().toEqualTypeOf<"/v1/api/users">()
	})
})

describe("InferBasePath", () => {
	it("default basePath is /", () => {
		const app = honey<{}>()
		expectTypeOf<InferBasePath<typeof app>>().toEqualTypeOf<"/">()
	})

	it("single basePath", () => {
		const app = honey<{}>().basePath("/api")
		expectTypeOf<InferBasePath<typeof app>>().toEqualTypeOf<"/api">()
	})

	it("nested basePath", () => {
		const app = honey<{}>().basePath("/v1").basePath("/api")
		expectTypeOf<InferBasePath<typeof app>>().toEqualTypeOf<"/v1/api">()
	})
})

describe("basePath + route registration", () => {
	it("routes registered under basePath appear with prefix", () => {
		const app = honey<{}>()
			.basePath("/api")
			.get("/users")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		expectTypeOf<InferRoutePaths<typeof app>>().toEqualTypeOf<"/api/users">()
	})

	it("method constrained to prefixed path", () => {
		const app = honey<{}>()
			.basePath("/api")
			.get("/users")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		expectTypeOf<InferRouteMethods<typeof app, "/api/users">>().toEqualTypeOf<"get">()
	})

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
	it("deep triple nesting via chained basePath", () => {
		const app = honey<{}>().basePath("/a").basePath("/b").basePath("/c")
		expectTypeOf<InferBasePath<typeof app>>().toEqualTypeOf<"/a/b/c">()
	})

	it("basePath with param segment", () => {
		expectTypeOf<MergePath<"/orgs/:orgId", "/users">>().toEqualTypeOf<"/orgs/:orgId/users">()
	})

	it("basePath with trailing param route", () => {
		expectTypeOf<MergePath<"/api", "/users/:id">>().toEqualTypeOf<"/api/users/:id">()
	})

	it("basePath with wildcard route", () => {
		expectTypeOf<MergePath<"/api", "/files/*path">>().toEqualTypeOf<"/api/files/*path">()
	})
})

describe("basePath + route InferRouteInput/Output", () => {
	it("InferRouteInput works with prefixed path", () => {
		const app = honey<{}>()
			.basePath("/api")
			.post("/users")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", { id: "1" }))

		type Input = InferRouteInput<typeof app, "/api/users", "post">
		expectTypeOf<Input>().toEqualTypeOf<{ json: { name: string } }>()
	})

	it("InferRouteOutput works with prefixed path", () => {
		const app = honey<{}>()
			.basePath("/api")
			.get("/users")
			.output({ "application/json": { ok: z.object({ id: z.string() }).array() } })
			.handler((ctx) => ctx.res.json("ok", [{ id: "1" }]))

		type Output = InferRouteOutput<typeof app, "/api/users", "get">
		expectTypeOf<Output>().toMatchTypeOf<{
			"application/json": { ok: z.ZodArray<z.ZodObject<{ id: z.ZodString }>> }
		}>()
	})
})

describe("basePath + routePattern literal", () => {
	it("handler routePattern includes basePath prefix", () => {
		honey<{}>()
			.basePath("/api")
			.get("/users/:id")
			.handler((ctx) => {
				expectTypeOf(ctx.routePattern).toEqualTypeOf<"/api/users/:id">()
				return ctx.res.text("ok", "ok")
			})
	})

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
	it("sub-app basePath merges with parent", () => {
		const sub = honey<{}>()
			.basePath("/users")
			.get("/")
			.handler((ctx) => ctx.res.text("ok", "ok"))
			.get("/:id")
			.handler((ctx) => ctx.res.text("ok", ctx.params.id))

		const app = honey<{}>().basePath("/api").route(sub)

		type Paths = InferRoutePaths<typeof app>
		expectTypeOf<Paths>().toMatchTypeOf<"/users" | "/users/:id">()
	})

	it("multiple methods on same prefixed path", () => {
		const app = honey<{}>()
			.basePath("/api")
			.get("/items")
			.handler((ctx) => ctx.res.text("ok", "ok"))
			.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", { id: "1" }))

		expectTypeOf<InferRouteMethods<typeof app, "/api/items">>().toEqualTypeOf<"get" | "post">()
	})
})
