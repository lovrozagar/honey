import { describe, expectTypeOf, it } from "vitest"
import * as z from "zod"
import type { SSEEvent } from "../../../src/client/sse.ts"
import type { ClientInput, InputFor, IsSSE, OutputFor, PathsForMethod, ReturnFor } from "../../../src/client/types.ts"
import { honey } from "../../../src/index.ts"
import { readableStream } from "../../../src/input.ts"

/* ---- fixture: app with every input/output combo ---- */

const UserSchema = z.object({ email: z.string(), id: z.string(), name: z.string() })
const OrgSchema = z.object({ id: z.string(), name: z.string(), slug: z.string() })
const ErrorSchema = z.object({ detail: z.string() })
const PaginationSchema = z.object({
	items: z.array(UserSchema),
	nextCursor: z.string().nullable(),
	total: z.number(),
})

function buildFullApp() {
	return (
		honey<{}>()
			/* ---- INPUT COMBOS ---- */

			/* json body only */
			.post("/input/json")
			.input({ json: z.object({ email: z.string(), name: z.string() }) })
			.output({ "application/json": { created: UserSchema } })
			.handler((ctx) =>
				ctx.res.json("created", {
					email: ctx.input.json.email,
					id: "1",
					name: ctx.input.json.name,
				}),
			)

			/* form body only */
			.post("/input/form")
			.input({ form: z.object({ password: z.string(), username: z.string() }) })
			.output({ "application/json": { ok: z.object({ token: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { token: `t-${ctx.input.form.username}` }))

			/* search params only */
			.get("/input/search")
			.input({ search: z.object({ limit: z.number(), page: z.number() }) })
			.output({ "application/json": { ok: PaginationSchema } })
			.handler((ctx) => ctx.res.json("ok", { items: [], nextCursor: null, total: 0 }))

			/* headers only */
			.get("/input/headers")
			.input({ headers: z.object({ "x-api-key": z.string(), "x-tenant": z.string() }) })
			.output({ "application/json": { ok: z.object({ tenant: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { tenant: ctx.input.headers["x-tenant"] }))

			/* cookies only */
			.get("/input/cookies")
			.input({ cookies: z.object({ session: z.string() }) })
			.output({ "application/json": { ok: z.object({ sessionValid: z.boolean() }) } })
			.handler((ctx) => ctx.res.json("ok", { sessionValid: ctx.input.cookies.session.length > 0 }))

			/* params only (from path) */
			.get("/input/params/:userId")
			.output({ "application/json": { ok: UserSchema } })
			.handler((ctx) => ctx.res.json("ok", { email: "a@b.com", id: ctx.params.userId, name: "Test" }))

			/* json + search + headers combined */
			.put("/input/combined/:id")
			.input({
				headers: z.object({ "x-idempotency-key": z.string() }),
				json: z.object({ name: z.string() }),
				search: z.object({ dryRun: z.boolean().optional() }),
			})
			.output({ "application/json": { ok: z.object({ updated: z.boolean() }) } })
			.handler((ctx) => ctx.res.json("ok", { updated: true }))

			/* no input at all */
			.get("/input/none")
			.output({ "application/json": { ok: z.object({ ping: z.literal("pong") }) } })
			.handler((ctx) => ctx.res.json("ok", { ping: "pong" as const }))

			/* ---- readableStream() COMBOS — skip validation, types still inferred ---- */

			/* readableStream json — body not buffered, handler gets raw stream */
			.post("/input/rs-json")
			.input({ json: readableStream(z.object({ data: z.string(), size: z.number() })) })
			.output({ "application/json": { ok: z.object({ received: z.boolean() }) } })
			.handler((ctx) => ctx.res.json("ok", { received: true }))

			/* readableStream form */
			.post("/input/rs-form")
			.input({ form: readableStream(z.object({ field: z.string() })) })
			.output({ "application/json": { ok: z.object({ ok: z.boolean() }) } })
			.handler((ctx) => ctx.res.json("ok", { ok: true }))

			/* readableStream json + regular search + regular headers */
			.post("/input/rs-json-mixed")
			.input({
				headers: z.object({ "x-trace": z.string() }),
				json: readableStream(z.object({ payload: z.string() })),
				search: z.object({ async: z.boolean().optional() }),
			})
			.output({ "application/json": { accepted: z.object({ jobId: z.string() }) } })
			.handler((ctx) => ctx.res.json("accepted", { jobId: "j-1" }))

			/* readableStream search (non-body — still works) */
			.get("/input/rs-search")
			.input({ search: readableStream(z.object({ filter: z.string() })) })
			.output({ "application/json": { ok: z.object({ count: z.number() }) } })
			.handler((ctx) => ctx.res.json("ok", { count: 0 }))

			/* readableStream headers */
			.get("/input/rs-headers")
			.input({ headers: readableStream(z.object({ "x-token": z.string() })) })
			.output({ "application/json": { ok: z.object({ valid: z.boolean() }) } })
			.handler((ctx) => ctx.res.json("ok", { valid: true }))

			/* readableStream cookies */
			.get("/input/rs-cookies")
			.input({ cookies: readableStream(z.object({ session: z.string() })) })
			.output({ "application/json": { ok: z.object({ active: z.boolean() }) } })
			.handler((ctx) => ctx.res.json("ok", { active: true }))

			/* ---- OUTPUT CONTENT-TYPE COMBOS ---- */

			/* application/json — single status */
			.get("/output/json")
			.output({ "application/json": { ok: UserSchema } })
			.handler((ctx) => ctx.res.json("ok", { email: "a@b.com", id: "1", name: "Test" }))

			/* application/json — multiple status keys */
			.post("/output/json-multi")
			.input({ json: z.object({ name: z.string() }) })
			.output({
				"application/json": {
					conflict: ErrorSchema,
					created: OrgSchema,
				},
			})
			.handler((ctx) => ctx.res.json("created", { id: "1", name: ctx.input.json.name, slug: "test" }))

			/* text/plain */
			.get("/output/text")
			.output({ "text/plain": { ok: z.string() } })
			.handler((ctx) => ctx.res.text("ok", "hello world"))

			/* text/html */
			.get("/output/html")
			.output({ "text/html": { ok: z.string() } })
			.handler((ctx) => ctx.res.html("ok", "<h1>Hello</h1>"))

			/* text/csv */
			.get("/output/csv")
			.output({ "text/csv": { ok: z.string() } })
			.handler((ctx) => ctx.res.csv("ok", "id,name\n1,Test"))

			/* application/xml */
			.get("/output/xml")
			.output({ "application/xml": { ok: z.string() } })
			.handler((ctx) => ctx.res.xml("ok", "<root/>"))

			/* application/octet-stream (binary) */
			.get("/output/binary")
			.output({ "application/octet-stream": { ok: z.instanceof(Uint8Array) } })
			.handler((ctx) => ctx.res.binary("ok", new Uint8Array([0x00])))

			/* text/event-stream — SSE */
			.get("/output/sse")
			.output({ "text/event-stream": { ok: z.string() } })
			.handler((ctx) =>
				ctx.res.sse(async (stream) => {
					await stream.send({ data: "hello", event: "msg" })
					stream.close()
				}),
			)

			/* no output schema */
			.get("/output/untyped")
			.handler((ctx) => ctx.res.json("ok", { anything: true }))

			/* ---- METHOD COMBOS ---- */

			.get("/methods/resource")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: "1" }))

			.post("/methods/resource")
			.input({ json: z.object({ name: z.string() }) })
			.output({ "application/json": { created: z.object({ id: z.string(), name: z.string() }) } })
			.handler((ctx) => ctx.res.json("created", { id: "1", name: ctx.input.json.name }))

			.put("/methods/resource/:id")
			.input({ json: z.object({ name: z.string() }) })
			.output({ "application/json": { ok: z.object({ id: z.string(), name: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id, name: ctx.input.json.name }))

			.patch("/methods/resource/:id")
			.input({ json: z.object({ name: z.string().optional() }) })
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

			.delete("/methods/resource/:id")
			.handler((ctx) => ctx.res.noContent())
	)
}

type App = ReturnType<typeof buildFullApp>
type Routes = App["$routes"]

/* ================================================================
   INPUT TYPE TESTS
   ================================================================ */

describe("InputFor — all input source combos", () => {
	it("json body", () => {
		type I = InputFor<Routes, "/input/json", "post">
		expectTypeOf<I>().toMatchTypeOf<{ json: { email: string; name: string } }>()
	})

	it("form body", () => {
		type I = InputFor<Routes, "/input/form", "post">
		expectTypeOf<I>().toMatchTypeOf<{ form: { password: string; username: string } }>()
	})

	it("search params", () => {
		type I = InputFor<Routes, "/input/search", "get">
		expectTypeOf<I>().toMatchTypeOf<{ search: { limit: number; page: number } }>()
	})

	it("headers", () => {
		type I = InputFor<Routes, "/input/headers", "get">
		expectTypeOf<I>().toMatchTypeOf<{ headers: { "x-api-key": string; "x-tenant": string } }>()
	})

	it("cookies", () => {
		type I = InputFor<Routes, "/input/cookies", "get">
		expectTypeOf<I>().toMatchTypeOf<{ cookies: { session: string } }>()
	})

	it("no input schema → empty object", () => {
		type I = InputFor<Routes, "/input/none", "get">
		expectTypeOf<I>().toEqualTypeOf<{}>()
	})

	it("combined json + search + headers", () => {
		type I = InputFor<Routes, "/input/combined/:id", "put">
		expectTypeOf<I>().toMatchTypeOf<{
			headers: { "x-idempotency-key": string }
			json: { name: string }
			search: { dryRun?: boolean }
		}>()
	})
})

describe("InputFor — readableStream() wrapped schemas", () => {
	it("readableStream json — same type as plain json", () => {
		type I = InputFor<Routes, "/input/rs-json", "post">
		expectTypeOf<I>().toMatchTypeOf<{ json: { data: string; size: number } }>()
	})

	it("readableStream form — same type as plain form", () => {
		type I = InputFor<Routes, "/input/rs-form", "post">
		expectTypeOf<I>().toMatchTypeOf<{ form: { field: string } }>()
	})

	it("readableStream json + regular search + regular headers", () => {
		type I = InputFor<Routes, "/input/rs-json-mixed", "post">
		expectTypeOf<I>().toMatchTypeOf<{
			headers: { "x-trace": string }
			json: { payload: string }
			search: { async?: boolean }
		}>()
	})

	it("readableStream search — same type as plain search", () => {
		type I = InputFor<Routes, "/input/rs-search", "get">
		expectTypeOf<I>().toMatchTypeOf<{ search: { filter: string } }>()
	})

	it("readableStream headers — same type as plain headers", () => {
		type I = InputFor<Routes, "/input/rs-headers", "get">
		expectTypeOf<I>().toMatchTypeOf<{ headers: { "x-token": string } }>()
	})

	it("readableStream cookies — same type as plain cookies", () => {
		type I = InputFor<Routes, "/input/rs-cookies", "get">
		expectTypeOf<I>().toMatchTypeOf<{ cookies: { session: string } }>()
	})
})

describe("ClientInput — input + path params merged", () => {
	it("path with :param adds required params field", () => {
		type CI = ClientInput<Routes, "/input/params/:userId", "get">
		expectTypeOf<CI>().toMatchTypeOf<{ params: { userId: string } }>()
	})

	it("path with :param + other input merges both", () => {
		type CI = ClientInput<Routes, "/input/combined/:id", "put">
		expectTypeOf<CI>().toMatchTypeOf<{
			json: { name: string }
			params: { id: string }
			search: { dryRun?: boolean }
		}>()
	})

	it("path without params does not add params field", () => {
		type CI = ClientInput<Routes, "/input/json", "post">
		type HasParams = "params" extends keyof CI ? true : false
		expectTypeOf<false>().toEqualTypeOf<HasParams>()
	})

	it("multi-param path types all params", () => {
		type CI = ClientInput<Routes, "/methods/resource/:id", "put">
		expectTypeOf<CI>().toMatchTypeOf<{ params: { id: string } }>()
	})
})

/* ================================================================
   OUTPUT TYPE TESTS
   ================================================================ */

describe("OutputFor — all output content-type combos", () => {
	it("application/json single status → inferred data type", () => {
		type O = OutputFor<Routes, "/output/json", "get">
		expectTypeOf<O>().toMatchTypeOf<{ email: string; id: string; name: string }>()
	})

	it("application/json multiple statuses → union of data types", () => {
		type O = OutputFor<Routes, "/output/json-multi", "post">
		/* union of created (OrgSchema) and conflict (ErrorSchema) */
		expectTypeOf<{ detail: string }>().toMatchTypeOf<O>()
		expectTypeOf<{ id: string; name: string; slug: string }>().toMatchTypeOf<O>()
	})

	it("no output schema → null", () => {
		type O = OutputFor<Routes, "/output/untyped", "get">
		expectTypeOf<O>().toEqualTypeOf<null>()
	})

	it("text/plain output → string", () => {
		type O = OutputFor<Routes, "/output/text", "get">
		expectTypeOf<O>().toEqualTypeOf<string>()
	})

	it("text/html output → string", () => {
		type O = OutputFor<Routes, "/output/html", "get">
		expectTypeOf<O>().toEqualTypeOf<string>()
	})

	it("text/csv output → string", () => {
		type O = OutputFor<Routes, "/output/csv", "get">
		expectTypeOf<O>().toEqualTypeOf<string>()
	})

	it("application/xml output → string", () => {
		type O = OutputFor<Routes, "/output/xml", "get">
		expectTypeOf<O>().toEqualTypeOf<string>()
	})

	it("application/octet-stream output → ArrayBuffer", () => {
		type O = OutputFor<Routes, "/output/binary", "get">
		expectTypeOf<O>().toEqualTypeOf<ArrayBuffer>()
	})
})

/* ================================================================
   SSE DETECTION
   ================================================================ */

describe("IsSSE — detects text/event-stream routes", () => {
	it("SSE route → true", () => {
		type Check = IsSSE<Routes, "/output/sse", "get">
		expectTypeOf<Check>().toEqualTypeOf<true>()
	})

	it("JSON route → false", () => {
		type Check = IsSSE<Routes, "/output/json", "get">
		expectTypeOf<Check>().toEqualTypeOf<false>()
	})

	it("untyped route → false", () => {
		type Check = IsSSE<Routes, "/output/untyped", "get">
		expectTypeOf<Check>().toEqualTypeOf<false>()
	})
})

/* ================================================================
   RETURN TYPE — REST vs SSE
   ================================================================ */

describe("ReturnFor — adapts per transport", () => {
	it("JSON route → Promise<data>", () => {
		type R = ReturnFor<Routes, "/output/json", "get">
		expectTypeOf<R>().toMatchTypeOf<Promise<{ email: string; id: string; name: string }>>()
	})

	it("SSE route → AsyncIterable<SSEEvent>", () => {
		type R = ReturnFor<Routes, "/output/sse", "get">
		expectTypeOf<R>().toEqualTypeOf<AsyncIterable<SSEEvent>>()
	})

	it("untyped route → Promise<null>", () => {
		type R = ReturnFor<Routes, "/output/untyped", "get">
		expectTypeOf<R>().toEqualTypeOf<Promise<null>>()
	})
})

/* ================================================================
   PATHS FOR METHOD
   ================================================================ */

describe("PathsForMethod — all HTTP methods", () => {
	it("GET paths", () => {
		type P = PathsForMethod<Routes, "get">
		expectTypeOf<"/input/search">().toMatchTypeOf<P>()
		expectTypeOf<"/input/headers">().toMatchTypeOf<P>()
		expectTypeOf<"/input/cookies">().toMatchTypeOf<P>()
		expectTypeOf<"/input/params/:userId">().toMatchTypeOf<P>()
		expectTypeOf<"/input/none">().toMatchTypeOf<P>()
		expectTypeOf<"/output/json">().toMatchTypeOf<P>()
		expectTypeOf<"/output/sse">().toMatchTypeOf<P>()
		expectTypeOf<"/methods/resource">().toMatchTypeOf<P>()
	})

	it("POST paths", () => {
		type P = PathsForMethod<Routes, "post">
		expectTypeOf<"/input/json">().toMatchTypeOf<P>()
		expectTypeOf<"/input/form">().toMatchTypeOf<P>()
		expectTypeOf<"/output/json-multi">().toMatchTypeOf<P>()
		expectTypeOf<"/methods/resource">().toMatchTypeOf<P>()
	})

	it("PUT paths", () => {
		type P = PathsForMethod<Routes, "put">
		expectTypeOf<"/input/combined/:id">().toMatchTypeOf<P>()
		expectTypeOf<"/methods/resource/:id">().toMatchTypeOf<P>()
	})

	it("PATCH paths", () => {
		type P = PathsForMethod<Routes, "patch">
		expectTypeOf<"/methods/resource/:id">().toMatchTypeOf<P>()
	})

	it("DELETE paths", () => {
		type P = PathsForMethod<Routes, "delete">
		expectTypeOf<"/methods/resource/:id">().toMatchTypeOf<P>()
	})

	it("GET does not include POST-only paths", () => {
		type P = PathsForMethod<Routes, "get">
		/* /input/json is POST only */
		type Check = "/input/json" extends P ? true : false
		expectTypeOf<false>().toEqualTypeOf<Check>()
	})
})

/* ================================================================
   END-TO-END: full route type chain
   ================================================================ */

describe("end-to-end: full type chain per route", () => {
	it("POST /input/json — json body in, typed json out", () => {
		type I = InputFor<Routes, "/input/json", "post">
		type O = OutputFor<Routes, "/input/json", "post">
		expectTypeOf<I>().toMatchTypeOf<{ json: { email: string; name: string } }>()
		expectTypeOf<O>().toMatchTypeOf<{ email: string; id: string; name: string }>()
	})

	it("GET /input/search — search in, paginated out", () => {
		type I = InputFor<Routes, "/input/search", "get">
		type O = OutputFor<Routes, "/input/search", "get">
		expectTypeOf<I>().toMatchTypeOf<{ search: { limit: number; page: number } }>()
		expectTypeOf<O>().toMatchTypeOf<{
			items: Array<{ id: string }>
			nextCursor: string | null
			total: number
		}>()
	})

	it("PUT /input/combined/:id — json+search+headers+params in, typed out", () => {
		type CI = ClientInput<Routes, "/input/combined/:id", "put">
		type O = OutputFor<Routes, "/input/combined/:id", "put">
		expectTypeOf<CI>().toMatchTypeOf<{
			headers: { "x-idempotency-key": string }
			json: { name: string }
			params: { id: string }
			search: { dryRun?: boolean }
		}>()
		expectTypeOf<O>().toMatchTypeOf<{ updated: boolean }>()
	})

	it("GET /output/sse — no input, SSE stream out", () => {
		type R = ReturnFor<Routes, "/output/sse", "get">
		expectTypeOf<R>().toEqualTypeOf<AsyncIterable<SSEEvent>>()
	})

	it("DELETE /methods/resource/:id — params in, unknown out (noContent)", () => {
		type CI = ClientInput<Routes, "/methods/resource/:id", "delete">
		type O = OutputFor<Routes, "/methods/resource/:id", "delete">
		expectTypeOf<CI>().toMatchTypeOf<{ params: { id: string } }>()
		expectTypeOf<O>().toEqualTypeOf<null>()
	})
})
