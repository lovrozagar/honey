/**
 * The app-typed client (`createClient<typeof app>`, gen's runtime template) as typed over a real
 * app's $routes: the paths each verb takes, the input each call takes (sources, params, a
 * readableStream() entry as its plain schema), what it resolves per media type and status, SSE as
 * an async iterable, result mode against throw mode, and the declared errors. Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import * as z from "zod"
import type { createClient } from "../../../gen/src/runtime/ts/app.ts"
import type { ClientResult, ErrorsFor, OutputDefFor } from "../../../gen/src/runtime/ts/app-types.ts"
import type { SSEEvent } from "../../../gen/src/runtime/ts/sse.ts"
import { defineErrors } from "../../src/errors/errors.ts"
import { readableStream } from "../../src/input/input.ts"
import { honey } from "../../src/routing/app.ts"
import type { InferRoutes } from "../../src/routing/app-types.ts"

const user = z.object({ email: z.string(), id: z.string(), name: z.string() })
const row = z.object({ id: z.string(), name: z.string() })
const notFound = defineErrors({ not_found: "not_found" })

/** v0's client fixture: each input source, plain and readableStream(), each output media type, each verb. */
const app = honey<{}>()
	.get("/health")
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.get("/users")
	.input({ search: z.object({ limit: z.string().optional(), page: z.string().optional() }) })
	.output({ "application/json": { ok: row.array() } })
	.handler((ctx) => ctx.res.json("ok", []))
	.get("/users/:id")
	.output({ "application/json": { ok: row } })
	.errors(notFound, "not_found")
	.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id, name: "test" }))
	.post("/users")
	.input({ json: z.object({ name: z.string() }) })
	.output({ "application/json": { created: z.object({ id: z.string() }) } })
	.handler((ctx) => ctx.res.json("created", { id: "1" }))
	.post("/input/json")
	.input({ json: z.object({ email: z.string(), name: z.string() }) })
	.output({ "application/json": { created: user } })
	.handler((ctx) => ctx.res.json("created", { ...ctx.input.json, id: "1" }))
	.post("/input/form")
	.input({ form: z.object({ password: z.string(), username: z.string() }) })
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.get("/input/search")
	.input({ search: z.object({ limit: z.number(), page: z.number() }) })
	.output({
		"application/json": {
			ok: z.object({
				items: z.array(z.object({ id: z.string() })),
				nextCursor: z.string().nullable(),
				total: z.number(),
			}),
		},
	})
	.handler((ctx) => ctx.res.json("ok", { items: [], nextCursor: null, total: 0 }))
	.get("/input/headers")
	.input({ headers: z.object({ "x-api-key": z.string(), "x-tenant": z.string() }) })
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.get("/input/cookies")
	.input({ cookies: z.object({ session: z.string() }) })
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.get("/input/params/:userId")
	.handler((ctx) => ctx.res.text("ok", ctx.params.userId))
	.put("/input/combined/:id")
	.input({
		headers: z.object({ "x-idempotency-key": z.string() }),
		json: z.object({ name: z.string() }),
		search: z.object({ dryRun: z.boolean().optional() }),
	})
	.output({ "application/json": { ok: z.object({ updated: z.boolean() }) } })
	.handler((ctx) => ctx.res.json("ok", { updated: true }))
	.get("/input/none")
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.post("/input/rs-json")
	.input({ json: readableStream(z.object({ data: z.string(), size: z.number() })) })
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.post("/input/rs-form")
	.input({ form: readableStream(z.object({ field: z.string() })) })
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.post("/input/rs-json-mixed")
	.input({
		headers: z.object({ "x-trace": z.string() }),
		json: readableStream(z.object({ payload: z.string() })),
		search: z.object({ async: z.boolean().optional() }),
	})
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.get("/input/rs-search")
	.input({ search: readableStream(z.object({ filter: z.string() })) })
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.get("/input/rs-headers")
	.input({ headers: readableStream(z.object({ "x-token": z.string() })) })
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.get("/input/rs-cookies")
	.input({ cookies: readableStream(z.object({ session: z.string() })) })
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.get("/output/json")
	.output({ "application/json": { ok: user } })
	.handler((ctx) => ctx.res.json("ok", { email: "a@b.c", id: "1", name: "a" }))
	.post("/output/json-multi")
	.output({ "application/json": { conflict: z.object({ detail: z.string() }), created: row } })
	.handler((ctx) => ctx.res.json("created", { id: "1", name: "a" }))
	.post("/jobs")
	.output({
		"application/json": {
			accepted: z.object({ eta: z.number(), jobId: z.string() }),
			bad_request: z.object({ reason: z.string() }),
			ok: z.object({ result: z.string() }),
		},
	})
	.handler((ctx) => ctx.res.json("ok", { result: "done" }))
	.get("/output/text")
	.output({ "text/plain": { ok: z.string() } })
	.handler((ctx) => ctx.res.text("ok", "hello"))
	.get("/output/html")
	.output({ "text/html": { ok: z.string() } })
	.handler((ctx) => ctx.res.html("ok", "<h1>hi</h1>"))
	.get("/output/csv")
	.output({ "text/csv": { ok: z.string() } })
	.handler((ctx) => ctx.res.csv("ok", "a,b"))
	.get("/output/xml")
	.output({ "application/xml": { ok: z.string() } })
	.handler((ctx) => ctx.res.xml("ok", "<root/>"))
	.get("/output/binary")
	.output({ "application/octet-stream": { ok: true } })
	.handler((ctx) => ctx.res.binary("ok", new Uint8Array([0])))
	.get("/output/sse")
	.output({ "text/event-stream": { ok: z.string() } })
	.handler((ctx) => ctx.res.sse(async () => {}))
	.get("/output/untyped")
	.handler((ctx) => ctx.res.json("ok", { anything: true }))
	.get("/methods/resource")
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.post("/methods/resource")
	.input({ json: z.object({ name: z.string() }) })
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.put("/methods/resource/:id")
	.input({ json: z.object({ name: z.string() }) })
	.handler((ctx) => ctx.res.text("ok", ctx.params.id))
	.patch("/methods/resource/:id")
	.input({ json: z.object({ name: z.string().optional() }) })
	.handler((ctx) => ctx.res.text("ok", ctx.params.id))
	.delete("/methods/resource/:id")
	.handler((ctx) => ctx.res.noContent())

