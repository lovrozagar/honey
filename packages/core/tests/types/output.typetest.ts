/**
 * `.output()` as typed: ctx.res narrowed to the declared media types (a helper's status keys and
 * body typed by the status's schema, an undeclared helper removed, noContent/raw/redirect/stream
 * always there, sse only for a declared event stream), AllowedResMethods, `.output()` one-shot, and
 * InferRouteOutput carrying the declaration, the status-key shorthand as JSON, and the body a handler may return
 * in place of an answer. No `.output()` leaves ctx.res whole. Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import * as z from "zod"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import type { HoneyRes, StreamBody, TypedResponse } from "../../src/response/response.ts"
import { honey } from "../../src/routing/app.ts"
import { defineErrors } from "../../src/errors/errors.ts"
import type { HoneyMeta, InferRouteInput, InferRouteOutput, InferRoutes } from "../../src/routing/app-types.ts"
import type { RouteSelectorOf, SelectorOf, WithOutput } from "../../src/routing/codegen-types.ts"
import type { AllowedResMethods, ApplyOutput, DeclaredAnswer, OutputSchemas } from "../../src/routing/output-types.ts"

const withDb = createMiddleware((_ctx, next) => next({ db: "test-db" }))

describe("ctx.res under .output(): a body's type", () => {
	it("is its schema's input: what output validation accepts, not what it would parse to", () => {
		honey<{}>()
			.get("/sizes")
			.output({ "application/json": { ok: z.object({ size: z.string().transform((text) => text.length) }) } })
			.handler((ctx) => {
				// @ts-expect-error the schema's output (a number) is not what it accepts
				ctx.res.json("ok", { size: 3 })
				expectTypeOf(ctx.res.json).parameter(1).toEqualTypeOf<{ size: string } | StreamBody>()
				return ctx.res.json("ok", { size: "abc" })
			})
	})
})

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
	it("an undeclared helper is gone, raw and an undeclared redirect too; noContent and stream stay", () => {
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
				expectTypeOf(ctx.res).not.toHaveProperty("raw")
				expectTypeOf(ctx.res).not.toHaveProperty("redirect")
				expectTypeOf(ctx.res.stream).toBeFunction()
				return ctx.res.json("ok", { data: ["a"] })
			})
	})

	it("redirect takes only the status keys the output's redirect entry declares", () => {
		honey<{}>()
			.get("/old")
			.output({ ok: z.string(), redirect: { moved_permanently: true } })
			.handler((ctx) => {
				expectTypeOf(ctx.res.redirect).parameter(0).toEqualTypeOf<"moved_permanently">()
				// @ts-expect-error found is no declared redirect
				ctx.res.redirect("found", "/new")
				return ctx.res.redirect("moved_permanently", "/new")
			})
		honey<{}>()
			.get("/gone")
			.output({ redirect: { see_other: true } })
			// @ts-expect-error a redirect at a status the output does not declare
			.handler((ctx) => (ctx.res as unknown as HoneyRes).redirect("found", "/x"))
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

describe("the handler's return under .output(): only what the route declares", () => {
	const out = { "application/json": { ok: z.object({ id: z.string() }) } } as const

	it("refuses a raw Response, an undeclared media type and an undeclared status", () => {
		const app = honey<{}>()
		app
			.get("/a")
			.output(out)
			// @ts-expect-error a Response that is no declared answer
			.handler(() => new Response('{"id":"1"}'))
		app
			.get("/b")
			.output(out)
			// @ts-expect-error stream() answers application/octet-stream, which the route does not declare
			.handler((c) => c.res.stream(async () => {}))
		app
			.get("/c")
			.output(out)
			// @ts-expect-error a created answer: the route declares only ok
			.handler((c) => (c.res as unknown as HoneyRes).json("created", { id: "1" }))
		app.get("/d").handler((c) => c.res.raw(new Response("x")))
		expectTypeOf<DeclaredAnswer<typeof out>>().toEqualTypeOf<
			TypedResponse<"application/json", "ok"> | TypedResponse<"none", "no_content"> | { id: string }
		>()
	})

	it("takes a streamed body through a declared type's helper", () => {
		const body = () => new ReadableStream<Uint8Array>()
		const app = honey<{}>()
		app
			.get("/csv")
			.output({ "text/csv": { ok: true } })
			.handler((c) => c.res.csv("ok", body()))
		app
			.get("/bin")
			.output({ "application/octet-stream": { ok: true } })
			.handler((c) => c.res.binary("ok", body()))
		app
			.get("/png")
			.output({ "image/png": { ok: true } })
			.handler((c) => c.res.binary("ok", body(), { contentType: "image/png" }))
		app
			.get("/stream")
			.output({ "application/octet-stream": { ok: true } })
			.handler((c) => c.res.stream(async () => {}))
		expectTypeOf<Parameters<HoneyRes["csv"]>[1]>().toEqualTypeOf<string | ReadableStream<Uint8Array>>()
	})
})

describe(".output() shorthand and a returned body", () => {
	const tables = z.object({ id: z.string() }).array()
	const location = z.object({ location: z.string() })

	it("status keys alone declare JSON: the shorthand is the application/json form", () => {
		const app = honey<{}>()
			.get("/t")
			.output({ headers: { created: location }, ok: tables })
			.handler((c) => c.res.json("ok", [{ id: "1" }]))
		expectTypeOf<InferRouteOutput<typeof app, "/t", "get">>().toEqualTypeOf<{
			readonly "application/json": { readonly ok: typeof tables }
			readonly headers: { readonly created: typeof location }
		}>()
		const route = honey<{}>().get("/u")
		// @ts-expect-error a status key beside a media type: the two forms do not mix
		route.output({ "text/csv": { ok: true }, ok: tables })
		// @ts-expect-error a shorthand key that names no status
		route.output({ okay: tables })
	})
})

describe("the handler's return under .output(): the body itself", () => {
	const tables = z.object({ id: z.string() }).array()

	it("one 2xx status under one media type: the handler may return the body itself", () => {
		expectTypeOf<DeclaredAnswer<{ readonly "text/csv": { readonly ok: true } }>>().toEqualTypeOf<
			TypedResponse<"text/csv", "ok"> | TypedResponse<"none", "no_content"> | string | ReadableStream<Uint8Array>
		>()
		const app = honey<{}>()
		app
			.get("/json")
			.output({ not_found: true, ok: tables })
			.handler(async () => [{ id: "1" }])
		app
			.get("/csv")
			.output({ "text/csv": { ok: true } })
			.handler(() => "id\n1")
		app
			.get("/png")
			.output({ "image/png": { ok: true } })
			.handler(() => new Uint8Array([1]))
		app
			.get("/answer")
			.output({ created: tables })
			.handler((c) => c.res.json("created", []))
		app
			.get("/bad")
			.output({ ok: tables })
			// @ts-expect-error a body of another shape than the schema's
			.handler(() => [{ id: 1 }])
	})
})

describe("the handler's return under .output(): no body where honey cannot pick the answer", () => {
	const tables = z.object({ id: z.string() }).array()

	it("refuses the body for two statuses, two media types, declared headers or an event stream", () => {
		expectTypeOf<
			DeclaredAnswer<{ readonly "application/json": { readonly created: typeof tables; readonly ok: typeof tables } }>
		>().toEqualTypeOf<TypedResponse<"application/json", "created" | "ok"> | TypedResponse<"none", "no_content">>()
		const app = honey<{}>()
		app
			.get("/a")
			.output({ created: tables, ok: tables })
			// @ts-expect-error two 2xx statuses: which one is ambiguous
			.handler(() => [])
		app
			.get("/b")
			.output({ "application/json": { ok: tables }, "text/csv": { ok: true } })
			// @ts-expect-error two media types
			.handler(() => [])
		app
			.get("/c")
			.output({ headers: { ok: z.object({ etag: z.string() }) }, ok: tables })
			// @ts-expect-error the status declares a header the body cannot carry
			.handler(() => [])
		app
			.get("/d")
			.output({ "text/event-stream": { ok: true } })
			// @ts-expect-error an event stream answers through sse
			.handler(() => "data: x\n\n")
		app
			.get("/e")
			.output({ no_content: true })
			// @ts-expect-error no content carries no body
			.handler(() => "x")
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
		expectTypeOf(
			route.output({
				"application/json": { ok: z.string() },
				headers: { ok: z.object({}) },
				redirect: { found: true },
			}),
		).toHaveProperty("handler")
		// @ts-expect-error a status key that names no status
		route.output({ "application/json": { okay: z.string() } })
		// @ts-expect-error a header status that names no status
		route.output({ "application/json": { ok: z.string() }, headers: { okay: z.object({}) } })
		// @ts-expect-error a redirect that names no status
		route.output({ redirect: { foundd: true } })
		// @ts-expect-error an outer key that is no media type, headers or redirect
		route.output({ orders: { ok: z.string() } })
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

describe("the codegen surface (O6): WithOutput, HoneyCodegen and route selectors", () => {
	it("narrows invalidate to the generated selectors, and keeps any string before codegen ran", () => {
		expectTypeOf<SelectorOf<{ routeSelector: "GET /a" | "POST /b" }>>().toEqualTypeOf<"GET /a" | "POST /b">()
		expectTypeOf<SelectorOf<{}>>().toEqualTypeOf<string>()
		expectTypeOf<RouteSelectorOf>().toEqualTypeOf<string>()
		expectTypeOf<NonNullable<HoneyMeta["invalidate"]>>().toEqualTypeOf<readonly string[]>()
		honey<{}>()
			.get("/a")
			.meta({ invalidate: ["GET /a", "GET /anything"] })
			.handler((c) => c.res.json("ok", {}))
	})

	it("types WithOutput as the ctx a route with that output declaration gets", () => {
		const id = z.object({ id: z.string() })
		type Out = { "application/json": { ok: typeof id } }
		expectTypeOf<WithOutput<{ a: 1 }, Out>>().toEqualTypeOf<ApplyOutput<{ a: 1 }, Out>>()
	})
})

describe("ctx.res.forward(): only under .output(), typed as the declared answers", () => {
	it("answers the route's declared media types at their status keys, and is gone without .output()", () => {
		honey<{}>()
			.get("/file")
			.output({ "application/octet-stream": { ok: true, partial_content: true }, "text/csv": { ok: z.string() } })
			.handler((ctx) => {
				expectTypeOf(ctx.res.forward(new Response())).toEqualTypeOf<
					| TypedResponse<"application/octet-stream", "ok" | "partial_content">
					| TypedResponse<"text/csv", "ok">
					| TypedResponse<"none", "no_content">
				>()
				return ctx.res.forward(new Response())
			})
		honey<{}>()
			.get("/open")
			.handler((ctx) => {
				// @ts-expect-error forward is for a route that declares what it answers; raw is the open form
				ctx.res.forward(new Response())
				return ctx.res.raw(new Response())
			})
	})

	it("keeps them on a ctx typed from plain body types, as a generated per-route ctx is", () => {
		type Generated = ApplyOutput<{}, { "application/json": { ok: { results: string[] } } }>
		expectTypeOf<ReturnType<Generated["res"]["forward"]>>().toEqualTypeOf<
			TypedResponse<"application/json", "ok"> | TypedResponse<"none", "no_content">
		>()
	})

	it("counts a 304 its redirect entry declares among the bodiless answers, which a handler may return", () => {
		honey<{}>()
			.get("/export.csv")
			.output({ "text/csv": { ok: z.string() }, redirect: { not_modified: true } })
			.handler((ctx) => ctx.res.forward(new Response(null, { status: 304 })))
		type Revalidated = ApplyOutput<{}, { "text/csv": { ok: string }; redirect: { not_modified: true } }>
		expectTypeOf<ReturnType<Revalidated["res"]["forward"]>>().toEqualTypeOf<
			TypedResponse<"text/csv", "ok"> | TypedResponse<"none", "no_content" | "not_modified">
		>()
	})
})

describe("an encoded stream body: sse() and json() take a ReadableStream", () => {
	it("passes it through under the declared event stream or JSON type", () => {
		const body = new ReadableStream<Uint8Array>()
		honey<{}>()
			.get("/events")
			.output({ "text/event-stream": { ok: z.string() } })
			.handler((ctx) => ctx.res.sse(body))
		honey<{}>()
			.get("/export")
			.output({ ok: z.object({ id: z.string() }) })
			.handler((ctx) => {
				expectTypeOf(ctx.res.json).parameter(1).toEqualTypeOf<{ id: string } | StreamBody>()
				return ctx.res.json("ok", body)
			})
	})
})
