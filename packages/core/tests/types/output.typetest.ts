/**
 * `.output()` as typed: ctx.res narrowed to the declared media types (a helper's status keys and
 * body typed by the status's schema, an undeclared helper removed, noContent/raw/redirect/stream
 * always there, sse only for a declared event stream), AllowedResMethods, `.output()` one-shot, and
 * InferRouteOutput carrying the declaration. No `.output()` leaves ctx.res whole. Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import * as z from "zod"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import type { TypedResponse } from "../../src/response/response.ts"
import { honey } from "../../src/routing/app.ts"
import { defineErrors } from "../../src/errors/errors.ts"
import type { InferRouteInput, InferRouteOutput, InferRoutes } from "../../src/routing/app-types.ts"
import type { AllowedResMethods, OutputSchemas } from "../../src/routing/output-types.ts"

const withDb = createMiddleware((_ctx, next) => next({ db: "test-db" }))

describe("ctx.res under .output(): a declared helper is narrowed", () => {
	// v0: 4490cead2b
	// v0: 5e521e3a58
	// v0: 37dc43b1d5
	// v0: ca4577f293
	// v0: f915401cb1
	it("json takes only declared status keys, each with its schema's body, and answers their brand", () => {
		honey<{}>()
			.get("/users/:id")
			.output({
				"application/json": {
					created: z.object({ id: z.string() }),
					not_found: z.object({ error: z.string() }),
					ok: z.object({ items: z.array(z.string()) }),
				},
			})
			.handler((ctx) => {
				expectTypeOf(ctx.res.json("created", { id: "1" })).toEqualTypeOf<TypedResponse<"application/json", "created">>()
				expectTypeOf(ctx.res.json("not_found", { error: "gone" })).toEqualTypeOf<
					TypedResponse<"application/json", "not_found">
				>()
				// @ts-expect-error a status key the output does not declare
				ctx.res.json("conflict", {})
				// @ts-expect-error a body of another status's shape
				ctx.res.json("ok", { id: "wrong" })
				return ctx.res.json("ok", { items: ["a"] })
			})
	})

	// v0: d00e5d847c
	// v0: 551de2f1fc
	// v0: 98a9cfebc9
	// v0: 31810880e8
	it("text, xml and csv are narrowed to their declared status keys the same way", () => {
		honey<{}>()
			.get("/msg")
			.output({
				"application/xml": { ok: z.string() },
				"text/csv": { ok: z.string() },
				"text/plain": { ok: z.string() },
			})
			.handler((ctx) => {
				expectTypeOf(ctx.res.xml("ok", "<root/>")).toEqualTypeOf<TypedResponse<"application/xml", "ok">>()
				expectTypeOf(ctx.res.csv("ok", "a,b")).toEqualTypeOf<TypedResponse<"text/csv", "ok">>()
				// @ts-expect-error a status key text/plain does not declare
				ctx.res.text("created", "x")
				return ctx.res.text("ok", "hello")
			})
	})
})

describe("ctx.res under .output(): what stays and what goes", () => {
	// v0: 3548e1e461
	// v0: 5e1b76c5c4
	// v0: 0da51d81f1
	// v0: 864b2b279f
	// v0: 51f229a974
	it("an undeclared helper is gone; noContent, raw, redirect and stream always stay", () => {
		honey<{}>()
			.get("/report")
			.output({ "application/json": { ok: z.object({ data: z.array(z.string()) }) }, "text/html": { ok: z.string() } })
			.handler((ctx) => {
				expectTypeOf(ctx.res.json).toBeFunction()
				expectTypeOf(ctx.res.html).toBeFunction()
				expectTypeOf(ctx.res).not.toHaveProperty("text")
				expectTypeOf(ctx.res).not.toHaveProperty("csv")
				expectTypeOf(ctx.res).not.toHaveProperty("xml")
				expectTypeOf(ctx.res).not.toHaveProperty("sse")
				expectTypeOf(ctx.res).not.toHaveProperty("generate")
				expectTypeOf(ctx.res.noContent).toBeFunction()
				expectTypeOf(ctx.res.raw).toBeFunction()
				expectTypeOf(ctx.res.redirect).toBeFunction()
				expectTypeOf(ctx.res.stream).toBeFunction()
				return ctx.res.json("ok", { data: ["a"] })
			})
	})

	// v0: 5e40ffd882
	it("sse is there only when text/event-stream is declared", () => {
		honey<{}>()
			.get("/events")
			.output({ "text/event-stream": { ok: z.object({ data: z.string() }) } })
			.handler((ctx) => {
				expectTypeOf(ctx.res.sse).toBeFunction()
				expectTypeOf(ctx.res).not.toHaveProperty("json")
				return ctx.res.sse(async () => {})
			})
	})
})

describe("ctx.res without .output()", () => {
	// v0: b66220dc50
	// v0: 6cbbf83e2a
	it("without .output() every helper is there, unconstrained", () => {
		honey<{}>()
			.get("/any")
			.handler((ctx) => {
				ctx.res.json("conflict", { anything: true })
				ctx.res.text("ok", "")
				ctx.res.html("ok", "")
				ctx.res.xml("ok", "")
				ctx.res.csv("ok", "")
				expectTypeOf(ctx.res.sse).toBeFunction()
				expectTypeOf(ctx.res.generate).toBeFunction()
				expectTypeOf(ctx.res.binary("accepted", new Uint8Array(0))).toEqualTypeOf<
					TypedResponse<"application/octet-stream", "accepted">
				>()
				expectTypeOf(ctx.res.binary("ok", new Uint8Array(0), { contentType: "image/gif" })).toEqualTypeOf<
					TypedResponse<"image/gif", "ok">
				>()
				return ctx.res.json("ok", {})
			})
	})
})

describe("ctx.res.binary under .output()", () => {
	// v0: 3fd4c69ed9
	// v0: ab93a3efc3
	// v0: c3adbd0a15
	it("takes octet-stream's declared status keys and answers their brand; only binary and the universals stay", () => {
		honey<{}>()
			.get("/file")
			.output({ "application/octet-stream": { accepted: true, ok: true } })
			.handler((ctx) => {
				expectTypeOf(ctx.res.binary("accepted", new Uint8Array(0))).toEqualTypeOf<
					TypedResponse<"application/octet-stream", "accepted">
				>()
				// @ts-expect-error a status key octet-stream does not declare
				ctx.res.binary("created", new Uint8Array(0))
				expectTypeOf(ctx.res).not.toHaveProperty("json")
				expectTypeOf(ctx.res).not.toHaveProperty("text")
				expectTypeOf(ctx.res.noContent).toBeFunction()
				return ctx.res.binary("ok", new ArrayBuffer(0))
			})
	})

	// v0: fa32164ff3
	it("sits beside the other declared helpers", () => {
		honey<{}>()
			.get("/export")
			.output({
				"application/json": { ok: z.object({ id: z.string() }) },
				"application/octet-stream": { created: true },
				"text/csv": { accepted: z.string() },
			})
			.handler((ctx) => {
				expectTypeOf(ctx.res.json).toBeFunction()
				expectTypeOf(ctx.res.csv).toBeFunction()
				expectTypeOf(ctx.res.binary("created", new Uint8Array(0))).toEqualTypeOf<
					TypedResponse<"application/octet-stream", "created">
				>()
				return ctx.res.json("ok", { id: "1" })
			})
	})

	it("an open media type is answered through binary, its content type one of the declared ones", () => {
		honey<{}>()
			.get("/image")
			.output({ "image/gif": { ok: true }, "image/png": { created: true } })
			.handler((ctx) => {
				expectTypeOf(ctx.res.binary("created", new Uint8Array(0), { contentType: "image/png" })).toEqualTypeOf<
					TypedResponse<"image/png", "created">
				>()
				// @ts-expect-error no octet-stream is declared: the content type is required
				ctx.res.binary("ok", new Uint8Array(0))
				// @ts-expect-error a media type the output does not declare
				ctx.res.binary("ok", new Uint8Array(0), { contentType: "image/jpeg" })
				// @ts-expect-error a status key image/gif does not declare
				ctx.res.binary("created", new Uint8Array(0), { contentType: "image/gif" })
				return ctx.res.binary("ok", new Uint8Array(0), { contentType: "image/gif" })
			})
	})
})

describe("declared response headers", () => {
	it("a status declaring headers takes them in its options, typed; another status keeps its options optional", () => {
		honey<{}>()
			.post("/users")
			.output({
				"application/json": { created: z.object({ id: z.string() }), ok: z.object({ id: z.string() }) },
				headers: { created: z.object({ location: z.string() }) },
			})
			.handler((ctx) => {
				// @ts-expect-error created declares a location header
				ctx.res.json("created", { id: "1" })
				// @ts-expect-error the declared header is missing
				ctx.res.json("created", { id: "1" }, { headers: { etag: "x" } })
				expectTypeOf(ctx.res.json("ok", { id: "1" })).toEqualTypeOf<TypedResponse<"application/json", "ok">>()
				return ctx.res.json("created", { id: "1" }, { headers: { location: "/users/1", "x-extra": "1" } })
			})
	})
})

describe("AllowedResMethods", () => {
	// v0: ced2d39aba
	// v0: 775d5ac0c7
	// v0: ac79fc4742
	// v0: 4e57dd4126
	it("is the helpers a declaration allows", () => {
		expectTypeOf<AllowedResMethods<{ "application/json": unknown }>>().toEqualTypeOf<"json">()
		expectTypeOf<AllowedResMethods<{ "application/json": unknown; "text/plain": unknown }>>().toEqualTypeOf<
			"json" | "text"
		>()
		expectTypeOf<AllowedResMethods<{ "text/event-stream": unknown }>>().toEqualTypeOf<"sse">()
		expectTypeOf<AllowedResMethods<{ "application/octet-stream": unknown }>>().toEqualTypeOf<"binary">()
		expectTypeOf<AllowedResMethods<{ "application/json": unknown; "image/gif": unknown }>>().toEqualTypeOf<
			"binary" | "json"
		>()
		expectTypeOf<
			AllowedResMethods<{
				"application/json": unknown
				"application/octet-stream": unknown
				"application/xml": unknown
				"text/csv": unknown
				"text/event-stream": unknown
				"text/html": unknown
				"text/plain": unknown
			}>
		>().toEqualTypeOf<"binary" | "csv" | "html" | "json" | "sse" | "text" | "xml">()
	})
})

describe("OutputSchemas: what .output() takes", () => {
	// v0: e57fdba151
	// v0: a6c79b6852
	// v0: 8659650f52
	it("a media type's status keys, each with a schema; an event stream; several media types at once", () => {
		expectTypeOf({ "application/json": { ok: z.object({ id: z.string() }) } }).toExtend<OutputSchemas>()
		expectTypeOf({ "text/event-stream": { ok: z.object({ data: z.string() }) } }).toExtend<OutputSchemas>()
		expectTypeOf({
			"application/json": { ok: z.object({ id: z.string() }) },
			"text/plain": { ok: z.string() },
		}).toExtend<OutputSchemas>()
	})

	it("refuses a key that names no status, under a media type, headers or redirect", () => {
		const route = honey<{}>().get("/t")
		expectTypeOf(route.output).toBeCallableWith({
			"application/json": { ok: z.string() },
			headers: { ok: z.object({}) },
			redirect: { found: true },
		})
		// @ts-expect-error a status key that names no status
		route.output({ "application/json": { okay: z.string() } })
		// @ts-expect-error a header status that names no status
		route.output({ "application/json": { ok: z.string() }, headers: { okay: z.object({}) } })
		// @ts-expect-error a redirect that names no status
		route.output({ redirect: { foundd: true } })
	})
})

describe("errorsByStatus: a route's declared errors by status code", () => {
	const errs = defineErrors({
		email_taken: "conflict",
		item_not_found: { schema: z.object({ reason: z.string(), suggestions: z.array(z.string()) }), status: "not_found" },
		rate_limited: { schema: z.object({ retryAfter: z.number() }), status: "too_many_requests" },
	})
	const app = honey<{}>()
		.errorFactory(errs)
		.get("/items/:id")
		.errors("item_not_found")
		.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))
		.post("/register")
		.errors("email_taken", "rate_limited")
		.handler((ctx) => ctx.res.json("created", {}))
	type Routes = InferRoutes<typeof app>

	// v0: 2233bc7f78
	it("defineErrors answers a factory per declared key, and none for another", () => {
		expectTypeOf(errs.email_taken).toBeFunction()
		expectTypeOf(errs.item_not_found).toBeFunction()
		expectTypeOf(errs.rate_limited).toBeFunction()
		expectTypeOf(errs).not.toHaveProperty("org_limit")
	})

	// v0: de5b6ae4ed
	// v0: c8954a3f00
	// v0: f37a0b0523
	// v0: 028e12d305
	it("keys each declared error by its status code: a schema error by its body, a standard one as null", () => {
		expectTypeOf<Routes["/items/:id"]["get"]["errorsByStatus"]>().toEqualTypeOf<{
			404: { reason: string; suggestions: string[] }
		}>()
		expectTypeOf<Routes["/register"]["post"]["errorsByStatus"]>().toEqualTypeOf<{
			409: null
			429: { retryAfter: number }
		}>()
	})
})

describe(".output() on the builder and in the route map", () => {
	// v0: fbb899bd09
	// v0: fd16ae98c9
	it("is one-shot: gone once used, the other one-shots still there", () => {
		const route = honey<{}>()
			.get("/t")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
		expectTypeOf(route).not.toHaveProperty("output")
		expectTypeOf(route).toHaveProperty("input")
		expectTypeOf(route).toHaveProperty("meta")
		expectTypeOf(route).toHaveProperty("errors")
		expectTypeOf(route).toHaveProperty("handler")
	})

	// v0: de48f80ebe
	// v0: 47f2b00718
	it("sits beside .input() and middleware additions", () => {
		honey<{}>()
			.use(withDb)
			.post("/t")
			.input({ json: z.object({ name: z.string() }) })
			.output({ "application/json": { created: z.object({ id: z.string() }) } })
			.handler((ctx) => {
				expectTypeOf(ctx.input.json.name).toEqualTypeOf<string>()
				expectTypeOf(ctx.db).toEqualTypeOf<string>()
				return ctx.res.json("created", { id: "abc" })
			})
	})

	// v0: 4c0624e4bb
	// v0: b666bec732
	// v0: 88228271d0
	it("InferRouteOutput is the declaration and InferRouteInput the input, under a basePath too", () => {
		const users = z.object({ id: z.string() }).array()
		const app = honey<{}>()
			.basePath("/api")
			.get("/users")
			.output({ "application/json": { ok: users } })
			.handler((ctx) => ctx.res.json("ok", [{ id: "1" }]))
			.post("/users")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", { id: "1" }))
		expectTypeOf<InferRouteOutput<typeof app, "/api/users", "get">>().toEqualTypeOf<{
			readonly "application/json": { readonly ok: typeof users }
		}>()
		expectTypeOf<InferRouteInput<typeof app, "/api/users", "post">>().toEqualTypeOf<{
			readonly json: { name: string }
		}>()
	})
})