/** The fixture twice, the second under /v1: a 70-route map. */
const big = app.route(honey<{}>().basePath("/v1").route(app))

/** A route under a basePath. */
const prefixed = honey<{}>()
	.basePath("/api")
	.get("/users")
	.output({ "application/json": { ok: z.object({ id: z.string() }).array() } })
	.handler((ctx) => ctx.res.json("ok", [{ id: "1" }]))

/** A route declaring a custom-schema error from the app's factory. */
const erring = honey<{}>()
	.errorFactory(
		defineErrors({
			item_not_found: {
				schema: z.object({ reason: z.string(), suggestions: z.array(z.string()) }),
				status: "not_found",
			},
		}),
	)
	.get("/items/:id")
	.output({ "application/json": { ok: z.object({ name: z.string() }) } })
	.errors("item_not_found")
	.handler((ctx) => ctx.res.json("ok", { name: "test" }))

type Verb = "delete" | "get" | "patch" | "post" | "put"
/** The result-mode (default) client for an app. */
type Api<T = typeof app> = ReturnType<typeof createClient<T>>
/** The paths `api[verb]` takes. */
type PathsOf<V extends Verb, T = typeof app> = Parameters<Api<T>[V]>[0]

declare const api: Api
declare const deep: Api<typeof big>
declare const thrower: ReturnType<typeof createClient<typeof app, true>>
declare const prefixedApi: ReturnType<typeof createClient<typeof prefixed, true>>
declare const erringApi: Api<typeof erring>

/** The input `api.get(path, input)` takes for one path. */
type GetIn<P extends PathsOf<"get">> = NonNullable<Parameters<typeof api.get<P>>[1]>
/** The input `api.post(path, input)` takes for one path. */
type PostIn<P extends PathsOf<"post">> = NonNullable<Parameters<typeof api.post<P>>[1]>
/** The input `api.put(path, input)` takes for one path. */
type PutIn<P extends PathsOf<"put">> = NonNullable<Parameters<typeof api.put<P>>[1]>

