/**
 * W3C trace context, level 1: which `traceparent` values parse, checked case by case and against
 * OpenTelemetry's reference propagator on the same inputs; which `tracestate` values survive; and
 * the trust gate deciding whether an inbound trace is continued, only linked, or ignored, alone and
 * through an app's root span.
 */
import { defaultTextMapGetter, ROOT_CONTEXT, trace } from "@opentelemetry/api"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { describe, expect, it, vi } from "vitest"
import { proxy } from "../proxy/proxy.ts"
import { honey } from "../routing/app.ts"
import { type Recorded, recorder } from "./__fixtures__/recording-tracer.ts"
import { createLogger } from "./logger.ts"
import { formatTraceparent, inboundTrace, parseTraceparent, parseTracestate } from "./traceparent.ts"

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
const SPAN = "00f067aa0ba902b7"
const VALID = `00-${TRACE}-${SPAN}-01`

/** What OpenTelemetry's W3C propagator makes of a header: the ids and flags, or null when it rejects it. */
function reference(header: string): { flags: number; spanId: string; traceId: string } | null {
	const extracted = new W3CTraceContextPropagator().extract(ROOT_CONTEXT, { traceparent: header }, defaultTextMapGetter)
	const context = trace.getSpanContext(extracted)
	if (context === undefined || !trace.isSpanContextValid(context)) return null
	return { flags: context.traceFlags, spanId: context.spanId, traceId: context.traceId }
}

/** [why, header, parses] — every row is also run through the reference propagator. */
const TRACEPARENTS: [string, string, boolean][] = [
	["version 00, sampled", VALID, true],
	["version 00, not sampled", `00-${TRACE}-${SPAN}-00`, true],
	["version 00, unknown flag bits kept", `00-${TRACE}-${SPAN}-09`, true],
	["a future version, exactly 55 chars", `cc-${TRACE}-${SPAN}-01`, true],
	["a future version with more fields after a dash", `cc-${TRACE}-${SPAN}-01-what-the-future-will-be`, true],
	["version ff is forbidden", `ff-${TRACE}-${SPAN}-01`, false],
	["version 00 with anything after the flags", `00-${TRACE}-${SPAN}-01-extra`, false],
	["a future version whose 56th char is not a dash", `cc-${TRACE}-${SPAN}-01x`, false],
	["shorter than 55 chars", `00-${TRACE}-${SPAN}-1`, false],
	["an all-zero trace id", `00-${"0".repeat(32)}-${SPAN}-01`, false],
	["an all-zero parent id", `00-${TRACE}-${"0".repeat(16)}-01`, false],
	["uppercase hex in the trace id", `00-${TRACE.toUpperCase()}-${SPAN}-01`, false],
	["uppercase hex in the version", `0A-${TRACE}-${SPAN}-01`, false],
	["a non-hex char in the parent id", `00-${TRACE}-00f067aa0ba902bz-01`, false],
	["a non-hex flag", `00-${TRACE}-${SPAN}-0g`, false],
	["a trace id one char short", `00-${TRACE.slice(1)}-${SPAN}-01`, false],
	["a parent id one char long", `00-${TRACE}-${SPAN}0-01`, false],
	["underscores for dashes", `00_${TRACE}_${SPAN}_01`, false],
	["two headers joined by a comma", `${VALID}, ${VALID}`, false],
	["empty", "", false],
]

describe("parseTraceparent: W3C level 1", () => {
	it.each(TRACEPARENTS)("%s", (_why, header, parses) => {
		const ids = { flags: Number.parseInt(header.slice(53, 55), 16), spanId: SPAN, traceId: TRACE }
		expect(parseTraceparent(header)).toEqual(parses ? ids : null)
	})

	it("agrees with OpenTelemetry's W3C propagator on every row", () => {
		const ours = TRACEPARENTS.map(([, header]) => parseTraceparent(header))
		expect(ours).toEqual(TRACEPARENTS.map(([, header]) => reference(header)))
	})

	it("agrees with it on every one-char edit of a valid header", () => {
		const alphabet = ["0", "1", "a", "f", "g", "A", "-", " ", "_"]
		const disagreements: string[] = []
		for (let i = 0; i < VALID.length; i++) {
			for (const char of alphabet) {
				const header = VALID.slice(0, i) + char + VALID.slice(i + 1)
				/* Headers.get trims; a padded value never reaches the parser, so neither side sees one */
				if (header.trim() !== header) continue
				if (JSON.stringify(parseTraceparent(header)) !== JSON.stringify(reference(header))) disagreements.push(header)
			}
		}
		expect(disagreements).toEqual([])
	})

	it("null for a missing header", () => {
		expect(parseTraceparent(null)).toBeNull()
	})
})

