/**
 * The core tracing seam through app.fetch, against a recording tracer: the `{method} {route}` root
 * started before routing, the onion of `middleware.<name>` and `http.handler` spans under it, the
 * root ending exactly once on every exit, `http.error` under the span an error surfaced in, the
 * trust-gated inbound trace, a tracer that throws, and nothing built when the root is not recording.
 */
import { describe, expect, it, vi } from "vitest"
import { HoneyError } from "../errors/error.ts"
import { createMiddleware, namedMiddleware } from "../middleware/middleware.ts"
import { honey } from "../routing/app.ts"
import { createLogger } from "./logger.ts"
import { type Recorded, recorder, rootOf, tree } from "./__fixtures__/recording-tracer.ts"
import type { Telemetry } from "./request-trace.ts"

const get = (path: string, init: RequestInit = {}) => new Request(`http://app.test${path}`, init)

function named(name: string, after?: () => void) {
	return namedMiddleware(
		name,
		createMiddleware(async (_ctx, next) => {
			const res = await next()
			after?.()
			return res
		}),
	)
}

describe("the root: started before routing, named by its route", () => {
	// v0: f2702568f0
	// v0: 3ce3c3c2ba
	// v0: 72435bd22c
	// v0: c682b31529
	// v0: b55aee4993
	// v0: db9ab43b5a
	// v0: ec56469bd6
	// v0: c586788f1f
	// v0: 70785bd2c3
	it("a SERVER span, renamed `{method} {route}` once routed, with the pattern, the id and the status", async () => {
		const { spans, telemetry } = recorder()
		const app = honey<{}>().telemetry(telemetry)
		app.get("/users/:id").handler((ctx) => ctx.res.text("ok", ctx.params.id))
		await app.fetch(get("/users/42"), {})
		const [root] = spans
		expect([root?.name, root?.kind, root?.parent, root?.attributes, root?.ended, root?.status]).toEqual([
			"GET /users/:id",
			"server",
			null,
			{
				"honey.route_id": "GET /users/:id",
				"http.request.method": "GET",
				"http.response.body.size": 2,
				"http.response.status_code": 200,
				"http.route": "/users/:id",
				"url.path": "/users/42",
			},
			1,
			undefined,
		])
	})

	// v0: 9426720329
	// v0: 663d9be257
	it("never records the query, or the raw path as the route", async () => {
		const { spans, telemetry } = recorder()
		const app = honey<{}>().telemetry(telemetry)
		app.get("/users/:id").handler((ctx) => ctx.res.text("ok", "u"))
		await app.fetch(get("/users/42?apikey=SECRET#frag"), {})
		const values = spans.flatMap((s) => [s.name, ...Object.values(s.attributes).map(String)])
		expect([values.some((v) => v.includes("SECRET")), spans[0]?.attributes["http.route"]]).toEqual([
			false,
			"/users/:id",
		])
	})

	it("a request no route serves keeps the method alone as its name, with no route", async () => {
		const { spans, telemetry } = recorder()
		const app = honey<{}>().telemetry(telemetry)
		app.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		await app.fetch(get("/nope"), {})
		expect([spans[0]?.name, "http.route" in (spans[0]?.attributes ?? {})]).toEqual(["GET", false])
	})
})

describe("the onion: each span under the one that called it", () => {
	// v0: bc5fb34ec9
	// v0: b7062b4bc4
	// v0: d0f80925e9
	// v0: 9765dbc50a
	// v0: 9618a58ac7
	// v0: 026f76b5a4
	// v0: 2bf0a86e51
	// v0: f22b61a8af
	it("middleware.<name> nests the next one, http.handler the innermost; anonymous middleware says so", async () => {
		const { spans, telemetry } = recorder()
		const app = honey<{}>().telemetry(telemetry)
		app
			.use(named("auth"))
			.use(createMiddleware((_ctx, next) => next()))
			.get("/a")
			.handler((ctx) => ctx.res.text("ok", "a"))
		await app.fetch(get("/a"), {})
		expect(tree(spans)).toEqual([
			"- > GET /a",
			"GET /a > middleware.auth",
			"middleware.auth > middleware.anonymous",
			"middleware.anonymous > http.handler",
		])
		expect(spans.map((s) => [s.kind, s.ended])).toEqual([
			["server", 1],
			["internal", 1],
			["internal", 1],
			["internal", 1],
		])
	})

	it("a middleware's work after next() is inside its span: it ends after the handler's", async () => {
		const { spans, telemetry } = recorder()
		const order: string[] = []
		const app = honey<{}>().telemetry(telemetry)
		app
			.use(
				named("compressish", () => order.push(`after next, handler ended ${spans[2]?.ended}, own ${spans[1]?.ended}`)),
			)
			.get("/a")
			.handler((ctx) => ctx.res.text("ok", "a"))
		await app.fetch(get("/a"), {})
		expect(order).toEqual(["after next, handler ended 1, own 0"])
	})
})