describe("the paths each verb takes", () => {
	// v0: aed81d4876
	// v0: 1898624fa2
	// v0: fa5e65a2b9
	// v0: a46b3c94c5
	// v0: a69e679007
	// v0: 3f7d1bec76
	// v0: 41b1f23fb1
	// v0: 82d4dbe54b
	// v0: a0621e13ad
	it("each verb takes exactly the paths registered for it, param and SSE paths included", () => {
		expectTypeOf<PathsOf<"get">>().toEqualTypeOf<
			| "/health"
			| "/input/cookies"
			| "/input/headers"
			| "/input/none"
			| "/input/params/:userId"
			| "/input/rs-cookies"
			| "/input/rs-headers"
			| "/input/rs-search"
			| "/input/search"
			| "/methods/resource"
			| "/output/binary"
			| "/output/csv"
			| "/output/html"
			| "/output/json"
			| "/output/sse"
			| "/output/text"
			| "/output/untyped"
			| "/output/xml"
			| "/users"
			| "/users/:id"
		>()
		expectTypeOf<PathsOf<"post">>().toEqualTypeOf<
			| "/input/form"
			| "/input/json"
			| "/input/rs-form"
			| "/input/rs-json"
			| "/input/rs-json-mixed"
			| "/jobs"
			| "/methods/resource"
			| "/output/json-multi"
			| "/users"
		>()
		expectTypeOf<PathsOf<"put">>().toEqualTypeOf<"/input/combined/:id" | "/methods/resource/:id">()
		expectTypeOf<PathsOf<"patch">>().toEqualTypeOf<"/methods/resource/:id">()
		expectTypeOf<PathsOf<"delete">>().toEqualTypeOf<"/methods/resource/:id">()
		// @ts-expect-error /input/json is POST only
		void api.get("/input/json")
	})
})

describe("the paths across merged, prefixed and deep apps", () => {
	// v0: 6d1905a168
	// v0: 43b6c37acc
	it("merged sub-apps keep each path under its own verbs, and a basePath route is called by its prefixed path", () => {
		const items = honey<{}>()
			.get("/items")
			.handler((ctx) => ctx.res.json("ok", []))
			.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", { id: "1" }))
		const tags = honey<{}>()
			.get("/tags")
			.handler((ctx) => ctx.res.json("ok", []))
		const combined = honey<{}>().route(items).route(tags)
		expectTypeOf<PathsOf<"get", typeof combined>>().toEqualTypeOf<"/items" | "/tags">()
		expectTypeOf<PathsOf<"post", typeof combined>>().toEqualTypeOf<"/items">()
		expectTypeOf<PathsOf<"get", typeof prefixed>>().toEqualTypeOf<"/api/users">()
		expectTypeOf(prefixedApi.get("/api/users")).toEqualTypeOf<Promise<{ id: string }[]>>()
	})

	// v0: 5b1194dad8
	it("a 70-route map resolves its GET and POST paths, the last ones included, with no depth error", () => {
		expectTypeOf<"/health" | "/v1/methods/resource" | "/v1/users/:id">().toExtend<PathsOf<"get", typeof big>>()
		expectTypeOf<"/users" | "/v1/input/json" | "/v1/methods/resource">().toExtend<PathsOf<"post", typeof big>>()
	})
})

describe("the input each call takes", () => {
	// v0: d78810cfbb
	// v0: bb495ddcd1
	// v0: 6bc77576da
	// v0: 5a150a2954
	// v0: 9a4e825c97
	// v0: d6d2010d7a
	// v0: 4f7846376d
	// v0: e838c74666
	it("types each source from its schema: json, form, search, hyphenated headers and cookies", () => {
		expectTypeOf<PostIn<"/input/json">>().toExtend<{ json: { email: string; name: string } }>()
		expectTypeOf<PostIn<"/input/form">>().toExtend<{ form: { password: string; username: string } }>()
		expectTypeOf<GetIn<"/input/search">>().toExtend<{ search: { limit: number; page: number } }>()
		expectTypeOf<GetIn<"/input/headers">>().toExtend<{ headers: { "x-api-key": string; "x-tenant": string } }>()
		expectTypeOf<GetIn<"/input/cookies">>().toExtend<{ cookies: { session: string } }>()
		expectTypeOf<GetIn<"/users">>().toEqualTypeOf<{ readonly search: { limit?: string; page?: string } }>()
		expectTypeOf<PostIn<"/users">>().toEqualTypeOf<{ readonly json: { name: string } }>()
	})

	// v0: 5085450eb1
	// v0: 31ac4895d2
	// v0: 3c2f838111
	// v0: c25f96fb3c
	it("a route without input and params takes {}, and a static path never takes params", () => {
		expectTypeOf<keyof GetIn<"/health">>().toBeNever()
		expectTypeOf<keyof GetIn<"/input/none">>().toBeNever()
		expectTypeOf<"params" extends keyof PostIn<"/input/json"> ? true : false>().toEqualTypeOf<false>()
	})
})

