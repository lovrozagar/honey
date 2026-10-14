/**
 * Correlation (H17): with telemetry on, `requestId` puts `honey.request_id` on the root span, and
 * the per-request logger and the operator's error line bind the trace's `trace_id` and `span_id`,
 * so a log line, a digest and a trace join. The request id and the trace id stay distinct, whatever
 * the inbound headers say. With telemetry off, `requestId` and the logger behave as they always did.
 */
import { describe, expect, it } from "vitest"
import { requestId } from "../../../src/middleware/request-id.ts"
import { honey } from "../../../src/routing/app.ts"
import { recorder } from "../../../src/telemetry/__fixtures__/recording-tracer.ts"
import { createLogger } from "../../../src/telemetry/logger.ts"

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
const INBOUND = "0af7651916cd43dd8448eb211c80319c"

const get = (path: string, init: RequestInit = {}) => new Request(`http://app.test${path}`, init)

function logged() {
	const lines: Record<string, unknown>[] = []
	const logger = createLogger({
		format: "json",
		level: "info",
		write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
	})
	return { lines, logger }
}

describe("correlation with telemetry on", () => {
	it("requestId names the root; ctx.log binds the root's trace and span ids; the two ids stay distinct", async () => {
		const { lines, logger } = logged()
		const { spans, telemetry } = recorder()
		const app = honey<{}>().logger(logger).telemetry(telemetry)
		app
			.use(requestId())
			.get("/a")
			.handler((ctx) => {
				ctx.log.info("handling")
				return ctx.res.text("ok", ctx.requestId)
			})
		const res = await app.fetch(get("/a"), {})
		const id = await res.text()
		const line = lines.find((l) => l.msg === "handling") as Record<string, unknown>
		const root = spans[0]
		expect([root?.attributes["honey.request_id"], line.requestId, line.trace_id, line.span_id, id === TRACE]).toEqual([
			id,
			id,
			TRACE,
			root?.spanContext().spanId,
			false,
		])
	})

	it("the operator's unhandled-error line carries the digest and the trace", async () => {
		const { lines, logger } = logged()
		const { spans, telemetry } = recorder()
		const app = honey<{}>().logger(logger).telemetry(telemetry)
		app.get("/boom").handler(() => {
			throw new Error("db down")
		})
		const body = (await (await app.fetch(get("/boom"), {})).json()) as { digest: string }
		const line = lines.find((l) => l.msg === "unhandled error") as Record<string, unknown>
		expect([line.digest, line.trace_id, line.span_id]).toEqual([body.digest, TRACE, spans[0]?.spanContext().spanId])
	})
})

describe("correlation with telemetry on: what never changes", () => {
	it("an inbound traceparent never becomes the request id, trusted or not", async () => {
		const traceparent = `00-${INBOUND}-b7ad6b7169203331-01`
		for (const trustInbound of [false, true]) {
			const { spans, telemetry } = recorder()
			const app = honey<{}>().telemetry({ ...telemetry, trustInbound })
			app
				.use(requestId())
				.get("/a")
				.handler((ctx) => ctx.res.text("ok", ctx.requestId))
			const id = await (await app.fetch(get("/a", { headers: { traceparent } }), {})).text()
			expect([id.includes(INBOUND), spans[0]?.attributes["honey.request_id"]]).toEqual([false, id])
		}
	})

	it("a sampled-out root names nothing, and the log still binds its ids", async () => {
		const { lines, logger } = logged()
		const { spans, telemetry } = recorder({ recording: false })
		const app = honey<{}>().logger(logger).telemetry(telemetry)
		app
			.use(requestId())
			.get("/a")
			.handler((ctx) => {
				ctx.log.info("handling")
				return ctx.res.text("ok", "a")
			})
		await app.fetch(get("/a"), {})
		const line = lines.find((l) => l.msg === "handling") as Record<string, unknown>
		expect(["honey.request_id" in (spans[0]?.attributes ?? {}), line.trace_id]).toEqual([false, TRACE])
	})
})

describe("correlation with telemetry off", () => {
	it("requestId and ctx.log as ever: the request id bound, no trace fields", async () => {
		const { lines, logger } = logged()
		const app = honey<{}>().logger(logger)
		app
			.use(requestId())
			.get("/a")
			.handler((ctx) => {
				ctx.log.info("handling")
				return ctx.res.text("ok", ctx.requestId)
			})
		const id = await (
			await app.fetch(get("/a", { headers: { traceparent: `00-${INBOUND}-b7ad6b7169203331-01` } }), {})
		).text()
		const line = lines.find((l) => l.msg === "handling") as Record<string, unknown>
		expect([line.requestId, "trace_id" in line, "span_id" in line]).toEqual([id, false, false])
	})
})
