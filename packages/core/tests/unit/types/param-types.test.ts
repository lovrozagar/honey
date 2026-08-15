import { describe, expectTypeOf, it } from "vitest"
import { honey } from "../../../src/index.ts"
import type { ParamKeys, ParamsFromPath } from "../../../src/types.ts"

describe("ParamKeys", () => {
	it("extracts single param", () => {
		expectTypeOf<ParamKeys<"/users/:id">>().toEqualTypeOf<"id">()
	})

	it("extracts multiple params", () => {
		expectTypeOf<ParamKeys<"/users/:id/posts/:postId">>().toEqualTypeOf<"id" | "postId">()
	})

	it("extracts wildcard with name", () => {
		expectTypeOf<ParamKeys<"/files/*path">>().toEqualTypeOf<"path">()
	})

	it("extracts unnamed wildcard as '*'", () => {
		expectTypeOf<ParamKeys<"/files/*">>().toEqualTypeOf<"*">()
	})

	it("strips optional marker from param", () => {
		expectTypeOf<ParamKeys<"/users/:id?">>().toEqualTypeOf<"id">()
	})

	it("returns never for static path", () => {
		expectTypeOf<ParamKeys<"/health">>().toBeNever()
	})

	it("returns never for root path", () => {
		expectTypeOf<ParamKeys<"/">>().toBeNever()
	})

	it("handles deeply nested params", () => {
		expectTypeOf<ParamKeys<"/a/:b/c/:d/e/:f">>().toEqualTypeOf<"b" | "d" | "f">()
	})
})

describe("ParamsFromPath", () => {
	it("maps single param to { id: string }", () => {
		expectTypeOf<ParamsFromPath<"/users/:id">>().toEqualTypeOf<{ id: string }>()
	})

	it("maps multiple params", () => {
		expectTypeOf<ParamsFromPath<"/users/:id/posts/:postId">>().toEqualTypeOf<{
			id: string
			postId: string
		}>()
	})

	it("returns Record<string, string> for static path", () => {
		expectTypeOf<ParamsFromPath<"/health">>().toEqualTypeOf<Record<string, string>>()
	})

	it("maps wildcard param", () => {
		expectTypeOf<ParamsFromPath<"/files/*path">>().toEqualTypeOf<{ path: string }>()
	})
})

describe("handler ctx.params typing", () => {
	it("parameterized route — ctx.params.id is string", () => {
		honey<{}>()
			.get("/users/:id")
			.handler((ctx) => {
				expectTypeOf(ctx.params.id).toEqualTypeOf<string>()
				return ctx.res.text("ok", ctx.params.id)
			})
	})

	it("multi-param route — ctx.params has both params", () => {
		honey<{}>()
			.get("/users/:userId/posts/:postId")
			.handler((ctx) => {
				expectTypeOf(ctx.params.userId).toEqualTypeOf<string>()
				expectTypeOf(ctx.params.postId).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("static route — ctx.params is generic Record", () => {
		honey<{}>()
			.get("/health")
			.handler((ctx) => {
				expectTypeOf(ctx.params).toEqualTypeOf<Record<string, string>>()
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("ParamKeys edge cases", () => {
	it("param at root level /:id", () => {
		expectTypeOf<ParamKeys<"/:id">>().toEqualTypeOf<"id">()
	})

	it("param + wildcard in same path", () => {
		expectTypeOf<ParamKeys<"/files/:dir/*rest">>().toEqualTypeOf<"dir" | "rest">()
	})

	it("multiple optional params", () => {
		expectTypeOf<ParamKeys<"/users/:id?/posts/:postId?">>().toEqualTypeOf<"id" | "postId">()
	})

	it("single segment path with param", () => {
		expectTypeOf<ParamKeys<"/:slug">>().toEqualTypeOf<"slug">()
	})

	it("wildcard only path", () => {
		expectTypeOf<ParamKeys<"/*">>().toEqualTypeOf<"*">()
	})

	it("named wildcard after static segments", () => {
		expectTypeOf<ParamKeys<"/api/v1/*rest">>().toEqualTypeOf<"rest">()
	})
})

describe("ParamsFromPath edge cases", () => {
	it("root param path", () => {
		expectTypeOf<ParamsFromPath<"/:id">>().toEqualTypeOf<{ id: string }>()
	})

	it("mixed param + wildcard path", () => {
		expectTypeOf<ParamsFromPath<"/files/:dir/*rest">>().toEqualTypeOf<{
			dir: string
			rest: string
		}>()
	})

	it("optional param still mapped", () => {
		expectTypeOf<ParamsFromPath<"/users/:id?">>().toEqualTypeOf<{ id: string }>()
	})

	it("root path is generic Record", () => {
		expectTypeOf<ParamsFromPath<"/">>().toEqualTypeOf<Record<string, string>>()
	})
})

describe("handler params with basePath", () => {
	it("basePath + param route — params typed correctly", () => {
		honey<{}>()
			.basePath("/api")
			.get("/users/:id")
			.handler((ctx) => {
				expectTypeOf(ctx.params.id).toEqualTypeOf<string>()
				expectTypeOf(ctx.routePattern).toEqualTypeOf<"/api/users/:id">()
				return ctx.res.text("ok", "ok")
			})
	})
})
