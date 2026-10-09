import { describe, expect, it } from "vitest"
import { cors } from "../../../src/cors.ts"
import { createMiddleware, honey } from "../../../src/index.ts"
import { otelAdapter } from "../../../src/telemetry/otel.ts"

type RecordedSpan = {
	attributes: Record<string, unknown>
	ended: number
	events: Array<{ attributes?: Record<string, unknown>; name: string }>
	name: string
}

function mockTracer() {
	const spans: RecordedSpan[] = []
	return {
		spans,
		startSpan(name: string) {
			const span: RecordedSpan & {
				addEvent(n: string, a?: Record<string, unknown>): void
				end(): void
				setAttribute(k: string, v: unknown): void
			} = {
				addEvent(n, a) {
					span.events.push({ attributes: a, name: n })
				},
				attributes: {},
				end() {
					span.ended++
				},
				ended: 0,
				events: [],
				name,
				setAttribute(k, v) {
					span.attributes[k] = v
				},
			}
			spans.push(span)
			return span
		},
	}
}

/** Count onRequest/onResponse pairs: every request that starts must end exactly once. */
function counting() {
	const calls = { request: 0, response: [] as number[] }
	return {
		adapter: {
			onRequest() {
				calls.request++
			},
			onResponse(ctx: { status: number }) {
				calls.response.push(ctx.status)
			},
		},
		calls,
	}
}

describe("telemetry: onResponse fires exactly once on every exit", () => {
	it("handler, 404, 405, 308, preflight, 426 and middleware short-circuit", async () => {
		const { adapter, calls } = counting()
		const app = honey()
			.telemetry(adapter)
			.trailingSlash("strip")
			.use(
				createMiddleware(async (ctx, next) => {
					if (ctx.req.headers.get("x-block") === "1") return new Response("no", { status: 403 })
					return next()
				}),
			)
		app.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		app.post("/p").handler((ctx) => ctx.res.text("ok", "p"))
		app
			.use("/c", cors({ origin: "https://x.example" }))
			.post("/c/x")
			.handler((ctx) => ctx.res.text("ok", "c"))
		app.ws("/sock").handler({})

		const cases: Array<[Request, number]> = [
			[new Request("http://h/a"), 200],
			[new Request("http://h/missing"), 404],
			[new Request("http://h/p"), 405],
			[new Request("http://h/a/"), 308],
			[
				new Request("http://h/c/x", {
					headers: { "access-control-request-method": "POST", origin: "https://x.example" },
					method: "OPTIONS",
				}),
				204,
			],
			[new Request("http://h/sock"), 426],
			[new Request("http://h/a", { headers: { "x-block": "1" } }), 403],
		]
		for (const [req, status] of cases) {
			const before = calls.response.length
			const res = await app.fetch(req)
			expect(res.status).toBe(status)
			expect(calls.response.length - before).toBe(1)
			expect(calls.response.at(-1)).toBe(status)
		}
		expect(calls.request).toBe(cases.length)
	})

	it("a handler error fires onResponse once with the error status", async () => {
		const { adapter, calls } = counting()
		const app = honey().telemetry(adapter)
		app.get("/boom").handler(() => {
			throw new Error("boom")
		})
		const res = await app.fetch(new Request("http://h/boom"))
		expect(res.status).toBe(500)
		expect(calls.response).toEqual([500])
	})
})

describe("otelAdapter on a real app", () => {
	it("ends the root span for a short-circuited preflight and a trailing-slash redirect", async () => {
		const tracer = mockTracer()
		const app = honey().telemetry(otelAdapter({ tracer })).trailingSlash("strip")
		app
			.use("/c", cors({ origin: "https://x.example" }))
			.post("/c/x")
			.handler((ctx) => ctx.res.text("ok", "c"))

		await app.fetch(
			new Request("http://h/c/x", {
				headers: { "access-control-request-method": "POST", origin: "https://x.example" },
				method: "OPTIONS",
			}),
		)
		await app.fetch(new Request("http://h/c/x/"))

		const roots = tracer.spans.filter((s) => s.name === "http.request")
		expect(roots).toHaveLength(2)
		for (const root of roots) expect(root.ended).toBe(1)
		expect(roots.map((r) => r.attributes["http.status_code"])).toEqual([204, 308])
	})

	it("http.route is the pattern on the root and handler spans", async () => {
		const tracer = mockTracer()
		const app = honey().telemetry(otelAdapter({ tracer }))
		app.get("/users/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))
		await app.fetch(new Request("http://h/users/42"))
		await app.fetch(new Request("http://h/users/43"))
		const routes = tracer.spans.map((s) => s.attributes["http.route"]).filter((r) => r !== undefined)
		expect(new Set(routes)).toEqual(new Set(["/users/:id"]))
	})

	it("never records the query string", async () => {
		const tracer = mockTracer()
		const app = honey().telemetry(otelAdapter({ tracer }))
		app.get("/cb").handler((ctx) => ctx.res.text("ok", "x"))
		await app.fetch(new Request("http://h/cb?access_token=secret&code=abc#frag"))
		const root = tracer.spans.find((s) => s.name === "http.request")
		expect(root?.attributes["http.url"]).toBe("http://h/cb")
		expect(root?.attributes["url.path"]).toBe("/cb")
		expect(JSON.stringify(tracer.spans)).not.toContain("secret")
	})
})
