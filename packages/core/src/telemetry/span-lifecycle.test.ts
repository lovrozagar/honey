/**
 * When a request's root span ends: exactly once on every exit, when the answer's body ended or was
 * cancelled (never at the headers), at once for a body that is not a stream; and the one body
 * observer the request log and the root share.
 */
import { describe, expect, it, vi } from "vitest"
import { cors } from "../middleware/cors.ts"
import { createMiddleware, namedMiddleware } from "../middleware/middleware.ts"
import { honey } from "../routing/app.ts"
import { recorder } from "./__fixtures__/recording-tracer.ts"
import { createLogger } from "./logger.ts"
import { ws } from "../ws/route.ts"

const get = (path: string, init: RequestInit = {}) => new Request(`http://app.test${path}`, init)

function named(name: string) {
	return namedMiddleware(
		name,
		createMiddleware((_ctx, next) => next()),
	)
}

describe("the root ends exactly once, on every exit", () => {
	// v0: 75d1a25f98
	// v0: 5598f049d9
	// v0: 4d8a21f3b0
	// v0: 61b1f1d906
	// v0: ef3a64ae61
	// v0: 672a1487ea
	it("handler, 404, 405, 308, preflight, 426, short-circuit, a throw and a bad target", async () => {
		const { spans, telemetry } = recorder()
		const app = honey<{}>()
			.telemetry(telemetry)
			.trailingSlash("strip")
			.use(
				createMiddleware((ctx, next) =>
					ctx.req.headers.get("x-block") === "1" ? new Response("no", { status: 403 }) : next(),
				),
			)
		app.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		app.get("/boom").handler(() => {
			throw new Error("boom")
		})
		app.post("/p").handler((ctx) => ctx.res.text("ok", "p"))
		app
			.use("/c", cors({ origin: "https://x.example" }))
			.post("/c/x")
			.handler((ctx) => ctx.res.text("ok", "c"))
		ws(app, "/sock").handler({})
		const exits: [Request, number][] = [
			[get("/a"), 200],
			[get("/missing"), 404],
			[get("/p"), 405],
			[get("/a/"), 308],
			[
				get("/c/x", {
					headers: { "access-control-request-method": "POST", origin: "https://x.example" },
					method: "OPTIONS",
				}),
				204,
			],
			[get("/sock"), 426],
			[get("/a", { headers: { "x-block": "1" } }), 403],
			[get("/boom"), 500],
			[get("/%2F"), 400],
		]
		const statuses = []
		for (const [request] of exits) {
			const res = await app.fetch(request, {})
			/* the root ends with the body: read it */
			await res.text()
			statuses.push(res.status)
		}
		const roots = spans.filter((s) => s.kind === "server")
		expect([statuses, roots.map((r) => [r.attributes["http.response.status_code"], r.ended])]).toEqual([
			exits.map(([, status]) => status),
			exits.map(([, status]) => [status, 1]),
		])
		expect(spans.every((s) => s.ended === 1)).toBe(true)
	})
})

describe("the root on a miss", () => {
	// v0: 6ca7ca7409
	// v0: b836e55d92
	// v0: ab74f493d6
	// v0: 30f6103fee
	// v0: ff844f5914
	it("a 404 and a 405 are events on the root, the 405 naming what is allowed", async () => {
		const { spans, telemetry } = recorder()
		const app = honey<{}>().telemetry(telemetry)
		app.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		app.put("/a").handler((ctx) => ctx.res.text("ok", "a"))
		await app.fetch(get("/b"), {})
		await app.fetch(get("/a", { method: "DELETE" }), {})
		expect(spans.map((s) => s.events)).toEqual([
			[["not_found", undefined]],
			[["method_not_allowed", { "http.allowed_methods": "GET, PUT" }]],
		])
	})
})

describe("the root beside background work and scoped handles", () => {
	// v0: 4d57bcda37
	it("beside ctx.background on waitUntil: the background task reaches waitUntil and the root still ends", async () => {
		const { spans, telemetry } = recorder()
		const waitUntil = vi.fn()
		const app = honey<{}>().telemetry(telemetry)
		app.get("/bg").handler((ctx) => {
			ctx.background(Promise.resolve("done"))
			return ctx.res.text("ok", "bg")
		})
		await app.fetch(get("/bg"), {}, { waitUntil })
		expect([waitUntil.mock.calls.length, spans[0]?.ended]).toEqual([1, 1])
	})

	// v0: c62fe89aaa
	it("a handle from use() keeps the app's telemetry", async () => {
		const { spans, telemetry } = recorder()
		const scoped = honey<{}>().telemetry(telemetry).use(named("scoped"))
		scoped.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		await scoped.fetch(get("/a"), {})
		expect(spans.map((s) => s.name)).toEqual(["GET /a", "middleware.scoped", "http.handler"])
	})
})