describe("the onion: one per request", () => {
	// v0: a40a735c7f
	it("two requests in flight at once each keep their own tree", async () => {
		const { spans, telemetry } = recorder()
		const app = honey<{}>().telemetry(telemetry)
		let release: (() => void) | undefined
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		const traced = app.use(named("mw"))
		traced.get("/slow").handler(async (ctx) => {
			await held
			return ctx.res.text("ok", "slow")
		})
		traced.get("/fast").handler((ctx) => ctx.res.text("ok", "fast"))
		const slow = app.fetch(get("/slow"), {})
		await app.fetch(get("/fast"), {})
		release?.()
		await slow
		const byRoot = (root: string) => tree(spans.filter((s) => rootOf(s)?.name === root))
		expect([byRoot("GET /slow"), byRoot("GET /fast")]).toEqual([
			["- > GET /slow", "GET /slow > middleware.mw", "middleware.mw > http.handler"],
			["- > GET /fast", "GET /fast > middleware.mw", "middleware.mw > http.handler"],
		])
	})
})

describe("errors: http.error under the span the error surfaced in", () => {
	// v0: 316fbfc18b
	// v0: 6c64695b87
	// v0: 1492812edb
	it("a handler throw: http.handler fails, http.error under it, the root ERROR on the 5xx; no message, no stack", async () => {
		const { spans, telemetry } = recorder()
		const app = honey<{}>()
			.telemetry(telemetry)
			.logger(createLogger({ level: "silent" }))
		app.get("/boom").handler(() => {
			throw new TypeError("secret detail of user input")
		})
		await app.fetch(get("/boom"), {})
		const [root, handler, error] = spans
		expect(tree(spans)).toEqual(["- > GET /boom", "GET /boom > http.handler", "http.handler > http.error"])
		expect([root?.status, handler?.status, handler?.attributes["exception.type"], error?.attributes]).toEqual([
			2,
			2,
			"TypeError",
			{
				"exception.type": "TypeError",
				"honey.digest": expect.stringMatching(/^[0-9a-f]{16}$/),
				"honey.error_key": "internal_server_error",
				"http.response.status_code": 500,
			},
		])
		const text = JSON.stringify(spans.map((s) => [s.name, s.attributes, s.events]))
		expect([text.includes("secret detail"), text.includes("at ")]).toEqual([false, false])
	})
})

describe("errors: a middleware failing after next()", () => {
	// v0: 429a34f9ef
	// v0: bcbab8eab3
	// v0: 7b7978588c
	// v0: 9ee97f7238
	it("a middleware throwing after next(): its own span fails and holds the http.error", async () => {
		const { spans, telemetry } = recorder()
		const app = honey<{}>().telemetry(telemetry)
		app
			.use(
				namedMiddleware(
					"after",
					createMiddleware(async (_ctx, next) => {
						await next()
						throw new HoneyError({ errorKey: "teapot", status: "im_a_teapot" })
					}),
				),
			)
			.get("/a")
			.handler((ctx) => ctx.res.text("ok", "a"))
		const res = await app.fetch(get("/a"), {})
		expect([res.status, tree(spans), spans[1]?.status, spans[0]?.status]).toEqual([
			418,
			["- > GET /a", "GET /a > middleware.after", "middleware.after > http.handler", "middleware.after > http.error"],
			2,
			undefined,
		])
		expect(spans[3]?.attributes).toEqual({
			"exception.type": "HoneyError",
			"honey.error_key": "teapot",
			"http.response.status_code": 418,
		})
	})
})