describe("formatTraceparent", () => {
	it("writes version 00 with two-digit flags, and parses back", () => {
		const ids = { flags: 1, spanId: SPAN, traceId: TRACE }
		expect([formatTraceparent(ids), parseTraceparent(formatTraceparent(ids))]).toEqual([VALID, ids])
		expect(formatTraceparent({ ...ids, flags: 0 })).toBe(`00-${TRACE}-${SPAN}-00`)
	})
})

/** A tracestate of `n` distinct members. */
function members(n: number): string {
	return Array.from({ length: n }, (_, i) => `k${i}=v${i}`).join(",")
}

describe("parseTracestate: kept only when every member is valid and it fits", () => {
	it.each([
		["one vendor", "congo=t61rcWkgMzE", "congo=t61rcWkgMzE"],
		[
			"two vendors, optional whitespace and an empty member dropped",
			"rojo=00f067aa0ba902b7 , ,congo=t61rcWkgMzE",
			"rojo=00f067aa0ba902b7,congo=t61rcWkgMzE",
		],
		[
			"a multi-tenant key",
			"fw529a3039@dt=d4cda95b652f4a1592b449d5929fda1b",
			"fw529a3039@dt=d4cda95b652f4a1592b449d5929fda1b",
		],
		["exactly 32 members", members(32), members(32)],
	])("%s", (_why, header, kept) => {
		expect(parseTracestate(header)).toBe(kept)
	})

	it.each([
		["33 members", members(33)],
		["longer than 512 chars", `a=${"x".repeat(256)},b=${"y".repeat(256)}`],
		["an uppercase key", "Congo=t61"],
		["a key starting with a digit, without a tenant", "1congo=t61"],
		["a value with an equals sign", "congo=t6=1"],
		["a control char in the value", "congo=t\u000161"],
		["a member without a value", "congo"],
		["the same key twice", "congo=a,congo=b"],
		["a value longer than 256 chars", `congo=${"x".repeat(257)}`],
		["nothing but separators", " , ,"],
	])("dropped: %s", (_why, header) => {
		expect(parseTracestate(header)).toBeUndefined()
	})

	it("undefined for a missing header", () => {
		expect(parseTracestate(null)).toBeUndefined()
	})
})

const request = (headers: Record<string, string>) => new Request("http://app.test/", { headers })
const source = (headers: Record<string, string>, ip: string | null = "10.0.0.1") => ({ ip, req: request(headers) })

/** Trusts the gateway: its address, saying so. */
function gateway({ ip, req }: { readonly ip: string | null; readonly req: Request }): boolean {
	return ip === "10.0.0.1" && req.headers.get("x-gateway") === "yes"
}