/** A streamed body of `chunks`, counting how often it is pulled. */
function source(chunks: string[]) {
	const pulls = { count: 0 }
	const encoder = new TextEncoder()
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				pulls.count++
				const chunk = chunks.shift()
				if (chunk === undefined) controller.close()
				else controller.enqueue(encoder.encode(chunk))
			},
		},
		{ highWaterMark: 0 },
	)
	return { pulls, stream }
}

describe("the root ends with the body, not the headers", () => {
	it("a streamed body: open while it is read, ended with its size once read to the end", async () => {
		const { spans, telemetry } = recorder()
		const app = honey<{}>().telemetry(telemetry)
		app.get("/s").handler(() => new Response(source(["ab", "cde"]).stream) as never)
		const res = await app.fetch(get("/s"), {})
		const atHeaders = spans[0]?.ended
		await res.text()
		expect([
			atHeaders,
			spans[0]?.ended,
			spans[0]?.attributes["http.response.body.size"],
			spans[0]?.attributes["honey.outcome"],
		]).toEqual([0, 1, 5, undefined])
	})

	it("a cancelled body: the root ends aborted, its status left unset", async () => {
		const { spans, telemetry } = recorder()
		const app = honey<{}>().telemetry(telemetry)
		app.get("/s").handler(() => new Response(source(["ab", "cde"]).stream) as never)
		const res = await app.fetch(get("/s"), {})
		const reader = (res.body as ReadableStream<Uint8Array>).getReader()
		await reader.read()
		await reader.cancel("client left")
		expect([
			spans[0]?.ended,
			spans[0]?.attributes["honey.outcome"],
			spans[0]?.attributes["http.response.body.size"],
			spans[0]?.status,
		]).toEqual([1, "aborted", 2, undefined])
	})

	it.each([
		["a buffered body", "GET", (ctx: { res: { text(k: "ok", b: string): Response } }) => ctx.res.text("ok", "abc"), 3],
		["no body", "GET", () => new Response(null, { status: 204 }), undefined],
		["a HEAD", "HEAD", (ctx: { res: { text(k: "ok", b: string): Response } }) => ctx.res.text("ok", "abc"), undefined],
	])("%s ends it at once", async (_name, method, handler, size) => {
		const { spans, telemetry } = recorder()
		const app = honey<{}>().telemetry(telemetry)
		app.get("/x").handler(handler as never)
		await app.fetch(get("/x", { method }), {})
		expect([spans[0]?.ended, spans[0]?.attributes["http.response.body.size"]]).toEqual([1, size])
	})

	it("an upgrade (101) ends it at once", async () => {
		const { spans, telemetry } = recorder()
		const upgraded = new Response(null)
		Object.defineProperty(upgraded, "status", { value: 101 })
		const socket = { close() {}, raw: null, readyState: 1 as const, send() {} }
		const app = honey<{}>()
			.telemetry(telemetry)
			.wsAdapter({ upgrade: () => ({ response: upgraded, socket }) })
		ws(app, "/live").handler({})
		await app.fetch(get("/live", { headers: { connection: "Upgrade", upgrade: "websocket" } }), {})
		expect([spans[0]?.ended, spans[0]?.attributes["http.response.status_code"]]).toEqual([1, 101])
	})
})

describe("one body observer for the request log and the root", () => {
	it("both on: one pass-through, read only on demand; both hear the same end and bytes", async () => {
		const lines: Record<string, unknown>[] = []
		const logger = createLogger({
			format: "json",
			level: "info",
			write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
		})
		const pullsWith = async (configure: (app: ReturnType<typeof honey<{}>>) => void) => {
			const body = source(["ab", "cde"])
			const app = honey<{}>().logger(logger)
			configure(app)
			app.get("/s").handler(() => new Response(body.stream) as never)
			const reader = ((await app.fetch(get("/s"), {})).body as ReadableStream<Uint8Array>).getReader()
			await reader.read()
			const afterFirst = body.pulls.count
			while (!(await reader.read()).done) {
				/* drain */
			}
			return afterFirst
		}
		const { spans, telemetry } = recorder()
		const both = await pullsWith((app) => app.requestLog(true).telemetry(telemetry))
		const logOnly = await pullsWith((app) => app.requestLog(true))
		expect([both, logOnly]).toEqual([1, 1])
		expect([lines[0]?.bytes, spans[0]?.attributes["http.response.body.size"], spans[0]?.ended]).toEqual([5, 5, 1])
	})
})

describe("the root when routing itself throws", () => {
	it.each([
		["recording", true],
		["sampled out", false],
	])("%s: the root ends failed and the throw goes on", async (_name, recording) => {
		const { spans, telemetry } = recorder({ recording })
		/* a request log with nowhere to write cannot finalize: the first request throws */
		const app = honey<{}>().telemetry(telemetry).requestLog(true).logger(false)
		app.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		expect(() => app.fetch(get("/a"), {})).toThrow("requestLog() is on")
		expect([spans[0]?.ended, spans[0]?.status, spans[0]?.attributes["exception.type"]]).toEqual(
			recording ? [1, 2, "Error"] : [1, undefined, undefined],
		)
	})
})