describe("errors: what the span says", () => {
	it.each([
		["a thrown string is its type", "string"],
		["an anonymous Error subclass is Error", "Error"],
	])("%s", async (_name, type) => {
		const { spans, telemetry } = recorder()
		const app = honey<{}>().telemetry(telemetry).logger(false)
		app.get("/x").handler(() => {
			throw type === "string" ? "plain" : new (class extends Error {})()
		})
		await app.fetch(get("/x"), {})
		expect(spans.find((s) => s.name === "http.error")?.attributes["exception.type"]).toBe(type)
	})

	it("a handler that answered nothing: http.error under the span it returned to", async () => {
		const { spans, telemetry } = recorder()
		const app = honey<{}>().telemetry(telemetry).logger(false)
		app.get("/x").handler((() => undefined) as never)
		await app.fetch(get("/x"), {})
		expect(tree(spans)).toEqual(["- > GET /x", "GET /x > http.handler", "GET /x > http.error"])
	})
})

describe("telemetry.onError: a reporter, never in the answer's way", () => {
	// v0: bd5ec0319d
	// v0: 490363d09b
	it("hears every thrown error once the answer is decided, beside app.onError shaping it", async () => {
		const { spans, telemetry } = recorder()
		const reports: Record<string, unknown>[] = []
		const thrown = new Error("db down")
		const app = honey<{}>()
			.telemetry({ ...telemetry, onError: (report) => void reports.push({ ...report }) })
			.onError(async () => new Response("mapped", { status: 503 }))
		app
			.use(
				namedMiddleware(
					"db",
					createMiddleware(() => {
						throw thrown
					}),
				),
			)
			.get("/a")
			.handler((ctx) => ctx.res.text("ok", "a"))
		const res = await app.fetch(get("/a?token=x"), {})
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect([res.status, await res.text()]).toEqual([503, "mapped"])
		expect(reports).toEqual([
			{
				durationMs: expect.any(Number),
				error: thrown,
				honeyError: expect.any(HoneyError),
				method: "GET",
				path: "/a",
				routeId: "GET /a",
				spanId: (spans[0] as Recorded).spanContext().spanId,
				traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
			},
		])
		expect((reports[0] as { honeyError: HoneyError }).honeyError.status).toBe(500)
	})
})

describe("telemetry.onError: the ids and digest it carries", () => {
	it("an unknown 5xx's report carries the digest the client got", async () => {
		const { telemetry } = recorder()
		const reports: Record<string, unknown>[] = []
		const app = honey<{}>()
			.logger(false)
			.telemetry({ ...telemetry, onError: (report) => void reports.push({ ...report }) })
		app.get("/x").handler(() => {
			throw new Error("boom")
		})
		const body = (await (await app.fetch(get("/x"), {})).json()) as { digest: string }
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(reports[0]?.digest).toBe(body.digest)
	})

	it.each([
		["a root the tracer failed to start", "startSpan"],
		["a root whose ids cannot be read", "spanContext"],
	])("%s: the report has no trace or span id", async (_name, broken) => {
		const { telemetry } = recorder()
		const reports: Record<string, unknown>[] = []
		const tracer: Telemetry["tracer"] = {
			startSpan(name, options) {
				if (broken === "startSpan") throw new Error("tracer down")
				return Object.assign(telemetry.tracer.startSpan(name, options), {
					spanContext: () => {
						throw new Error("tracer down")
					},
				})
			},
		}
		const app = honey<{}>()
			.logger(false)
			.telemetry({ onError: (report) => void reports.push({ ...report }), tracer, trustInbound: false })
		app.get("/x").handler(() => {
			throw new Error("boom")
		})
		await app.fetch(get("/x"), {})
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect([reports.length, "traceId" in (reports[0] ?? {}), "spanId" in (reports[0] ?? {})]).toEqual([1, false, false])
	})
})

