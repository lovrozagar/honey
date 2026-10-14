/**
 * otelAdapter against the real OpenTelemetry API and trace SDK (exact-pinned devDependencies): the
 * span tree a request exports, the handler's span active for the app's own instrumentation, the
 * inbound trace continued or only linked, errors, sampling out, and taps beside it all.
 */
import * as api from "@opentelemetry/api"
import {
	AlwaysOffSampler,
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
	type Sampler,
} from "@opentelemetry/sdk-trace-base"
import { afterEach, describe, expect, it } from "vitest"
import { createMiddleware, namedMiddleware } from "../middleware/middleware.ts"
import { honey } from "../routing/app.ts"
import { otelAdapter } from "./otel.ts"

/** A context manager over a plain stack: enough for the synchronous `with` the adapter's run() makes. */
function stackContextManager(): api.ContextManager {
	const stack: api.Context[] = []
	const manager: api.ContextManager = {
		active: () => stack.at(-1) ?? api.ROOT_CONTEXT,
		bind: (_context, target) => target,
		disable: () => manager,
		enable: () => manager,
		with(context, fn, thisArg, ...args) {
			stack.push(context)
			try {
				return fn.call(thisArg, ...args)
			} finally {
				stack.pop()
			}
		},
	}
	return manager
}

/** Register a provider exporting to memory, with `sampler` deciding. */
function exporting(sampler?: Sampler) {
	const exporter = new InMemorySpanExporter()
	const provider = new BasicTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
		...(sampler && { sampler }),
	})
	api.trace.setGlobalTracerProvider(provider)
	api.context.setGlobalContextManager(stackContextManager())
	return exporter
}

afterEach(() => {
	api.trace.disable()
	api.context.disable()
})

const get = (path: string, init: RequestInit = {}) => new Request(`http://app.test${path}`, init)

/** Each finished span as `parent name > name`, outermost first (the tree is a chain here). */
function tree(spans: readonly ReadableSpan[]): string[] {
	const byId = new Map(spans.map((s) => [s.spanContext().spanId, s]))
	const parentOf = (s: ReadableSpan) => byId.get(s.parentSpanContext?.spanId ?? "")
	const depth = (s: ReadableSpan): number => {
		const parent = parentOf(s)
		return parent === undefined ? 0 : 1 + depth(parent)
	}
	return [...spans].sort((a, b) => depth(a) - depth(b)).map((s) => `${parentOf(s)?.name ?? "-"} > ${s.name}`)
}

/** The request's SERVER root among the finished spans. */
function rootSpan(spans: readonly ReadableSpan[]): ReadableSpan {
	return spans.find((s) => s.kind === api.SpanKind.SERVER) as ReadableSpan
}

describe("otelAdapter: the tree a request exports", () => {
	// v0: 2bf0a86e51
	it("a SERVER root named by its route, middleware and handler INTERNAL spans under it, one trace", async () => {
		const exporter = exporting()
		const app = honey<{}>().telemetry(otelAdapter(api))
		app
			.use(
				namedMiddleware(
					"auth",
					createMiddleware((_ctx, next) => next()),
				),
			)
			.get("/users/:id")
			.handler((ctx) => ctx.res.text("ok", "u"))
		await (await app.fetch(get("/users/42?secret=1"), {})).text()
		const spans = exporter.getFinishedSpans()
		const root = rootSpan(spans)
		expect(tree(spans)).toEqual([
			"- > GET /users/:id",
			"GET /users/:id > middleware.auth",
			"middleware.auth > http.handler",
		])
		expect([
			new Set(spans.map((s) => s.spanContext().traceId)).size,
			spans.filter((s) => s.kind === api.SpanKind.INTERNAL).length,
			root.attributes,
			root.status.code,
		]).toEqual([
			1,
			2,
			{
				"honey.route_id": "GET /users/:id",
				"http.request.method": "GET",
				"http.response.body.size": 1,
				"http.response.status_code": 200,
				"http.route": "/users/:id",
				"url.path": "/users/42",
			},
			api.SpanStatusCode.UNSET,
		])
	})

	it("the handler's span is active inside it: the app's own spans nest under it", async () => {
		const exporter = exporting()
		const app = honey<{}>().telemetry(otelAdapter(api))
		app.get("/q").handler((ctx) => {
			api.trace.getTracer("app").startSpan("db.query").end()
			return ctx.res.text("ok", "q")
		})
		await (await app.fetch(get("/q"), {})).text()
		expect(tree(exporter.getFinishedSpans())).toEqual([
			"- > GET /q",
			"GET /q > http.handler",
			"http.handler > db.query",
		])
	})
})

