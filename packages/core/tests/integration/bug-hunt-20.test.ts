import { describe, expect, it } from "vitest"
import { HoneyError } from "../../src/error.ts"
import { honey } from "../../src/index.ts"
import { createMiddleware } from "../../src/middleware.ts"
import { otelAdapter } from "../../src/telemetry/otel.ts"

/* ══════════════════════════════════════════════
 * 1. OTEL ADAPTER — basic span creation
 *
 * telemetry/otel.ts — zero prior coverage.
 * Uses WeakMap<Request, Span> to track per-request spans.
 * ══════════════════════════════════════════════ */

function mockTracer() {
	const spans: Array<{
		attributes: Record<string, unknown>
		ended: boolean
		events: Array<{ attributes?: Record<string, unknown>; name: string }>
		name: string
	}> = []

	return {
		spans,
		startSpan(name: string) {
			const span = {
				addEvent(evtName: string, attrs?: Record<string, unknown>) {
					span.events.push({ attributes: attrs, name: evtName })
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
}

describe("bug-hunt-20: otelAdapter — span lifecycle", () => {
	it("successful request → request span created and ended", async () => {
		const tracer = mockTracer()
		const adapter = otelAdapter({ tracer })

		const app = honey<{}>()
		app.telemetry(adapter)
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		await app.fetch(new Request("http://localhost/api"), {})

		/* should have: http.request, http.handler, + http.request span ended in onResponse */
		const requestSpan = tracer.spans.find((s) => s.name === "http.request")
		expect(requestSpan).toBeTruthy()
		expect(requestSpan?.attributes["http.url"]).toBe("http://localhost/api")
		expect(requestSpan?.ended).toBe(true)

		/* handler span */
		const handlerSpan = tracer.spans.find((s) => s.name === "http.handler")
		expect(handlerSpan).toBeTruthy()
		expect(handlerSpan?.attributes["http.status_code"]).toBe(200)
		expect(handlerSpan?.ended).toBe(true)
	})

	it("request span has status code and duration", async () => {
		const tracer = mockTracer()
		const adapter = otelAdapter({ tracer })

		const app = honey<{}>()
		app.telemetry(adapter)
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		await app.fetch(new Request("http://localhost/api"), {})

		const requestSpan = tracer.spans.find((s) => s.name === "http.request")
		expect(requestSpan?.attributes["http.status_code"]).toBe(200)
		expect(requestSpan?.attributes["http.duration_ms"]).toBeGreaterThan(0)
	})
})

describe("bug-hunt-20: otelAdapter — route info", () => {
	it("onRoute sets method and route on request span", async () => {
		const tracer = mockTracer()
		const adapter = otelAdapter({ tracer })

		const app = honey<{}>()
		app.telemetry(adapter)
		app.get("/users/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

		await app.fetch(new Request("http://localhost/users/42"), {})

		const requestSpan = tracer.spans.find((s) => s.name === "http.request")
		expect(requestSpan?.attributes["http.method"]).toBe("GET")
		expect(requestSpan?.attributes["http.route"]).toBe("/users/42")
	})
})

describe("bug-hunt-20: otelAdapter — error span", () => {
	it("handler error → error span created", async () => {
		const tracer = mockTracer()
		const adapter = otelAdapter({ tracer })

		const app = honey<{}>()
		app.telemetry(adapter)
		app.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "test_error", status: "bad_request" })
		})

		await app.fetch(new Request("http://localhost/fail"), {})

		const errorSpan = tracer.spans.find((s) => s.name === "http.error")
		expect(errorSpan).toBeTruthy()
		expect(errorSpan?.attributes["error.key"]).toBe("test_error")
		expect(errorSpan?.attributes["error.status"]).toBe(400)
		expect(errorSpan?.ended).toBe(true)
	})
})

describe("bug-hunt-20: otelAdapter — 404 event", () => {
	it("404 → not_found event on request span", async () => {
		const tracer = mockTracer()
		const adapter = otelAdapter({ tracer })

		const app = honey<{}>()
		app.telemetry(adapter)
		app.get("/exists").handler((ctx) => ctx.res.json("ok", {}))

		await app.fetch(new Request("http://localhost/nope"), {})

		const requestSpan = tracer.spans.find((s) => s.name === "http.request")
		expect(requestSpan).toBeTruthy()
		const notFoundEvent = requestSpan?.events.find((e) => e.name === "not_found")
		expect(notFoundEvent).toBeTruthy()
		expect(notFoundEvent?.attributes?.["http.path"]).toBe("/nope")
	})
})

describe("bug-hunt-20: otelAdapter — 405 event", () => {
	it("405 → method_not_allowed event on request span", async () => {
		const tracer = mockTracer()
		const adapter = otelAdapter({ tracer })

		const app = honey<{}>()
		app.telemetry(adapter)
		app.get("/resource").handler((ctx) => ctx.res.json("ok", {}))

		await app.fetch(new Request("http://localhost/resource", { method: "DELETE" }), {})

		const requestSpan = tracer.spans.find((s) => s.name === "http.request")
		const mnaEvent = requestSpan?.events.find((e) => e.name === "method_not_allowed")
		expect(mnaEvent).toBeTruthy()
		expect(mnaEvent?.attributes?.["http.allowed_methods"]).toContain("GET")
	})
})

describe("bug-hunt-20: otelAdapter — middleware span", () => {
	it("middleware → middleware span with name and duration", async () => {
		const tracer = mockTracer()
		const adapter = otelAdapter({ tracer })

		const authMw = createMiddleware(async (_ctx, next) => next())
		Object.defineProperty(authMw, "name", { value: "authMiddleware" })

		const app = honey<{}>()
		app.telemetry(adapter)
		app
			.get("/api")
			.use(authMw)
			.handler((ctx) => ctx.res.json("ok", {}))

		await app.fetch(new Request("http://localhost/api"), {})

		const mwSpan = tracer.spans.find((s) => s.name === "middleware.authMiddleware")
		expect(mwSpan).toBeTruthy()
		expect(mwSpan?.attributes["middleware.name"]).toBe("authMiddleware")
		expect(mwSpan?.ended).toBe(true)
	})

	it("middleware error → error event on middleware span", async () => {
		const tracer = mockTracer()
		const adapter = otelAdapter({ tracer })

		const badMw = createMiddleware(async () => {
			throw new HoneyError({ errorKey: "mw_fail", status: "bad_request" })
		})
		Object.defineProperty(badMw, "name", { value: "badMw" })

		const app = honey<{}>()
		app.telemetry(adapter)
		app
			.get("/api")
			.use(badMw)
			.handler((ctx) => ctx.res.json("ok", {}))

		await app.fetch(new Request("http://localhost/api"), {})

		const mwSpan = tracer.spans.find((s) => s.name === "middleware.badMw")
		expect(mwSpan).toBeTruthy()
		const errorEvent = mwSpan?.events.find((e) => e.name === "error")
		expect(errorEvent).toBeTruthy()
	})
})

describe("bug-hunt-20: otelAdapter — tracer that throws", () => {
	it("tracer.startSpan throws → request still succeeds", async () => {
		const throwingTracer = {
			startSpan() {
				throw new Error("tracer broken")
			},
		}
		const adapter = otelAdapter({ tracer: throwingTracer })

		const app = honey<{}>()
		app.telemetry(adapter)
		app.get("/api").handler((ctx) => ctx.res.json("ok", { works: true }))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
	})
})

describe("bug-hunt-20: otelAdapter — concurrent requests", () => {
	it("each request gets its own span via WeakMap", async () => {
		const tracer = mockTracer()
		const adapter = otelAdapter({ tracer })

		const app = honey<{}>()
		app.telemetry(adapter)
		app.get("/api/:id").handler(async (ctx) => {
			await new Promise((r) => setTimeout(r, Math.random() * 10))
			return ctx.res.json("ok", { id: ctx.params.id })
		})

		await Promise.all([
			app.fetch(new Request("http://localhost/api/1"), {}),
			app.fetch(new Request("http://localhost/api/2"), {}),
			app.fetch(new Request("http://localhost/api/3"), {}),
		])

		/* should have 3 http.request spans, each ended */
		const requestSpans = tracer.spans.filter((s) => s.name === "http.request")
		expect(requestSpans.length).toBe(3)
		for (const span of requestSpans) {
			expect(span.ended).toBe(true)
		}
	})
})

describe("bug-hunt-20: otelAdapter — span cleanup", () => {
	it("WeakMap entry removed after onResponse", async () => {
		const tracer = mockTracer()
		const adapter = otelAdapter({ tracer })

		const app = honey<{}>()
		app.telemetry(adapter)
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		/* run request */
		await app.fetch(new Request("http://localhost/api"), {})

		/* all spans should be ended (and WeakMap should have cleaned up,
		 * but we can't directly test WeakMap — we verify spans are ended) */
		const requestSpans = tracer.spans.filter((s) => s.name === "http.request")
		expect(requestSpans.length).toBe(1)
		expect(requestSpans[0].ended).toBe(true)
	})
})