describe("telemetry.onError: a reporter that fails", () => {
	// v0: d02531787a
	it("a reporter that never settles, throws or rejects delays nothing, and is a warn", async () => {
		const lines: Record<string, unknown>[] = []
		const logger = createLogger({
			format: "json",
			level: "info",
			write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
		})
		for (const onError of [
			() => new Promise(() => {}),
			() => Promise.reject(new Error("sink down")),
			() => {
				throw new Error("sink broke")
			},
		]) {
			const { telemetry } = recorder()
			const app = honey<{}>()
				.logger(logger)
				.telemetry({ ...telemetry, onError })
			app.get("/boom").handler(() => {
				throw new HoneyError({ errorKey: "gone", status: "gone" })
			})
			expect((await app.fetch(get("/boom"), {})).status).toBe(410)
		}
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(
			lines.filter((l) => l.msg === "telemetry onError failed").map((l) => [l.level, (l.err as Error).message]),
		).toEqual([
			[40, "sink down"],
			[40, "sink broke"],
		])
	})
})

describe("a tracer that throws never touches the answer", () => {
	// v0: 590b42168b
	// v0: 0024bb60e2
	// v0: a610edede8
	// v0: f1546ee38c
	// v0: 49b1cba0f8
	// v0: 841ce5eb49
	it.each([
		["startSpan", "startSpan"],
		["a child's startSpan", "child"],
		["setAttribute", "setAttribute"],
		["end", "end"],
		["updateName", "updateName"],
	] as const)("%s throwing: the answer is unchanged and the failure is a warn", async (_name, method) => {
		const lines: Record<string, unknown>[] = []
		const logger = createLogger({
			format: "json",
			level: "info",
			write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
		})
		const { telemetry } = recorder()
		const broken: Telemetry = {
			...telemetry,
			tracer: {
				startSpan(name, options) {
					if (method === "startSpan" || (method === "child" && options.kind !== "server")) {
						throw new Error("tracer down")
					}
					const span = telemetry.tracer.startSpan(name, options)
					return Object.assign(span, {
						[method]: () => {
							throw new Error("tracer down")
						},
					})
				},
			},
		}
		const app = honey<{}>().logger(logger).telemetry(broken)
		app
			.use(named("mw"))
			.get("/a")
			.handler((ctx) => ctx.res.text("ok", "a"))
		const res = await app.fetch(get("/a"), {})
		expect([res.status, await res.text()]).toEqual([200, "a"])
		const warns = lines.filter((l) => l.msg === "telemetry failed")
		expect([
			warns.length > 0,
			warns.every((l) => l.level === 40 && (l.err as Error).message === "tracer down"),
		]).toEqual([true, true])
	})
})

describe("nothing is built when nothing records", () => {
	it("a sampled-out root: no child spans, no attributes set after it started, no events", async () => {
		const { spans, telemetry } = recorder({ recording: false })
		const app = honey<{}>().telemetry(telemetry)
		const traced = app.use(named("mw"))
		traced.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		traced.get("/boom").handler(() => {
			throw new Error("boom")
		})
		await app.fetch(get("/a"), {})
		await app.fetch(get("/missing"), {})
		await app.logger(false).fetch(get("/boom"), {})
		expect(spans.map((s) => [s.name, Object.keys(s.attributes), s.events, s.ended])).toEqual([
			["GET", ["http.request.method", "url.path"], [], 1],
			["GET", ["http.request.method", "url.path"], [], 1],
			["GET", ["http.request.method", "url.path"], [], 1],
		])
	})

	// v0: ab25e9df7e
	it("a mocked performance.now changes nothing about the spans", async () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(Number.NaN)
		const { spans, telemetry } = recorder()
		const app = honey<{}>().telemetry(telemetry)
		app.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		await app.fetch(get("/a"), {})
		now.mockRestore()
		expect(spans.map((s) => [s.name, s.ended])).toEqual([
			["GET /a", 1],
			["http.handler", 1],
		])
	})

	it("app.telemetry() refuses a value that is not one", () => {
		expect(() => honey<{}>().telemetry({} as Telemetry)).toThrow(
			"app.telemetry(): pass otelAdapter(api) from @lovrozagar/honey/telemetry, or a value with a tracer",
		)
	})
})
