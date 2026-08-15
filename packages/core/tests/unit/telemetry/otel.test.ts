import { describe, expect, it } from "vitest"
import { otelAdapter } from "../../../src/telemetry/otel.ts"

type Span = {
	addEvent(name: string, attrs?: Record<string, unknown>): void
	end(): void
	setAttribute(key: string, value: unknown): void
}

type Tracer = {
	startSpan(name: string): Span
}

function mockTracer() {
	const spans: Array<{
		attributes: Record<string, unknown>
		ended: boolean
		events: Array<{ attributes?: Record<string, unknown>; name: string }>
		name: string
	}> = []

	const tracer: Tracer & { spans: typeof spans } = {
		spans,
		startSpan(name: string): Span {
			const span = {
				addEvent(eventName: string, attrs?: Record<string, unknown>) {
					span.events.push({ attributes: attrs, name: eventName })
				},
				attributes: {} as Record<string, unknown>,
				end() {
					span.ended = true
				},
				ended: false,
				events: [] as Array<{ attributes?: Record<string, unknown>; name: string }>,
				name,
				setAttribute(key: string, value: unknown) {
					span.attributes[key] = value
				},
			}
			spans.push(span)
			return span
		},
	}

	return tracer
}

describe("otelAdapter", () => {
	it("onRequest starts root span", () => {
		const tracer = mockTracer()
		const adapter = otelAdapter({ tracer })
		adapter.onRequest?.({ env: {}, req: new Request("http://localhost/test") })
		expect(tracer.spans).toHaveLength(1)
		expect(tracer.spans[0].name).toBe("http.request")
	})

	it("onRoute adds attributes", () => {
		const tracer = mockTracer()
		const adapter = otelAdapter({ tracer })
		const req = new Request("http://localhost/test")
		adapter.onRequest?.({ env: {}, req })
		adapter.onRoute?.({
			method: "GET",
			params: { id: "1" },
			path: "/test",
			req,
		})
		expect(tracer.spans[0].attributes["http.method"]).toBe("GET")
		expect(tracer.spans[0].attributes["http.route"]).toBe("/test")
	})

	it("onHandler creates child span", () => {
		const tracer = mockTracer()
		const adapter = otelAdapter({ tracer })
		adapter.onRequest?.({ env: {}, req: new Request("http://localhost/test") })
		adapter.onHandler?.({ duration: 5, method: "GET", path: "/test", status: 200 })
		expect(tracer.spans.length).toBeGreaterThanOrEqual(2)
	})

	it("onError creates standalone error span", () => {
		const tracer = mockTracer()
		const adapter = otelAdapter({ tracer })
		adapter.onRequest?.({ env: {}, req: new Request("http://localhost/test") })
		const { HoneyError } = require("../../../src/error.ts")
		const err = new HoneyError({ errorKey: "test", status: "bad_request" })
		adapter.onError?.({ duration: 1, error: err, method: "GET", path: "/test" })
		const errorSpan = tracer.spans.find((s) => s.name === "http.error")
		expect(errorSpan).toBeDefined()
		expect(errorSpan?.attributes["error.key"]).toBe("test")
		expect(errorSpan?.ended).toBe(true)
	})

	it("onResponse ends root span", () => {
		const tracer = mockTracer()
		const adapter = otelAdapter({ tracer })
		const req = new Request("http://localhost/test")
		adapter.onRequest?.({ env: {}, req })
		adapter.onResponse?.({ duration: 10, req, status: 200 })
		expect(tracer.spans[0].ended).toBe(true)
	})

	it("onMiddleware creates child span with name and duration", () => {
		const tracer = mockTracer()
		const adapter = otelAdapter({ tracer })
		adapter.onMiddleware?.({ duration: 2.5, name: "authMiddleware" })
		const mwSpan = tracer.spans.find((s) => s.name === "middleware.authMiddleware")
		expect(mwSpan).toBeDefined()
		expect(mwSpan?.attributes["middleware.name"]).toBe("authMiddleware")
		expect(mwSpan?.attributes["middleware.duration_ms"]).toBe(2.5)
		expect(mwSpan?.ended).toBe(true)
	})

	it("onMiddleware records error event when middleware fails", () => {
		const tracer = mockTracer()
		const adapter = otelAdapter({ tracer })
		adapter.onMiddleware?.({ duration: 1, error: new Error("fail"), name: "broken" })
		const mwSpan = tracer.spans.find((s) => s.name === "middleware.broken")
		expect(mwSpan?.events.some((e) => e.name === "error")).toBe(true)
	})

	it("concurrent requests get independent spans", () => {
		const tracer = mockTracer()
		const adapter = otelAdapter({ tracer })

		/* simulate two concurrent requests */
		const req1 = new Request("http://localhost/a")
		const req2 = new Request("http://localhost/b")

		adapter.onRequest?.({ env: {}, req: req1 })
		adapter.onRequest?.({ env: {}, req: req2 })

		/* close req1 — should close req1's span, not req2's */
		adapter.onResponse?.({ duration: 10, req: req1, status: 200 })
		adapter.onResponse?.({ duration: 20, req: req2, status: 201 })

		/* both spans should be ended */
		const endedSpans = tracer.spans.filter((s) => s.ended && s.name === "http.request")
		expect(endedSpans).toHaveLength(2)

		/* each span should have its own status */
		const statuses = endedSpans.map((s) => s.attributes["http.status_code"])
		expect(statuses).toContain(200)
		expect(statuses).toContain(201)
	})

	it("fire-and-forget: adapter method that throws → swallowed", () => {
		const throwingTracer: Tracer = {
			startSpan: () => {
				throw new Error("boom")
			},
		}
		const adapter = otelAdapter({ tracer: throwingTracer })
		expect(() => adapter.onRequest?.({ env: {}, req: new Request("http://localhost/test") })).not.toThrow()
	})
})
