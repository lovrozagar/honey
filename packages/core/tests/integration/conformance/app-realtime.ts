/**
 * The conformance app's realtime feeds (bit 19 e, bit 21 i7), split out of app.ts for its 500-line cap: the refusal
 * routes every transport dials, and `realtime.capped`, a send's answer past a small response cap.
 */
import * as z from "zod"
import type { SSEStream } from "../../../src/response/sse.ts"
import type { ConformanceApp, errors } from "./app.ts"

/**
 * The realtime feeds every transport dials (bit 19 e): `realtime.refused` refuses each with 403; `realtime.mixed`
 * 404s the upgrade, 503s every poll and the first event stream since the wire mark, then streams `{ n: 1 }`.
 */
export function realtimeRoutes(app: ConformanceApp, streams: { dialed: number }, factory: typeof errors): void {
	const feed = { "text/event-stream": { ok: z.object({ n: z.number().int() }) } }
	app
		.get("/realtime/refused")
		.meta({ extensions: { "x-realtime": true }, operationId: "realtime.refused", mcp: true })
		.errors("limit_reached")
		.output(feed)
		.handler(() => {
			throw factory.limit_reached()
		})
	app
		.get("/realtime/mixed")
		.meta({ extensions: { "x-realtime": true }, operationId: "realtime.mixed", mcp: true })
		.output(feed)
		.handler((ctx) => {
			if (ctx.req.headers.get("upgrade") !== null) return ctx.res.raw(new Response(null, { status: 404 }))
			const stream = ctx.req.headers.get("accept")?.includes("text/event-stream") === true
			if (!stream || streams.dialed++ === 0) return ctx.res.raw(new Response(null, { status: 503 }))
			return ctx.res.sse(async (sse) => {
				await sse.send({ data: { n: 1 }, event: "message", id: "1" })
				sse.close()
			})
		})
	cappedRoutes(app, feed)
}

/**
 * `realtime.capped` (bit 21 i7): a send's answer past a small response cap. The upgrade 404s, so the SDK dials the
 * event stream, which stays open with only a retry directive (Bun sends a streamed answer's headers with its first
 * bytes); each send (a POST, internal so in no generated artifact) answers a 2xx past 16 bytes, then `{ n: 1 }` goes
 * to every open stream, so a client that took that answer reads a frame.
 */
function cappedRoutes(app: ConformanceApp, feed: { "text/event-stream": { ok: z.ZodType } }): void {
	const open = new Set<SSEStream>()
	app
		.get("/realtime/capped")
		.meta({ extensions: { "x-realtime": true }, operationId: "realtime.capped" })
		.output(feed)
		.handler((ctx) => {
			if (ctx.req.headers.get("upgrade") !== null) return ctx.res.raw(new Response(null, { status: 404 }))
			if (ctx.req.headers.get("accept")?.includes("text/event-stream") !== true)
				return ctx.res.raw(new Response(null, { status: 503 }))
			return ctx.res.sse(
				async (sse) => {
					open.add(sse)
					await new Promise((resolve) => sse.signal.addEventListener("abort", resolve, { once: true }))
					open.delete(sse)
				},
				{ defaultRetry: 1000 },
			)
		})
	app
		.post("/realtime/capped")
		.meta({ internal: true })
		.handler((ctx) => {
			setTimeout(() => {
				for (const sse of open) void sse.send({ data: { n: 1 }, event: "message", id: "1" })
			}, 0)
			return ctx.res.raw(Response.json({ accepted: "the send, answered past the cap" }))
		})
}