describe("inboundTrace: the trust gate", () => {
	const warn = vi.fn()

	it("an untrusted hop's valid trace is only linked, its tracestate left behind", () => {
		expect(inboundTrace(source({ traceparent: VALID, tracestate: "congo=t61" }), false, warn)).toEqual({
			continued: false,
			remote: { flags: 1, spanId: SPAN, state: undefined, traceId: TRACE },
		})
	})

	it("a trusted hop's valid trace is continued with its tracestate", () => {
		expect(inboundTrace(source({ traceparent: VALID, tracestate: "congo=t61" }), true, warn)).toEqual({
			continued: true,
			remote: { flags: 1, spanId: SPAN, state: "congo=t61", traceId: TRACE },
		})
	})

	it("a predicate decides per request, from the peer and the request", () => {
		const continued = (headers: Record<string, string>, ip: string) =>
			inboundTrace(source({ traceparent: VALID, ...headers }, ip), gateway, warn)?.continued
		expect([
			continued({ "x-gateway": "yes" }, "10.0.0.1"),
			continued({}, "10.0.0.1"),
			continued({ "x-gateway": "yes" }, "10.0.0.2"),
		]).toEqual([true, false, false])
	})

	it("a malformed or missing traceparent is ignored, trusted or not, and the predicate never runs", () => {
		const predicate = vi.fn(() => true)
		expect([
			inboundTrace(source({ traceparent: `ff-${TRACE}-${SPAN}-01` }), true, warn),
			inboundTrace(source({ tracestate: "congo=t61" }), predicate, warn),
		]).toEqual([null, null])
		expect(predicate).not.toHaveBeenCalled()
	})

	it("a predicate that throws counts as untrusted, and says so", () => {
		const report = vi.fn()
		const boom = new Error("trust check broke")
		const decided = inboundTrace(
			source({ traceparent: VALID }),
			() => {
				throw boom
			},
			report,
		)
		expect([decided?.continued, report.mock.calls]).toEqual([false, [[boom]]])
	})
})

const get = (path: string, init: RequestInit = {}) => new Request(`http://app.test${path}`, init)

/** A trust predicate that fails. */
function brokenTrust(): boolean {
	throw new Error("trust check broke")
}

describe("the trust gate through an app: the root span", () => {
	const inbound = { traceparent: VALID, tracestate: "congo=t61" }

	it("untrusted (the default): a fresh root linked to it", async () => {
		const { spans, telemetry } = recorder()
		const app = honey<{}>().telemetry(telemetry)
		app.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		await app.fetch(get("/a", { headers: inbound }), {})
		expect([spans[0]?.parent, spans[0]?.links]).toEqual([
			null,
			[{ flags: 1, spanId: SPAN, state: undefined, traceId: TRACE }],
		])
	})

	it("trusted: the root continues it, tracestate included", async () => {
		const { spans, telemetry } = recorder()
		const app = honey<{}>().telemetry({ ...telemetry, trustInbound: true })
		app.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		await app.fetch(get("/a", { headers: inbound }), {})
		expect([spans[0]?.parent, spans[0]?.links]).toEqual([
			{ flags: 1, spanId: SPAN, state: "congo=t61", traceId: TRACE },
			[],
		])
	})

	it("a predicate sees the peer the platform reports (none here)", async () => {
		const { spans, telemetry } = recorder()
		const app = honey<{}>().telemetry({ ...telemetry, trustInbound: ({ ip }) => ip === null })
		app.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		await app.fetch(get("/a", { headers: inbound }), {})
		expect(spans[0]?.links).toEqual([])
	})

	it("a trust predicate that throws: linked, and a warn", async () => {
		const lines: Record<string, unknown>[] = []
		const logger = createLogger({
			format: "json",
			level: "info",
			write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
		})
		const { spans, telemetry } = recorder()
		const app = honey<{}>()
			.logger(logger)
			.telemetry({ ...telemetry, trustInbound: brokenTrust })
		app.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		await app.fetch(get("/a", { headers: inbound }), {})
		expect([spans[0]?.parent, lines.map((l) => [l.level, l.msg])]).toEqual([
			null,
			[[40, "telemetry trust check failed"]],
		])
	})
})

/** A proxied app whose upstream records the headers it was sent. */
function proxied(configure: (app: ReturnType<typeof honey<{}>>) => void, requestHeaders?: Record<string, string>) {
	const sent: Headers[] = []
	const app = honey<{}>()
	configure(app)
	app.all("/api/*rest").handler(
		proxy({
			destination: (_ctx, _url, init) => {
				sent.push(new Headers(init.headers))
				return new Response("up")
			},
			...(requestHeaders && { requestHeaders }),
		}),
	)
	return { app, sent }
}

