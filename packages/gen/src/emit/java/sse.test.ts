/**
 * An SSE operation in the Java SDK (bit 16 phase d1; C#'s `sse.test.ts`, contract 50 §5.1), on the shared `sse` document:
 * the method opens `EventStream<T>` (`String` untyped), read once as an `Iterable<SseEvent<T>>`; closing it, its end, an
 * error or a cancel lets the connection go (J1). Java's for-each `break` has no close hook, so try-with-resources is the
 * release (F1). An error status throws from the call before any event, in either mode; the request carries `Accept`,
 * `Last-Event-ID`, the merged headers, the params, the body and the token; a typed stream ends at an event that does not
 * decode. The timeout bounds the open up to the headers (J4); the cancel is the reading thread's interrupt (J2), run on
 * Temurin 17 as well as 21, since 17's own body stream ignores an interrupt. The typed headers and `raw` fill at the open
 * (J3, J6). Every timed call follows a warm one on its client. The public API's legs: `sse.api.test.ts`; hooks and log:
 * `sse.hooks.test.ts`; the parser: `sse.parse.test.ts`; the release checks: `streams.close.test.ts`.
 */
import { describe, expect, it } from "vitest"
import type { Call, Observed, Setup } from "../../../tests/integration/conformance/matrix.ts"
import { gone } from "../shared/__fixtures__/gone.ts"
import type { JavaError, Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import type { SseScript } from "../shared/__fixtures__/sse-steps.ts"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

const get = (path: string) => ({ method: "GET", path })
const ticks = (extra: Partial<Call> = {}): Call => ({ operation: "ticks.stream", route: get("/ticks"), ...extra })
const text = (extra: Partial<Call> = {}): Call => ({ operation: "text.stream", route: get("/text"), ...extra })
const pending = (id: string): Call => ({ operation: "pending.stream", params: { id }, route: get("/pending/{id}") })
const CHAT: Call = {
	body: { kind: "json", value: { q: "hi" } },
	operation: "chat.send",
	route: { method: "POST", path: "/chat" },
	search: { model: "m" },
}

type Step = string | { waitMs: number }
const sse = (steps: readonly Step[], end: SseScript["end"] = "close", encoding?: SseScript["encoding"]): Reply => ({
	sse: { end, steps, ...(encoding === undefined ? {} : { encoding }) },
	status: 200,
})
const TICK = sse(['data: {"n":1}\n\n'])
const TICKED: Observed = { events: [{ data: { n: 1 } }], kind: "events" }
const tick = (n: number) => `id: ${n}\nevent: tick\ndata: {"n":${n}}\n\n`
/** An untyped stream's events as observed: each text its event's data. */
const strings = (...data: string[]): Observed => ({ events: data.map((d) => ({ data: d })), kind: "events" })
/** A stream's cancel as traced: the reader's interrupt ended it (J2), via the stream. */
const CANCELED = expect.objectContaining({ canceled: true, via: "stream" })
/** The unbounded open a timed call follows on its client (per-call timeout 0), and what it observes. */
const WARM = text({ timeoutMs: 0 })
const WARMED = sse(["data: w\n\n"])
/** The JDKs a cancel leg runs on: 17's ofInputStream ignores an interrupt (d1 probe), so the pump is pinned there too. */
const JDKS = [17, 21] as const

/** The `sse` registry SDK with the driver aimed at it, which must build. */
function driven(): DrivenJavaSdk {
	const sdk = drivenJavaSdk("sse")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

type Options = { readonly jdk?: 17 | 21; readonly script?: Script; readonly setup?: Setup }
/** `calls` run by the driver against a server answering `replies`: the run, hops and streams. */
async function drive(replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	const sdk = driven()
	return served(replies, async (server) => {
		const cell = { calls, setup: options.setup ?? {} }
		const run = await sdk.runCalls(cell, { url: server.url }, { jdk: options.jdk, script: options.script })
		return { hops: [...server.hops], run, streams: [...server.streams] }
	})
}

/** A traced error as a leg pins it: its type, chain, status when it has one, text, and where it came from. */
const errorOf = (e: JavaError | undefined) =>
	e && { chain: e.chain, status: e.status, text: e.text, type: e.type, via: e.via }

describe.skipIf(!JAVA)("an SSE stream's events: data decoded as T, the event and id, the stream's end", SLOW, () => {
	/* new: C# sse.test.ts:155 */
	it("decodes each event's data into T with its event and id, and keeps a string stream's data as sent", async () => {
		const replies = [sse([tick(1), tick(2), tick(3)]), sse(['data: {"a":1}\n\n'])]
		const { run } = await drive(replies, [ticks({ take: 3 }), text()])
		expect(run.observed, run.stderr).toEqual([
			{ events: [1, 2, 3].map((n) => ({ data: { n }, event: "tick", id: String(n) })), kind: "events" },
			strings('{"a":1}'),
		] satisfies Observed[])
	})

	/* new: C# sse.test.ts:165 */
	it("yields a text stream's events in order with their ids, then ends at the end of the body", async () => {
		const { run } = await drive([sse(["id: 1\ndata: hello\n\nid: 2\ndata: world\n\n"])], [text()], { script: {} })
		const call = run.trace?.calls[0]
		expect({ error: call?.error, observed: run.observed, stream: call?.stream }, run.stderr).toEqual({
			error: undefined,
			observed: [
				{
					events: [
						{ data: "hello", id: "1" },
						{ data: "world", id: "2" },
					],
					kind: "events",
				},
			],
			stream: { retry: [null, null], yields: 2 },
		})
	})

	/* new: J5; a compressed event stream decoded as it flows (d1 probe P7) */
	it.each(["gzip", "deflate"] as const)(
		"decodes a %s event stream as it flows: the first event before the pause ends",
		async (encoding) => {
			const replies = [WARMED, sse(["data: 1\n\n", { waitMs: 600 }, "data: 2\n\n"], "close", encoding)]
			const { hops, run } = await drive(replies, [WARM, text({ take: 1 })], { script: {} })
			expect({ accept: hops[1]?.headers["accept-encoding"], observed: run.observed }, run.stderr).toEqual({
				accept: "gzip, deflate",
				observed: [strings("w"), strings("1")],
			})
			expect(run.trace?.calls[1]?.elapsedMs).toBeLessThan(500)
		},
	)
})

describe.skipIf(!JAVA)("an SSE stream's failures and typed headers: thrown once, then the end", SLOW, () => {
	/* new: C# sse.test.ts:186 (Jackson refuses another JSON kind itself: `5` into Tick does not decode) */
	it("ends a typed stream at an event that does not decode: one DecodeException, nothing after", async () => {
		const replies = [
			sse(['data: {"n":1}\n\n', "data: nope\n\n", 'data: {"n":3}\n\n']),
			sse(["data: 5\n\n", 'data: {"n":2}\n\n']),
		]
		const { run } = await drive(replies, [ticks(), ticks()], { script: {} })
		const decoded = {
			chain: ["DecodeException", "HoneyException"],
			status: undefined,
			text: expect.stringMatching(/^an event's data does not decode: /),
			type: "DecodeException",
			via: "stream",
		}
		const calls = run.trace?.calls.map(({ error, stream }) => ({ error: errorOf(error), stream }))
		expect({ calls, observed: run.observed }, run.stderr).toEqual({
			calls: [
				{ error: decoded, stream: { retry: [null], yields: 2 } },
				{ error: decoded, stream: { yields: 1 } },
			],
			observed: [TICKED, { events: [], kind: "events" }],
		})
	})

	/* new: C# sse.test.ts:210 (J3; the holder's wire names as declared) */
	it("fills the typed headers at the open: the declared X-Stream-Id when the answer sends it, nothing when not", async () => {
		const replies = [{ ...TICK, headers: { "x-stream-id": "s-1" } }, TICK]
		const { run } = await drive(replies, [ticks(), ticks()], { script: {} })
		expect({ headers: run.trace?.calls.map((c) => c.stream?.headers), observed: run.observed }, run.stderr).toEqual({
			headers: [{ "X-Stream-Id": "s-1" }, undefined],
			observed: [TICKED, TICKED],
		})
	})
})

const STATUS = ["ApiException", "HoneyException"]
/** An error status at the open as the trace records it: its class, the status class, the text, via return. */
const statusError = (type: string, status: number, message: string) => ({
	error: { chain: [type, ...STATUS], status, text: `HTTP ${status}: ${message}`, type, via: "return" },
	stream: undefined,
})

describe.skipIf(!JAVA)("an SSE open that fails: its status class thrown before any event", SLOW, () => {
	/* new: C# sse.test.ts:229 */
	it("throws an error status's ApiException subclass from the call, never as a stream's first event", async () => {
		const replies: Reply[] = [
			{ json: { message: "nope" }, status: 404 },
			{ json: { message: "boom" }, status: 500 },
		]
		const { hops, run } = await drive(replies, [ticks(), ticks()], { script: {} })
		const calls = run.trace?.calls.map(({ error, stream }) => ({ error: errorOf(error), stream }))
		expect({ calls, hops: hops.length, observed: run.observed }, run.stderr).toEqual({
			calls: [statusError("NotFoundException", 404, "nope"), statusError("InternalServerException", 500, "boom")],
			hops: 2,
			observed: [
				{ body: { message: "nope" }, errorKey: null, kind: "error", status: 404 },
				{ body: { message: "boom" }, errorKey: null, kind: "error", status: 500 },
			] satisfies Observed[],
		})
	})

	/* new: C# sse.test.ts:247 */
	it("fails a bad path param before any request: null, a PathParamException via return, no hop", async () => {
		const { hops, run } = await drive([], [pending("..")], { script: {} })
		const call = run.trace?.calls[0]
		const got = [hops.length, run.observed, call?.stream, call?.error?.type, call?.error?.via]
		expect(got, run.stderr).toEqual([0, [null], undefined, "PathParamException", "return"])
	})
})

describe.skipIf(!JAVA)("an SSE request on the wire: Accept and Last-Event-ID", SLOW, () => {
	/* new: C# sse.test.ts:292 */
	it("asks for text/event-stream, and a per-call accept header wins", async () => {
		const { hops, run } = await drive([TICK, TICK], [ticks(), ticks({ headers: { accept: "text/plain" } })])
		expect({ accept: hops.map((hop) => hop.headers.accept), observed: run.observed }, run.stderr).toEqual({
			accept: ["text/event-stream", "text/plain"],
			observed: [TICKED, TICKED],
		})
	})

	/* new: C# sse.test.ts:301 */
	it("sends lastEventId as Last-Event-ID, and no such header without one or for an empty one", async () => {
		const calls = [ticks({ lastEventId: "evt-5" }), ticks(), ticks({ lastEventId: "" })]
		const { hops, run } = await drive([TICK, TICK, TICK], calls)
		expect({ ids: hops.map((hop) => hop.headers["last-event-id"]), observed: run.observed }, run.stderr).toEqual({
			ids: ["evt-5", undefined, undefined],
			observed: [TICKED, TICKED, TICKED],
		})
	})
})

describe.skipIf(!JAVA)("an SSE request on the wire: headers, params, method, body and auth", SLOW, () => {
	/* new: C# sse.test.ts:313 */
	it("sends the config's headers with the call's merged over them, one value each", async () => {
		const setup: Setup = { headers: { "X-Both": "cfg", "X-Cfg": "1" } }
		const call = ticks({ headers: { "x-both": "call", "x-call": "1" } })
		const { hops, run } = await drive([TICK], [call], { setup })
		expect(run.observed, run.stderr).toEqual([TICKED])
		expect(hops.map(({ headers }) => [headers["x-cfg"], headers["x-both"], headers["x-call"]])).toEqual([
			["1", "call", "1"],
		])
	})

	/* new: C# sse.test.ts:324 */
	it("sends the declared query and header params", async () => {
		const { hops, run } = await drive([TICK], [ticks({ headers: { "x-tenant": "acme" }, search: { since: 5 } })])
		expect(run.observed, run.stderr).toEqual([TICKED])
		expect(hops.map(({ headers, method, url }) => ({ method, tenant: headers["x-tenant"], url }))).toEqual([
			{ method: "GET", tenant: "acme", url: "/ticks?since=5" },
		])
	})

	/* new: C# sse.test.ts:333 */
	it("sends a POST stream's method, query, JSON body and bearer token, then yields its events", async () => {
		const setup: Setup = { auth: { kind: "bearer", token: "tok" } }
		const { hops, run } = await drive([sse(["data: one\n\n"])], [CHAT], { setup })
		expect(run.observed, run.stderr).toEqual([strings("one")])
		/* each hop as its method, URL, authorization, content type and JSON body */
		const sent = hops.map((h) => [h.method, h.url, h.headers.authorization, h.headers["content-type"], h.body.json])
		expect(sent).toEqual([["POST", "/chat?model=m", "Bearer tok", "application/json", { q: "hi" }]])
	})
})

describe.skipIf(!JAVA)("what bounds an SSE call: the timeout its open, the reader's interrupt all of it", SLOW, () => {
	/* new: C# sse.test.ts:345 (300 ms and 400 ms bounds against a 500 ms gap) */
	it("is not cut by the client's or the call's timeout once open: a gap past both still delivers the next event", async () => {
		const gap = sse(["data: 1\n\n", { waitMs: 500 }, "data: 2\n\n"])
		const calls = [WARM, text(), text({ timeoutMs: 400 })]
		const { run } = await drive([WARMED, gap, gap], calls, { script: {}, setup: { timeoutMs: 300 } })
		const traced = run.trace?.calls ?? []
		expect({ errors: traced.map((c) => c.error), observed: run.observed }, run.stderr).toEqual({
			errors: [undefined, undefined, undefined],
			observed: [strings("w"), strings("1", "2"), strings("1", "2")],
		})
		/* the gap really outlasted both bounds: the server paused 500 ms between the events */
		expect(traced.slice(1).map((c) => c.elapsedMs >= 450)).toEqual([true, true])
	})

	/* new: C# sse.test.ts:359 */
	it("bounds the open by the client's timeout up to the headers: held headers are ApiTimeoutException via return", async () => {
		const replies = [TICK, { ...TICK, delayMs: 2000 }]
		const setup: Setup = { timeoutMs: 300 }
		const { hops, run } = await drive(replies, [ticks({ timeoutMs: 0 }), ticks()], { script: {}, setup })
		const call = run.trace?.calls[1]
		const elapsed = call?.elapsedMs ?? -1
		const bounded = elapsed >= 250 && elapsed < 1500
		const got = { bounded, error: errorOf(call?.error), hops: hops.length, observed: run.observed }
		expect(got, `${run.stderr} elapsed ${elapsed}`).toEqual({
			bounded: true,
			error: {
				chain: ["ApiTimeoutException", "HoneyException"],
				status: undefined,
				text: "GET /ticks timed out after 300 ms",
				type: "ApiTimeoutException",
				via: "return",
			},
			hops: 2,
			observed: [TICKED, { kind: "timeout" }],
		})
	})

	/* new: C# sse.test.ts:382 (J2: the interrupt of the thread that opens; a 300 ms cancel against an answer held 3 s) */
	it.each(JDKS)(
		"an interrupt during a slow open is the caller's CancellationException via return, its one request sent (JDK %i)",
		async (jdk) => {
			const script: Script = { calls: [null, { cancel: { afterMs: 300 } }] }
			const replies = [TICK, { ...TICK, delayMs: 3000 }]
			const { hops, run } = await drive(replies, [ticks({ timeoutMs: 0 }), ticks()], { jdk, script })
			const call = run.trace?.calls[1]
			expect({ error: call?.error, hops: hops.length, observed: run.observed }, run.stderr).toEqual({
				error: expect.objectContaining({ canceled: true, via: "return" }),
				hops: 2,
				observed: [TICKED, null],
			})
			expect(call?.elapsedMs).toBeLessThan(2000)
		},
	)
})

describe.skipIf(!JAVA)("how an open SSE stream ends: the reader's interrupt, take", SLOW, () => {
	/* new: C# sse.test.ts:398 (J2; the interrupt 1,000 ms in, the next event held 5,000 ms; on 17 and 21) */
	it.each(JDKS)(
		"ends an open stream when its reader is interrupted: the events so far, the cancel traced, the connection let go (JDK %i)",
		async (jdk) => {
			const held = sse(["data: 1\n\n", { waitMs: 5000 }, "data: 2\n\n"], "hold")
			/* the third call's answer waits until the held stream's client left (gone.ts): the driver still runs */
			const next = gone(sse(["data: z\n\n"]), { stream: 1 })
			const script: Script = { calls: [null, { cancel: { afterMs: 1000 } }] }
			const { run } = await drive([WARMED, held, next.reply], [WARM, text(), text()], { jdk, script })
			const calls = run.trace?.calls ?? []
			expect(
				{ errors: calls.map((call) => call.error), observed: run.observed, released: next.released() },
				run.stderr,
			).toEqual({
				errors: [undefined, CANCELED, undefined],
				observed: [strings("w"), strings("1"), strings("z")],
				released: true,
			})
			expect(calls[1]?.elapsedMs).toBeGreaterThanOrEqual(990)
			expect(calls[1]?.elapsedMs).toBeLessThan(4000)
		},
	)

	/* new: P4 (reviewer condition 4): an interrupt under a pending read of a gzip stream releases as the plain one does */
	it("ends an open gzip stream when its reader is interrupted: the cancel traced, the connection let go", async () => {
		const held = sse(["data: 1\n\n", { waitMs: 5000 }, "data: 2\n\n"], "hold", "gzip")
		const next = gone(sse(["data: z\n\n"]), { stream: 1 })
		const script: Script = { calls: [null, { cancel: { afterMs: 1000 } }] }
		const { run } = await drive([WARMED, held, next.reply], [WARM, text(), text()], { script })
		expect(
			{ errors: run.trace?.calls.map((call) => call.error), observed: run.observed, released: next.released() },
			run.stderr,
		).toEqual({
			errors: [undefined, CANCELED, undefined],
			observed: [strings("w"), strings("1"), strings("z")],
			released: true,
		})
	})

	/* new: C# sse.test.ts:418 (the driver closes at take, the try-with-resources release) */
	it("closes the connection when the reads stop at take, before the run goes on", async () => {
		const spaced = sse(["data: 1\n\n", { waitMs: 50 }, "data: 2\n\n", { waitMs: 50 }, "data: 3\n\n"], "hold")
		const next = gone(sse(["data: z\n\n"]), { stream: 1 })
		const { run } = await drive([WARMED, spaced, next.reply], [WARM, text({ take: 1 }), text()], { script: {} })
		expect({ observed: run.observed, released: next.released() }, run.stderr).toEqual({
			observed: [strings("w"), strings("1"), strings("z")],
			released: true,
		})
		expect(run.trace?.calls[1]?.elapsedMs).toBeLessThan(1500)
	})
})
