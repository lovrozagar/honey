/**
 * ctx.res as typed: each helper returns a TypedResponse branded with its content type and status
 * key (noContent and redirect at any status included, raw() with an open brand), brands that keep
 * one content type or status key from passing for another, every TypedResponse a Response, and a
 * handler that returns a plain Response refused. Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import { HoneyRes, type TypedResponse } from "../../src/response/response.ts"
import { honey } from "../../src/routing/app.ts"

const res = new HoneyRes()

describe("each helper's brand", () => {
	// v0: 2b0ae6e08f
	// v0: 234b934a7d
	// v0: 28a0025c64
	// v0: 8a0d253d15
	// v0: 353d1a79d1
	// v0: 066c275239
	// v0: c0e4aa75c0
	// v0: eb641c1f55
	it("a body helper is its content type with the status key it was given", () => {
		expectTypeOf(res.json("ok", { id: "1" })).toEqualTypeOf<TypedResponse<"application/json", "ok">>()
		expectTypeOf(res.json("created", { id: "1" })).toEqualTypeOf<TypedResponse<"application/json", "created">>()
		expectTypeOf(res.json("bad_request", { error: "x" })).toEqualTypeOf<
			TypedResponse<"application/json", "bad_request">
		>()
		expectTypeOf(res.text("ok", "hello")).toEqualTypeOf<TypedResponse<"text/plain", "ok">>()
		expectTypeOf(res.text("created", "done")).toEqualTypeOf<TypedResponse<"text/plain", "created">>()
		expectTypeOf(res.html("ok", "<h1>hi</h1>")).toEqualTypeOf<TypedResponse<"text/html", "ok">>()
		expectTypeOf(res.xml("ok", "<root />")).toEqualTypeOf<TypedResponse<"application/xml", "ok">>()
		expectTypeOf(res.csv("ok", "a,b,c")).toEqualTypeOf<TypedResponse<"text/csv", "ok">>()
	})

	// v0: 82c82625a9
	// v0: 82741fbadd
	// v0: b6dd1c326b
	// v0: 9d24243c2e
	it("noContent is none and no_content, redirect none and found at any status, raw() open", () => {
		expectTypeOf(res.noContent()).toEqualTypeOf<TypedResponse<"none", "no_content">>()
		expectTypeOf(res.redirect("/login")).toEqualTypeOf<TypedResponse<"none", "found">>()
		expectTypeOf(res.redirect("/login", { status: 301 })).toEqualTypeOf<TypedResponse<"none", "found">>()
		expectTypeOf(res.raw(new Response("test"))).toEqualTypeOf<TypedResponse<string, string>>()
	})
})

describe("what a brand keeps apart", () => {
	// v0: b1c13f4ce0
	// v0: 91b32240c4
	// v0: 5d3f0dc9e1
	it("every TypedResponse is a Response; another content type or status key does not pass for it", () => {
		expectTypeOf(res.json("ok", {})).toExtend<Response>()
		expectTypeOf(res.json("ok", {})).not.toExtend<TypedResponse<"text/plain", "ok">>()
		expectTypeOf(res.text("ok", "hello")).not.toExtend<TypedResponse<"application/json", "ok">>()
		expectTypeOf(res.json("ok", {})).not.toExtend<TypedResponse<"application/json", "created">>()
		expectTypeOf(res.json("created", {})).not.toExtend<TypedResponse<"application/json", "ok">>()
	})

	// v0: 762541a430
	it("a handler returns a TypedResponse, never a plain Response", () => {
		honey<{}>()
			.get("/test")
			// @ts-expect-error a plain Response carries no brand
			.handler(() => new Response("raw"))
		honey<{}>()
			.get("/raw")
			.handler((ctx) => {
				const answer = ctx.res.raw(new Response("raw"))
				expectTypeOf(answer).toExtend<TypedResponse>()
				return answer
			})
	})
})