/** What a caller sent: its own trace, and its vendor's tracestate. */
const CALLER = { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", tracestate: "congo=t61" }

describe("outbound: the proxy forwards the trace of its http.proxy span", () => {
	it("an untrusted caller's trace is replaced by the request's own, its tracestate dropped", async () => {
		const { spans, telemetry } = recorder()
		const { app, sent } = proxied((a) => a.telemetry(telemetry))
		await (await app.fetch(get("/api/x", { headers: CALLER }), {})).text()
		const client = spans.find((s) => s.name === "http.proxy") as Recorded
		expect([
			client.kind,
			(client.parent as Recorded).name,
			client.attributes,
			sent[0]?.get("traceparent"),
			sent[0]?.get("tracestate"),
		]).toEqual([
			"client",
			"http.handler",
			{ "http.request.method": "GET", "http.response.status_code": 200 },
			formatTraceparent({ flags: 1, spanId: client.spanContext().spanId, traceId: TRACE }),
			null,
		])
	})

	it("a trusted caller's tracestate goes on with the trace it continued", async () => {
		const { telemetry } = recorder()
		const { app, sent } = proxied((a) => a.telemetry({ ...telemetry, trustInbound: true }))
		await (await app.fetch(get("/api/x", { headers: CALLER }), {})).text()
		expect(sent[0]?.get("tracestate")).toBe("congo=t61")
	})

	it("requestHeaders still has the last word", async () => {
		const { telemetry } = recorder()
		const { app, sent } = proxied((a) => a.telemetry(telemetry), { traceparent: "set-by-the-app" })
		await (await app.fetch(get("/api/x"), {})).text()
		expect(sent[0]?.get("traceparent")).toBe("set-by-the-app")
	})
})

describe("outbound: sampling, failure, and telemetry off", () => {
	it("a sampled-out request forwards its root's ids, unsampled, and starts no span", async () => {
		const { spans, telemetry } = recorder({ recording: false })
		const unsampled = {
			...telemetry,
			tracer: {
				startSpan: (name: string, options: Parameters<typeof telemetry.tracer.startSpan>[1]) =>
					Object.assign(telemetry.tracer.startSpan(name, options), {
						spanContext: () => ({ spanId: "00f067aa0ba902b7", traceFlags: 0, traceId: TRACE }),
					}),
			},
		}
		const { app, sent } = proxied((a) => a.telemetry(unsampled))
		await (await app.fetch(get("/api/x"), {})).text()
		expect([spans.map((s) => s.name), sent[0]?.get("traceparent")]).toEqual([
			["GET"],
			`00-${TRACE}-00f067aa0ba902b7-00`,
		])
	})

	it("an upstream that fails: the http.proxy span ends ERROR with the failure's type", async () => {
		const { spans, telemetry } = recorder()
		const app = honey<{}>().telemetry(telemetry).logger(false)
		app.all("/api/*rest").handler(
			proxy({
				destination: () => {
					throw new TypeError("fetch failed")
				},
			}),
		)
		const res = await app.fetch(get("/api/x"), {})
		const client = spans.find((s) => s.name === "http.proxy")
		expect([res.status, client?.status, client?.attributes["exception.type"], client?.ended]).toEqual([
			502,
			2,
			"TypeError",
			1,
		])
	})

	it("a request with no trace ids (its tracer failed): the upstream gets no trace at all, not the caller's", async () => {
		const { telemetry } = recorder()
		const broken = {
			...telemetry,
			tracer: {
				startSpan: () => {
					throw new Error("tracer down")
				},
			},
		}
		const { app, sent } = proxied((a) => a.logger(false).telemetry(broken))
		await (await app.fetch(get("/api/x", { headers: CALLER }), {})).text()
		expect([sent[0]?.get("traceparent"), sent[0]?.get("tracestate")]).toEqual([null, null])
	})
})

describe("outbound with telemetry off", () => {
	it("telemetry off: the proxy passes the caller's headers on as they came", async () => {
		const { app, sent } = proxied(() => {})
		await (await app.fetch(get("/api/x", { headers: CALLER }), {})).text()
		expect([sent[0]?.get("traceparent"), sent[0]?.get("tracestate")]).toEqual([CALLER.traceparent, CALLER.tracestate])
	})
})