describe("the input of readableStream(), combined and deep routes", () => {
	// v0: 5fc98a6dfd
	// v0: bce2673b8f
	// v0: 9f48f0e3e4
	// v0: 124924980a
	// v0: 57dfdbb604
	// v0: 2e068c2591
	it("types a readableStream()-wrapped entry as its plain schema, beside plain ones", () => {
		expectTypeOf<PostIn<"/input/rs-json">>().toExtend<{ json: { data: string; size: number } }>()
		expectTypeOf<PostIn<"/input/rs-form">>().toExtend<{ form: { field: string } }>()
		expectTypeOf<PostIn<"/input/rs-json-mixed">>().toExtend<{
			headers: { "x-trace": string }
			json: { payload: string }
			search: { async?: boolean }
		}>()
		expectTypeOf<GetIn<"/input/rs-search">>().toExtend<{ search: { filter: string } }>()
		expectTypeOf<GetIn<"/input/rs-headers">>().toExtend<{ headers: { "x-token": string } }>()
		expectTypeOf<GetIn<"/input/rs-cookies">>().toExtend<{ cookies: { session: string } }>()
	})

	// v0: 16f2b537be
	// v0: 5ded84967b
	// v0: 997fa180bb
	it("a :param path requires params typed from its pattern", () => {
		expectTypeOf<GetIn<"/input/params/:userId">>().toEqualTypeOf<{ params: { userId: string } }>()
		expectTypeOf<GetIn<"/users/:id">>().toEqualTypeOf<{ params: { id: string } }>()
		expectTypeOf<PutIn<"/methods/resource/:id">>().toExtend<{ params: { id: string } }>()
		// @ts-expect-error a param path takes its params
		void api.get("/users/:id")
	})

	// v0: 25645474d7
	// v0: b4d9a49daa
	// v0: 1cb3cde05a
	it("one route takes json, search, headers and params together, and resolves its typed output", () => {
		expectTypeOf<PutIn<"/input/combined/:id">>().toExtend<{
			headers: { "x-idempotency-key": string }
			json: { name: string }
			params: { id: string }
			search: { dryRun?: boolean }
		}>()
		const call = thrower.put("/input/combined/:id", {
			headers: { "x-idempotency-key": "k" },
			json: { name: "a" },
			params: { id: "1" },
			search: {},
		})
		expectTypeOf(call).toEqualTypeOf<Promise<{ updated: boolean }>>()
	})

	// v0: c8b0d60f7b
	it("stays exact on the last routes of a 70-route map", () => {
		expectTypeOf<NonNullable<Parameters<typeof deep.post<"/v1/methods/resource">>[1]>>().toEqualTypeOf<{
			readonly json: { name: string }
		}>()
	})
})

describe("what a call resolves", () => {
	// v0: 9dc6431085
	// v0: 7ebeffe22d
	// v0: 2b64ade49c
	// v0: 21bc10ae7d
	// v0: 3fd365de52
	// v0: 36f0c96749
	// v0: b36a5c6f62
	// v0: f5fb7a6348
	it("throw mode resolves a single json status as its schema's type: an object, a created body, an array", () => {
		expectTypeOf(thrower.get("/output/json")).toEqualTypeOf<Promise<{ email: string; id: string; name: string }>>()
		expectTypeOf(thrower.get("/users/:id", { params: { id: "1" } })).toEqualTypeOf<
			Promise<{ id: string; name: string }>
		>()
		expectTypeOf(thrower.post("/users", { json: { name: "a" } })).toEqualTypeOf<Promise<{ id: string }>>()
		expectTypeOf(thrower.get("/users", { search: {} })).toEqualTypeOf<Promise<{ id: string; name: string }[]>>()
		expectTypeOf(thrower.post("/input/json", { json: { email: "a@b.c", name: "a" } })).toEqualTypeOf<
			Promise<{ email: string; id: string; name: string }>
		>()
	})

	// v0: 78d854cb46
	// v0: 32581f87d3
	// v0: 89b1d821bf
	it("resolves several json statuses as the union of their bodies", () => {
		expectTypeOf(thrower.post("/output/json-multi")).toEqualTypeOf<
			Promise<{ detail: string } | { id: string; name: string }>
		>()
		expectTypeOf(thrower.post("/jobs")).toEqualTypeOf<
			Promise<{ eta: number; jobId: string } | { reason: string } | { result: string }>
		>()
	})

	// v0: 9ddb72e91e
	it("takes search in and resolves a paginated object out on one route", () => {
		expectTypeOf(thrower.get("/input/search", { search: { limit: 10, page: 1 } })).toEqualTypeOf<
			Promise<{ items: { id: string }[]; nextCursor: string | null; total: number }>
		>()
	})

	// v0: d4382d2625
	// v0: c07ddbf8fe
	// v0: 7126d71e1f
	// v0: a9e3560662
	// v0: d03706997a
	it("resolves null for a route without output, a noContent DELETE by params included", () => {
		expectTypeOf(thrower.get("/output/untyped")).toEqualTypeOf<Promise<null>>()
		expectTypeOf(thrower.get("/health")).toEqualTypeOf<Promise<null>>()
		expectTypeOf(thrower.delete("/methods/resource/:id", { params: { id: "1" } })).toEqualTypeOf<Promise<null>>()
		expectTypeOf<NonNullable<Parameters<typeof api.delete<"/methods/resource/:id">>[1]>>().toEqualTypeOf<{
			params: { id: string }
		}>()
	})
})

