import { describe, expect, it } from "vitest"
import * as z from "zod"
import { honey } from "../routing/app.ts"
import { rangeResponse } from "./range.ts"

const get = (path: string, headers: Record<string, string> = {}) => new Request(`http://localhost${path}`, { headers })

/** `text` as an encoded stream. */
const stream = (text: string) =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text))
			controller.close()
		},
	})

/** The status, the content type, the body and the error key of an answer. */
async function seen(answer: Response | Promise<Response>): Promise<[number, string | null, string]> {
	const response = await answer
	const text = await response.text()
	const errorKey = response.status === 500 ? (JSON.parse(text) as { error_key: string }).error_key : text
	return [response.status, response.headers.get("content-type"), errorKey]
}

describe("ctx.res.forward(): a Response whose status is decided elsewhere, checked against the declaration", () => {
	const app = honey<{}>().logger(false)
	const bytes = new TextEncoder().encode("0123456789")
	app
		.get("/file")
		.output({ "application/octet-stream": { not_modified: true, ok: true, partial_content: true } })
		.handler((ctx) => ctx.res.forward(rangeResponse(ctx.req, bytes)))
	app
		.get("/whole-only")
		.output({ "application/octet-stream": { ok: true } })
		.handler((ctx) => ctx.res.forward(rangeResponse(ctx.req, bytes)))
	app
		.get("/html")
		.output({ "application/octet-stream": { ok: true } })
		.handler((ctx) => ctx.res.forward(new Response("<p>", { headers: { "content-type": "text/html" } })))
	app
		.get("/cached")
		.output({ "application/octet-stream": { not_modified: true, ok: true } })
		.handler((ctx) => ctx.res.forward(new Response(null, { headers: { etag: '"v1"' }, status: 304 })))

	it("a 206 at a declared partial_content answers 206; one the route does not declare is refused", async () => {
		expect([
			await seen(app.fetch(get("/file", { range: "bytes=2-4" }), {})),
			await seen(app.fetch(get("/file"), {})),
			await seen(app.fetch(get("/whole-only", { range: "bytes=2-4" }), {})),
			await seen(app.fetch(get("/whole-only"), {})),
		]).toEqual([
			[206, "application/octet-stream", "234"],
			[200, "application/octet-stream", "0123456789"],
			[500, "application/json", "output_validation_failed"],
			[200, "application/octet-stream", "0123456789"],
		])
	})

	it("a media type the status does not declare is refused, though output validation is off", async () => {
		expect(await seen(app.fetch(get("/html"), {}))).toEqual([500, "application/json", "output_content_type_mismatch"])
	})

	it("a forwarded 304 is bodiless: its status needs no media type, and its headers pass through", async () => {
		const response = await app.fetch(get("/cached"), {})
		expect([response.status, response.body, response.headers.get("etag")]).toEqual([304, null, '"v1"'])
	})
})

describe("ctx.res.forward(): any declared status, its body unread", () => {
	it("a forwarded redirect answers at a declared redirect key; a status with no key is refused by its code", async () => {
		const routes = honey<{}>().logger(false)
		routes
			.get("/moved")
			.output({ "text/plain": { ok: true }, redirect: { found: true } })
			.handler((ctx) => ctx.res.forward(Response.redirect("http://localhost/there", 302)))
		routes
			.get("/odd")
			.output({ "text/plain": { ok: true } })
			.handler((ctx) => ctx.res.forward(new Response("x", { status: 299 })))
		const moved = await routes.fetch(get("/moved"), {})
		const odd = await routes.fetch(get("/odd"), {})
		expect([moved.status, moved.headers.get("location"), odd.status, await odd.json()]).toMatchObject([
			302,
			"http://localhost/there",
			500,
			{ error_key: "output_validation_failed" },
		])
	})

	it("its body is not validated, though output validation is on: only its status and media type are", async () => {
		const routes = honey<{}>().logger(false).outputValidation("always")
		routes
			.get("/upstream")
			.output({ ok: z.object({ id: z.string() }) })
			.handler((ctx) => ctx.res.forward(Response.json({ id: 1 })))
		expect(await seen(routes.fetch(get("/upstream"), {}))).toEqual([200, "application/json", '{"id":1}'])
	})
})

describe("an encoded stream under a declared media type: sse() and json() take one as it comes", () => {
	const app = honey<{}>().logger(false)
	app
		.get("/events")
		.output({ "text/event-stream": { ok: z.string() } })
		.handler((ctx) => ctx.res.sse(stream("data: one\n\n"), { headers: { "cache-control": "no-store" } }))
	app
		.get("/export")
		.output({ ok: z.object({ id: z.string() }) })
		.handler((ctx) => ctx.res.json("ok", stream('{"id":"a"}'), { headers: { "content-disposition": "attachment" } }))

	it("sse() passes an event stream through, json() a JSON document, each with its headers", async () => {
		const events = await app.fetch(get("/events"), {})
		const exported = await app.fetch(get("/export"), {})
		expect([
			[events.status, events.headers.get("content-type"), events.headers.get("cache-control"), await events.text()],
			[exported.status, exported.headers.get("content-disposition"), await exported.json()],
		]).toEqual([
			[200, "text/event-stream", "no-store", "data: one\n\n"],
			[200, "attachment", { id: "a" }],
		])
	})
})