describe("otelAdapter: errors, sampling and taps", () => {
	it("an error: the root ERROR on the 5xx, http.error under the handler, no exception event or message", async () => {
		const exporter = exporting()
		const app = honey<{}>().telemetry(otelAdapter(api)).logger(false)
		app.get("/boom").handler(() => {
			throw new RangeError("user said 42")
		})
		await (await app.fetch(get("/boom"), {})).text()
		const spans = exporter.getFinishedSpans()
		expect(tree(spans)).toEqual(["- > GET /boom", "GET /boom > http.handler", "http.handler > http.error"])
		const named = (name: string) => spans.find((s) => s.name === name) as ReadableSpan
		expect([named("GET /boom").status.code, named("http.handler").status.code, named("http.error").attributes]).toEqual(
			[
				api.SpanStatusCode.ERROR,
				api.SpanStatusCode.ERROR,
				{
					"exception.type": "RangeError",
					"honey.digest": expect.stringMatching(/^[0-9a-f]{16}$/),
					"honey.error_key": "internal_server_error",
					"http.response.status_code": 500,
				},
			],
		)
		expect(JSON.stringify(spans.map((s) => [s.attributes, s.events, s.status])).includes("user said")).toBe(false)
	})

	it("a sampler that drops the trace: nothing exported, the answer unchanged", async () => {
		const exporter = exporting(new AlwaysOffSampler())
		const app = honey<{}>().telemetry(otelAdapter(api))
		app
			.use(
				namedMiddleware(
					"mw",
					createMiddleware((_ctx, next) => next()),
				),
			)
			.get("/a")
			.handler((ctx) => ctx.res.text("ok", "a"))
		const res = await app.fetch(get("/a"), {})
		expect([res.status, await res.text(), exporter.getFinishedSpans()]).toEqual([200, "a", []])
	})

	// v0: 750eab7295
	it("taps fire beside the spans, and get none of their own", async () => {
		const exporter = exporting()
		const received: unknown[] = []
		const app = honey<{}>().telemetry(otelAdapter(api))
		app.tap("audit", (_ctx, payload) => void received.push(payload))
		app.get("/t").handler((ctx) => {
			ctx.tap("audit", { action: "read" })
			return ctx.res.text("ok", "t")
		})
		await (await app.fetch(get("/t"), {})).text()
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect([received, exporter.getFinishedSpans().map((s) => s.name)]).toEqual([
			[{ action: "read" }],
			["http.handler", "GET /t"],
		])
	})
})

describe("otelAdapter: the inbound trace", () => {
	const INBOUND_TRACE = "0af7651916cd43dd8448eb211c80319c"
	const headers = {
		traceparent: `00-${INBOUND_TRACE}-b7ad6b7169203331-01`,
		tracestate: "rojo=00f067aa0ba902b7,congo=t61",
	}

	it("trusted: the root continues it, as a remote parent with its tracestate", async () => {
		const exporter = exporting()
		const app = honey<{}>().telemetry(otelAdapter(api, { trustInbound: true }))
		app.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		await (await app.fetch(get("/a", { headers }), {})).text()
		const root = rootSpan(exporter.getFinishedSpans())
		const parent = root.parentSpanContext as api.SpanContext
		expect([
			root.spanContext().traceId,
			parent.spanId,
			parent.isRemote,
			parent.traceState?.serialize(),
			root.links,
		]).toEqual([INBOUND_TRACE, "b7ad6b7169203331", true, "rojo=00f067aa0ba902b7,congo=t61", []])
		expect(root.spanContext().traceState?.get("congo")).toBe("t61")
	})

	it("untrusted (the default): a new trace, linked to the inbound one", async () => {
		const exporter = exporting()
		const app = honey<{}>().telemetry(otelAdapter(api))
		app.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		await (await app.fetch(get("/a", { headers }), {})).text()
		const root = rootSpan(exporter.getFinishedSpans())
		expect([
			root.spanContext().traceId === INBOUND_TRACE,
			root.parentSpanContext,
			root.links.map((l) => [l.context.traceId, l.context.spanId, l.context.isRemote]),
		]).toEqual([false, undefined, [[INBOUND_TRACE, "b7ad6b7169203331", true]]])
	})
})

/** A reporter that hears nothing it keeps. */
function report(): void {}

describe("otelAdapter: the value", () => {
	it("frozen, untrusting and without a reporter by default; options carried as given", () => {
		const plain = otelAdapter(api)
		const configured = otelAdapter(api, { onError: report, trustInbound: true })
		expect([
			Object.isFrozen(plain),
			plain.trustInbound,
			plain.onError,
			configured.trustInbound,
			configured.onError,
		]).toEqual([true, false, null, true, report])
	})

	it("its tracestate edits like W3C says: a set key moves to the front, at most 32 members", async () => {
		const exporter = exporting()
		const app = honey<{}>().telemetry(otelAdapter(api, { trustInbound: true }))
		app.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		const members = Array.from({ length: 32 }, (_, i) => `k${i}=v${i}`).join(",")
		const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
		await (await app.fetch(get("/a", { headers: { traceparent, tracestate: members } }), {})).text()
		const state = rootSpan(exporter.getFinishedSpans()).parentSpanContext?.traceState as api.TraceState
		const added = state.set("new", "1")
		expect([
			added.serialize().split(",").length,
			added.serialize().startsWith("new=1,k0=v0"),
			added.get("k31"),
			state.set("k5", "x").serialize().startsWith("k5=x,k0=v0"),
			state.unset("k0").get("k0"),
			state.get("k1"),
		]).toEqual([32, true, undefined, true, undefined, "v1"])
	})
})
