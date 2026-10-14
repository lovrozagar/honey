/**
 * The streaming helpers as typed: sse(), stream() and generate() brand their responses with a
 * content type and the ok status, the SSE stream and event shapes, and a route answering with
 * each. The declared SSE event schema is typed at bit 08 (H10). Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import { HoneyRes, type TypedResponse } from "../../src/response/response.ts"
import type { SSEEvent, SSEStream } from "../../src/response/sse.ts"
import { honey } from "../../src/routing/app.ts"

const res = new HoneyRes()

describe("the streaming helpers brand what they return", () => {
	// v0: 63c73d341e
	it("sse() is text/event-stream, ok", () => {
		expectTypeOf(res.sse(async () => {})).toEqualTypeOf<TypedResponse<"text/event-stream", "ok">>()
	})

	// v0: 8ed2c84e5e
	it("stream() is application/octet-stream, ok", () => {
		expectTypeOf(res.stream(async () => {})).toEqualTypeOf<TypedResponse<"application/octet-stream", "ok">>()
	})

	it("generate() is ok, its content type whatever it was given", () => {
		expectTypeOf(res.generate((function* () {})())).toEqualTypeOf<TypedResponse<string, "ok">>()
	})
})

describe("the SSE stream and its events", () => {
	it("send() takes an event and resolves when the client wants more", () => {
		expectTypeOf<SSEStream["send"]>().toEqualTypeOf<(event: SSEEvent) => Promise<void>>()
		expectTypeOf<SSEStream["lastEventId"]>().toEqualTypeOf<string | undefined>()
		expectTypeOf<SSEStream["signal"]>().toEqualTypeOf<AbortSignal>()
		expectTypeOf<SSEStream["closed"]>().toEqualTypeOf<boolean>()
	})

	it("an event needs a name and data; id and retry are optional", () => {
		expectTypeOf<{ data: string; event: string }>().toExtend<SSEEvent>()
		expectTypeOf<{ data: { n: number }; event: string; id: string; retry: number }>().toExtend<SSEEvent>()
		expectTypeOf<{ data: string }>().not.toExtend<SSEEvent>()
		expectTypeOf<{ data: number; event: string }>().not.toExtend<SSEEvent>()
	})

	it("a stream() callback gets the writable and the request's signal", () => {
		res.stream(async (writable, signal) => {
			expectTypeOf(writable).toEqualTypeOf<WritableStream>()
			expectTypeOf(signal).toEqualTypeOf<AbortSignal>()
		})
	})
})

describe("routes answer with a stream", () => {
	it("a handler may return sse(), stream() or generate()", () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) => ctx.res.sse(async (stream) => stream.send({ data: "x", event: "m" })))
		app.get("/download").handler((ctx) => ctx.res.stream(async () => {}))
		app.get("/lines").handler((ctx) => ctx.res.generate((function* () {})(), { contentType: "application/x-ndjson" }))
		expectTypeOf(app.fetch).returns.toEqualTypeOf<Response | Promise<Response>>()
	})
})
