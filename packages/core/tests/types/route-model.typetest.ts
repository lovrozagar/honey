/**
 * Route-level types (bit 01): what a path pattern means at the type level. Checked by
 * `bun run typecheck`; the app-level infer ladder is bit 02's.
 */
import { describe, expectTypeOf, it } from "vitest"
import type { MergePath, ParamKeys, ParamsFromPath, PrefixRoutes } from "../../src/routing/types.ts"

describe("ParamKeys", () => {
	// v0: 58828108cc
	it("extracts single param", () => {
		expectTypeOf<ParamKeys<"/users/:id">>().toEqualTypeOf<"id">()
	})

	// v0: 25607a9ba5
	it("extracts multiple params", () => {
		expectTypeOf<ParamKeys<"/users/:id/posts/:postId">>().toEqualTypeOf<"id" | "postId">()
	})

	// v0: d33e0962e2
	it("extracts wildcard with name", () => {
		expectTypeOf<ParamKeys<"/files/*path">>().toEqualTypeOf<"path">()
	})

	// v0: 228836a599
	it("extracts unnamed wildcard as '*'", () => {
		expectTypeOf<ParamKeys<"/files/*">>().toEqualTypeOf<"*">()
	})

	// v0: 499bd1e74b
	it("strips optional marker from param", () => {
		expectTypeOf<ParamKeys<"/users/:id?">>().toEqualTypeOf<"id">()
	})

	// v0: a3c7c5652b
	it("returns never for static path", () => {
		expectTypeOf<ParamKeys<"/health">>().toBeNever()
	})

	// v0: 7c40a44252
	it("returns never for root path", () => {
		expectTypeOf<ParamKeys<"/">>().toBeNever()
	})

	// v0: a529f8299b
	it("handles deeply nested params", () => {
		expectTypeOf<ParamKeys<"/a/:b/c/:d/e/:f">>().toEqualTypeOf<"b" | "d" | "f">()
	})
})

describe("ParamsFromPath", () => {
	// v0: 733dcb0032
	it("maps single param to { id: string }", () => {
		expectTypeOf<ParamsFromPath<"/users/:id">>().toEqualTypeOf<{ id: string }>()
	})

	// v0: e772eee880
	it("maps multiple params", () => {
		expectTypeOf<ParamsFromPath<"/users/:id/posts/:postId">>().toEqualTypeOf<{ id: string; postId: string }>()
	})

	// v0: 5206c14f61
	it("returns Record<string, string> for static path", () => {
		expectTypeOf<ParamsFromPath<"/health">>().toEqualTypeOf<Record<string, string>>()
	})

	// v0: 805f69dea5
	it("maps wildcard param", () => {
		expectTypeOf<ParamsFromPath<"/files/*path">>().toEqualTypeOf<{ path: string }>()
	})
})

describe("ParamKeys edge cases", () => {
	// v0: c835733a64
	it("param at root level /:id", () => {
		expectTypeOf<ParamKeys<"/:id">>().toEqualTypeOf<"id">()
	})

	// v0: 221d451e8a
	it("param + wildcard in same path", () => {
		expectTypeOf<ParamKeys<"/files/:dir/*rest">>().toEqualTypeOf<"dir" | "rest">()
	})

	// v0: c9584d035d
	it("multiple optional params", () => {
		expectTypeOf<ParamKeys<"/users/:id?/posts/:postId?">>().toEqualTypeOf<"id" | "postId">()
	})

	// v0: 6e51dfaeb0
	it("single segment path with param", () => {
		expectTypeOf<ParamKeys<"/:slug">>().toEqualTypeOf<"slug">()
	})

	// v0: 96163a8a7f
	it("wildcard only path", () => {
		expectTypeOf<ParamKeys<"/*">>().toEqualTypeOf<"*">()
	})

	// v0: 1a45046311
	it("named wildcard after static segments", () => {
		expectTypeOf<ParamKeys<"/api/v1/*rest">>().toEqualTypeOf<"rest">()
	})
})

describe("ParamsFromPath edge cases", () => {
	// v0: b25110e9be
	it("root param path", () => {
		expectTypeOf<ParamsFromPath<"/:id">>().toEqualTypeOf<{ id: string }>()
	})

	// v0: aeb9db3076
	it("mixed param + wildcard path", () => {
		expectTypeOf<ParamsFromPath<"/files/:dir/*rest">>().toEqualTypeOf<{ dir: string; rest: string }>()
	})

	// v0: dda7be630b
	it("optional param still mapped", () => {
		expectTypeOf<ParamsFromPath<"/users/:id?">>().toEqualTypeOf<{ id: string }>()
	})

	// v0: 3f54cbe57b
	it("root path is generic Record", () => {
		expectTypeOf<ParamsFromPath<"/">>().toEqualTypeOf<Record<string, string>>()
	})
})

describe("MergePath", () => {
	// v0: f8db82bd3d
	it("/ + /users = /users", () => {
		expectTypeOf<MergePath<"/", "/users">>().toEqualTypeOf<"/users">()
	})

	// v0: 1bedfc6090
	it("/api + /users = /api/users", () => {
		expectTypeOf<MergePath<"/api", "/users">>().toEqualTypeOf<"/api/users">()
	})

	// v0: 3ff6b0792e
	it("/api + / = /api", () => {
		expectTypeOf<MergePath<"/api", "/">>().toEqualTypeOf<"/api">()
	})

	// v0: 52e52a7b42
	it("/ + / = /", () => {
		expectTypeOf<MergePath<"/", "/">>().toEqualTypeOf<"/">()
	})

	// v0: a3caed7bf5
	it("/v1 + /api = /v1/api", () => {
		expectTypeOf<MergePath<"/v1", "/api">>().toEqualTypeOf<"/v1/api">()
	})

	// v0: f4f9c303e3
	it("triple nesting", () => {
		expectTypeOf<MergePath<MergePath<"/v1", "/api">, "/users">>().toEqualTypeOf<"/v1/api/users">()
	})
})

describe("MergePath edge cases", () => {
	// v0: 7730b4c359
	it("basePath with param segment", () => {
		expectTypeOf<MergePath<"/orgs/:orgId", "/users">>().toEqualTypeOf<"/orgs/:orgId/users">()
	})

	// v0: 4cbb67d814
	it("basePath with trailing param route", () => {
		expectTypeOf<MergePath<"/api", "/users/:id">>().toEqualTypeOf<"/api/users/:id">()
	})

	// v0: 9e0ef788a2
	it("basePath with wildcard route", () => {
		expectTypeOf<MergePath<"/api", "/files/*path">>().toEqualTypeOf<"/api/files/*path">()
	})
})

describe("PrefixRoutes", () => {
	it("moves a sub-app's routes under the mounting base path", () => {
		type Routes = { "/": { GET: 1 }; "/users/:id": { GET: 2; PUT: 3 } }
		expectTypeOf<PrefixRoutes<"/api", Routes>>().toEqualTypeOf<{
			"/api": { GET: 1 }
			"/api/users/:id": { GET: 2; PUT: 3 }
		}>()
	})

	it("leaves the routes as they are under the root", () => {
		type Routes = { "/a": { GET: 1 } }
		expectTypeOf<PrefixRoutes<"/", Routes>>().toEqualTypeOf<Routes>()
	})
})