describe("what a call resolves by media type", () => {
	// v0: 0d253d3884
	// v0: ca473c631c
	// v0: b8ca8719c7
	// v0: 02ca491a43
	// v0: 3a503c0faa
	// v0: 4b81999fa5
	// v0: 361266fcfb
	// v0: ea387c0bf3
	it("resolves a text/plain, text/html, text/csv or application/xml output as a string", () => {
		expectTypeOf(thrower.get("/output/text")).toEqualTypeOf<Promise<string>>()
		expectTypeOf(thrower.get("/output/html")).toEqualTypeOf<Promise<string>>()
		expectTypeOf(thrower.get("/output/csv")).toEqualTypeOf<Promise<string>>()
		expectTypeOf(thrower.get("/output/xml")).toEqualTypeOf<Promise<string>>()
	})

	// v0: 11c3a6a4ae
	it("resolves an application/octet-stream output as bytes (A1)", () => {
		expectTypeOf(thrower.get("/output/binary")).toEqualTypeOf<Promise<Uint8Array<ArrayBuffer>>>()
	})

	// v0: ee7aa99202
	// v0: 87fc01b238
	// v0: b12a193174
	// v0: 7129910f96
	it("returns an AsyncIterable of SSE events for a text/event-stream route only", () => {
		expectTypeOf(thrower.get("/output/sse")).toEqualTypeOf<AsyncIterable<SSEEvent>>()
		expectTypeOf(api.get("/output/sse")).toEqualTypeOf<AsyncIterable<SSEEvent>>()
		expectTypeOf(thrower.get("/output/json")).not.toExtend<AsyncIterable<SSEEvent>>()
		expectTypeOf(thrower.get("/output/untyped")).not.toExtend<AsyncIterable<SSEEvent>>()
	})

	// v0: 4a3c6fb134
	it("reads a route's declared output map: media type, status, schema", () => {
		expectTypeOf<OutputDefFor<InferRoutes<typeof app>, "/users/:id", "get">>().toExtend<{
			"application/json": { ok: typeof row }
		}>()
	})
})

describe("result mode and the declared errors", () => {
	// v0: ce81093ba0
	// v0: b797bb4a20
	it("defaults to result mode: Promise<ClientResult<data, errorsByStatus>> with the declared statuses", () => {
		expectTypeOf(api.get("/users/:id", { params: { id: "1" } })).toEqualTypeOf<
			Promise<ClientResult<{ id: string; name: string }, { 404: null }>>
		>()
	})

	// v0: 680e667162
	it("narrows the error branch by status to that status's declared error body", () => {
		type Result = Awaited<ReturnType<typeof erringApi.get<"/items/:id">>>
		expectTypeOf<Extract<Result, { error: null }>["data"]>().toEqualTypeOf<{ name: string }>()
		expectTypeOf<Extract<Result, { status: 404 }>["error"]>().toEqualTypeOf<{ reason: string; suggestions: string[] }>()
	})

	// v0: d5b5570bad
	// v0: 681d5c6a54
	// v0: c174579ea4
	// v0: 69ad843cfd
	it("types a route's declared error keys, never for none, on a 70-route map too", () => {
		type Routes = InferRoutes<typeof big>
		expectTypeOf<ErrorsFor<Routes, "/users/:id", "get">>().toEqualTypeOf<"not_found">()
		expectTypeOf<ErrorsFor<Routes, "/health", "get">>().toBeNever()
		expectTypeOf<ErrorsFor<Routes, "/v1/users/:id", "get">>().toEqualTypeOf<"not_found">()
		expectTypeOf<ErrorsFor<Routes, "/v1/health", "get">>().toBeNever()
	})
})
