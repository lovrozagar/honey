/**
 * The app-typed client (`createClient<typeof app>`, gen's runtime template) on event-stream routes:
 * which routes `IsSSE` calls a stream, and that a stream call returns an AsyncIterable of events in
 * throw and result mode alike. Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import * as z from "zod"
import type { createClient } from "../../../gen/src/runtime/ts/app.ts"
import type { IsSSE, ReturnFor, SafeReturnFor } from "../../../gen/src/runtime/ts/app-types.ts"
import type { Result } from "../../../gen/src/runtime/ts/response.ts"
import type { SSEEvent } from "../../../gen/src/runtime/ts/sse.ts"
import { honey } from "../../src/routing/app.ts"
import type { InferRoutes } from "../../src/routing/app-types.ts"

/** An event stream, a JSON route, and a route answering JSON or text but no stream. */
const app = honey<{}>()
	.get("/events")
	.output({ "text/event-stream": { ok: z.string() } })
	.handler((ctx) => ctx.res.sse(async () => {}))
	.get("/users")
	.output({ "application/json": { ok: z.object({ id: z.string() }).array() } })
	.handler((ctx) => ctx.res.json("ok", []))
	.get("/data")
	.output({ "application/json": { ok: z.object({ id: z.string() }) }, "text/plain": { ok: z.string() } })
	.handler((ctx) => ctx.res.json("ok", { id: "1" }))

type Routes = InferRoutes<typeof app>

declare const api: ReturnType<typeof createClient<typeof app>>

describe("which routes are streams", () => {
	// v0: 35de9ffcf2
	it("an SSE-declared route is a stream call", () => {
		expectTypeOf<IsSSE<Routes, "/events", "get">>().toEqualTypeOf<true>()
	})

	// v0: 0b5d73b96c
	it("a JSON route is not a stream call", () => {
		expectTypeOf<IsSSE<Routes, "/users", "get">>().toEqualTypeOf<false>()
	})

	// v0: 0abb240341
	it("a JSON plus text route without text/event-stream is not a stream call", () => {
		expectTypeOf<IsSSE<Routes, "/data", "get">>().toEqualTypeOf<false>()
	})

	// v0: 16a0a57bd2
	it("an SSE route returns an AsyncIterable of events, and its safe call one opened in a Result", () => {
		expectTypeOf<ReturnFor<Routes, "/events", "get">>().toEqualTypeOf<AsyncIterable<SSEEvent>>()
		expectTypeOf<SafeReturnFor<Routes, "/events", "get">>().toEqualTypeOf<Promise<Result<AsyncIterable<SSEEvent>>>>()
		expectTypeOf(api.get("/events")).toEqualTypeOf<AsyncIterable<SSEEvent>>()
		expectTypeOf(api.safe.get("/events")).toEqualTypeOf<Promise<Result<AsyncIterable<SSEEvent>>>>()
	})
})
