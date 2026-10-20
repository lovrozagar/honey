/**
 * An SSE operation in the C# SDK (contract 50 §5.1; Python's `sse.test.ts` analog), on the shared `sse` document:
 * awaiting the method opens `EventStream<T>` (`string` untyped), read once by `await foreach`; leaving the loop,
 * `DisposeAsync` or the end lets the connection go (Fd1). An error status throws before any event, in either mode;
 * the request carries `Accept`, `Last-Event-ID`, the merged headers, the params, the body and the token; a typed
 * stream ends at an event that does not decode. The timeout bounds the open up to the headers (Fd8), the method's
 * token the open and the stream (Fd2); the typed headers and `Raw` fill at the open (Fd4). Every timed call follows
 * a warm one on its client. Hooks and log: `sse.hooks.test.ts`; the parser: `sse.parse.test.ts`.
 */
import { describe, expect, it } from "vitest"
import type { Call, Observed, Setup } from "../../../tests/integration/conformance/matrix.ts"
import { gone } from "../shared/__fixtures__/gone.ts"
import type { CsError, Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { checked, consume, program, seen } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { type DrivenCSharpSdk, drivenCSharpSdk } from "./__fixtures__/driven.ts"
import { generateCSharpSdk } from "./sdk.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
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
const sse = (steps: readonly Step[], end: "close" | "drop" | "hold" = "close"): Reply => ({
	sse: { end, steps },
	status: 200,
})
const TICK = sse(['data: {"n":1}\n\n'])
const TICKED: Observed = { events: [{ data: { n: 1 } }], kind: "events" }
const tick = (n: number) => `id: ${n}\nevent: tick\ndata: {"n":${n}}\n\n`
/** An untyped stream's events as observed: each text its event's data. */
const strings = (...data: string[]): Observed => ({ events: data.map((d) => ({ data: d })), kind: "events" })
/** A stream's OCE as traced: the method's token ended it (Fd2), via the stream (contract 50 §4.3). */
const CANCELED = expect.objectContaining({ canceled: true, via: "stream" })
/** The unbounded open a timed call follows on its client (per-call timeout 0), and what it observes. */
const WARM = text({ timeoutMs: 0 })
const WARMED = sse(["data: w\n\n"])

/** The `sse` registry SDK with the driver aimed at it, which must build. */
function driven(): DrivenCSharpSdk {
	const sdk = drivenCSharpSdk("sse")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

type Options = { readonly script?: Script; readonly setup?: Setup }
/** `calls` run by the driver against a server answering `replies`: the run, hops and streams. */
async function drive(replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	const sdk = driven()
	return served(replies, async (server) => {
		const cell = { calls, setup: options.setup ?? {} }
		const run = await sdk.runCalls(cell, { url: server.url }, { script: options.script })
		return { hops: [...server.hops], run, streams: [...server.streams] }
	})
}

/** A traced error as a leg pins it: its type, chain, status when it has one, text, and where it came from. */
const errorOf = (e: CsError | undefined) =>
	e && { chain: e.chain, status: e.status, text: e.text, type: e.type, via: e.via }

/**
 * A typed stream and two text ones, opened and read through the public API: the cursor before and after an id,
 * the stream as an `IAsyncEnumerable<SseEvent<Tick>>`. Each next open is the release point of the stream before it
 * (gone.ts): the typed one ends by `await using` alone (its enumerator is never disposed), the second by `break`,
 * and the third is read to its end. M1 (the enumerator's dispose leaves the response) turns the second one red.
 */
const TYPED = `using var c = Client();
await using (var s = await c.Ticks.StreamAsync())
{
    Note(s.LastEventId);
    var e = s.GetAsyncEnumerator();
    await e.MoveNextAsync();
    Note($"{e.Current.Data.N} {e.Current.Id} {s.LastEventId}");
    object o = s;
    Note($"{o is IAsyncEnumerable<SseEvent<Tick>>}");
}
var t = await c.Text.StreamAsync();
await foreach (var ev in t)
{
    Note(ev.Data);
    break;
}
var last = await c.Text.StreamAsync();
await foreach (var ev in last)
{
    Note(ev.Data);
}`

/** What csc holds of the stream methods: `EventStream<Tick>` and `EventStream<string>`, and what it refuses. */
const WRONG = "EventStream<string> s = await c.Ticks.StreamAsync();"
const RESUMED = 'await c.Ticks.StreamAsync(reconnectToken: "x");'
const TYPES = [
	"using var c = Client();",
	WRONG,
	RESUMED,
	"EventStream<string> t = await c.Text.StreamAsync();",
	'var u = await c.Ticks.StreamAsync(since: 5, lastEventId: "7");',
	"await foreach (SseEvent<Tick> ev in u)",
	"{",
	"    (Tick data, string? name, string? id, TimeSpan? retry) = (ev.Data, ev.Event, ev.Id, ev.Retry);",
	"}",
	"string cursor = u.LastEventId;",
]

/** csc's errors for TYPES against `sse`, each as `<the statement> → <CS code>: <message>`. */
function findings(): string[] {
	const source = program("HoneySdk", "HoneySdkClient", TYPES.join("\n"))
	const lines = source.split("\n")
	return checked("sse", source).map((line) => {
		const found = /^\((\d+),\d+\): error (CS\d+: .*)$/.exec(line)
		return found === null ? line : `${lines[Number(found[1]) - 1]?.trim()} → ${found[2]}`
	})
}

describe.skipIf(!DOTNET)("an SSE method: awaiting it opens EventStream<T>, read by await foreach", SLOW, () => {
	/* ported: python sse.test.ts:129 (aclose and async with become await using and break) */
	it("reads a typed event with its id and the stream's cursor, and await using and break let the connection go", async () => {
		/* the second stream's answer waits until the typed stream's client left, the third's until the second's */
		const [afterTyped, afterText] = [gone(sse(["data: a\n\n"], "hold")), gone(sse(["data: z\n\n"]), { stream: 1 })]
		const replies = [sse(['id: 7\ndata: {"n":1}\n\n'], "hold"), afterTyped.reply, afterText.reply]
		const run = await served(replies, (server) => consume("sse", "typed-stream", { base: server.url, body: TYPED }))
		const released = [afterTyped.released(), afterText.released()]
		expect({ ...seen(run), released }, run.stderr).toEqual({
			out: ["", "1 7 7", "True", "a", "z"],
			ran: true,
			released: [true, true],
		})
	})

	/* ported: python sse.test.ts:143 (a WebSocket cursor refused; C# has one client) */
	it("types the methods EventStream<Tick> and EventStream<string>, and refuses a WebSocket cursor", () => {
		expect(findings()).toEqual([
			`${WRONG} → CS0029: Cannot implicitly convert type 'HoneySdk.EventStream<HoneySdk.Tick>' to 'HoneySdk.EventStream<string>'`,
			`${RESUMED} → CS1739: The best overload for 'StreamAsync' does not have a parameter named 'reconnectToken'`,
		])
	})
})

describe.skipIf(!DOTNET)("an SSE stream's events: data decoded as T, the event and id, the stream's end", SLOW, () => {
	/* ported: python sse.test.ts:163 */
	it("decodes each event's data into T with its event and id, and keeps a string stream's data as sent", async () => {
		const replies = [sse([tick(1), tick(2), tick(3)]), sse(['data: {"a":1}\n\n'])]
		const { run } = await drive(replies, [ticks({ take: 3 }), text()])
		expect(run.observed, run.stderr).toEqual([
			{ events: [1, 2, 3].map((n) => ({ data: { n }, event: "tick", id: String(n) })), kind: "events" },
			strings('{"a":1}'),
		] satisfies Observed[])
	})

	/* ported: python sse.test.ts:173 */
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
})

describe.skipIf(!DOTNET)("an SSE stream's failures and typed headers: thrown once, then the end", SLOW, () => {
	/* ported: python sse.test.ts:195 (STJ refuses another JSON kind itself: `5` into Tick does not decode) */
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

	/* ported: python sse.test.ts:224 (Fd4; the holder's wire names as declared) */
	it("fills the typed headers at the open: the declared X-Stream-Id when the answer sends it, nothing when not", async () => {
		const replies = [{ ...TICK, headers: { "x-stream-id": "s-1" } }, TICK]
		const { run } = await drive(replies, [ticks(), ticks()], { script: {} })
		expect({ headers: run.trace?.calls.map((c) => c.stream?.headers), observed: run.observed }, run.stderr).toEqual({
			headers: [{ "X-Stream-Id": "s-1" }, undefined],
			observed: [TICKED, TICKED],
		})
	})
})

const STATUS = ["ApiStatusException", "HoneyException"]
/** An error status at the open as the trace records it: its class, the status class, the text, via return. */
const statusError = (type: string, status: number, message: string) => ({
	error: { chain: [type, ...STATUS], status, text: `HTTP ${status}: ${message}`, type, via: "return" },
	stream: undefined,
})

describe.skipIf(!DOTNET)("an SSE open that fails: its status class thrown before any event", SLOW, () => {
	/* ported: python sse.test.ts:277 */
	it("throws an error status's ApiStatusException subclass from the await, never as a stream's first event", async () => {
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

	/* ported: python sse.test.ts:289 */
	it("fails a bad path param before any request: null, a PathParamException via return, no hop", async () => {
		const { hops, run } = await drive([], [pending("..")], { script: {} })
		const call = run.trace?.calls[0]
		const got = [hops.length, run.observed, call?.stream, call?.error?.type, call?.error?.via]
		expect(got, run.stderr).toEqual([0, [null], undefined, "PathParamException", "return"])
	})
})

/** The `sse` SDK's Client.cs lines in throw mode or safe mode. */
const clientLines = (throwOnError: boolean) =>
	(generateCSharpSdk(FIXTURES.sse.document(), { throwOnError }).files["Client.cs"] ?? "").split("\n")
/** Each stream method's two lines: its signature and its call. */
const streamMethods = (lines: readonly string[]) =>
	lines.flatMap((line, i) => (line.startsWith("    public Task<EventStream<") ? [[line, lines[i + 1] ?? ""]] : []))

const OPTIONS = "RequestOptions? options = null, CancellationToken cancellationToken = default"
const CONTEXT = "HoneySdkJsonContext.Default"
/** contract 50 §2.1's SSE lines, exact. */
const EMITTED = [
	'    private static readonly Operation _stream = new("GET", "/ticks", [], Idempotent: false, Accept: "text/event-stream");',
	"    /// <returns>The open stream: an error status throws before any event. No timeout bounds it after that; the token, leaving await foreach or DisposeAsync ends it.</returns>",
	`    public Task<EventStream<Tick>> StreamAsync(long? since = null, string? xTenant = null, TicksStreamHeaders? headersInto = null, string? lastEventId = null, ${OPTIONS}) =>`,
	`        _t.EventsAsync(_stream, new([], [Arg.Of("since", since, ${CONTEXT}.NullableInt64)], [Arg.Of("x-tenant", xTenant, ${CONTEXT}.String)], null, null, options, headersInto is null ? null : headersInto.Read), lastEventId, ${CONTEXT}.Tick, cancellationToken);`,
	`    public Task<EventStream<string>> SendAsync(ChatSendBody body, string? model = null, string? lastEventId = null, ${OPTIONS}) =>`,
	`        _t.TextEventsAsync(_send, new([], [Arg.Of("model", model, ${CONTEXT}.String)], [], Body.Json(body, ${CONTEXT}.ChatSendBody), null, options), lastEventId, cancellationToken);`,
	`    public Task<EventStream<string>> StreamAsync(string id, string? lastEventId = null, ${OPTIONS}) =>`,
	"        _t.TextEventsAsync(_stream, new([id], [], [], null, null, options), lastEventId, cancellationToken);",
]

describe("generateCSharpSdk: an SSE method in safe mode", () => {
	/* ported: python sse.test.ts:284 (no sse-safe fixture: the method text proves it, contract 50 §4.1) */
	it("emits each stream method as throw mode does: a stream ignores throwOnError and answers no SdkResult", () => {
		const [thrown, safe] = [clientLines(true), clientLines(false)]
		const methods = streamMethods(safe)
		expect({
			count: methods.length,
			emitted: thrown,
			result: methods.flat().filter((line) => line.includes("SdkResult")),
			safe: methods,
		}).toEqual({ count: 4, emitted: expect.arrayContaining(EMITTED), result: [], safe: streamMethods(thrown) })
	})
})

describe.skipIf(!DOTNET)("an SSE request on the wire: Accept and Last-Event-ID", SLOW, () => {
	/* ported: python sse.test.ts:302 */
	it("asks for text/event-stream, and a per-call accept header wins", async () => {
		const { hops, run } = await drive([TICK, TICK], [ticks(), ticks({ headers: { accept: "text/plain" } })])
		expect({ accept: hops.map((hop) => hop.headers.accept), observed: run.observed }, run.stderr).toEqual({
			accept: ["text/event-stream", "text/plain"],
			observed: [TICKED, TICKED],
		})
	})

	/* ported: python sse.test.ts:311 */
	it("sends lastEventId as Last-Event-ID, and no such header without one or for an empty one", async () => {
		const calls = [ticks({ lastEventId: "evt-5" }), ticks(), ticks({ lastEventId: "" })]
		const { hops, run } = await drive([TICK, TICK, TICK], calls)
		expect({ ids: hops.map((hop) => hop.headers["last-event-id"]), observed: run.observed }, run.stderr).toEqual({
			ids: ["evt-5", undefined, undefined],
			observed: [TICKED, TICKED, TICKED],
		})
	})
})

describe.skipIf(!DOTNET)("an SSE request on the wire: headers, params, method, body and auth", SLOW, () => {
	/* ported: python sse.test.ts:322 */
	it("sends the config's headers with the call's merged over them, one value each", async () => {
		const setup: Setup = { headers: { "X-Both": "cfg", "X-Cfg": "1" } }
		const call = ticks({ headers: { "x-both": "call", "x-call": "1" } })
		const { hops, run } = await drive([TICK], [call], { setup })
		expect(run.observed, run.stderr).toEqual([TICKED])
		expect(hops.map(({ headers }) => [headers["x-cfg"], headers["x-both"], headers["x-call"]])).toEqual([
			["1", "call", "1"],
		])
	})

	/* ported: python sse.test.ts:333 */
	it("sends the declared query and header params", async () => {
		const { hops, run } = await drive([TICK], [ticks({ headers: { "x-tenant": "acme" }, search: { since: 5 } })])
		expect(run.observed, run.stderr).toEqual([TICKED])
		expect(hops.map(({ headers, method, url }) => ({ method, tenant: headers["x-tenant"], url }))).toEqual([
			{ method: "GET", tenant: "acme", url: "/ticks?since=5" },
		])
	})

	/* ported: python sse.test.ts:344 */
	it("sends a POST stream's method, query, JSON body and bearer token, then yields its events", async () => {
		const setup: Setup = { auth: { kind: "bearer", token: "tok" } }
		const { hops, run } = await drive([sse(["data: one\n\n"])], [CHAT], { setup })
		expect(run.observed, run.stderr).toEqual([strings("one")])
		/* each hop as its method, URL, authorization, content type and JSON body */
		const sent = hops.map((h) => [h.method, h.url, h.headers.authorization, h.headers["content-type"], h.body.json])
		expect(sent).toEqual([["POST", "/chat?model=m", "Bearer tok", "application/json", { q: "hi" }]])
	})
})

describe.skipIf(!DOTNET)("what bounds an SSE call: the timeout its open, the token all of it", SLOW, () => {
	/* ported: python sse.test.ts:391 (300 ms and 400 ms bounds against a 500 ms gap; red under M15) */
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

	/* replaces python sse.test.ts:406 (httpx2's timeout extension has no .NET analog; contract 50 Q-d11) */
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

	/* ported: python sse.test.ts:415 (the method's token; a 300 ms cancel against an answer held 3 s) */
	it("bounds the open by the method's token: a slow answer is the caller's OCE via return, its one request sent", async () => {
		const script: Script = { calls: [null, { cancel: { afterMs: 300 } }] }
		const replies = [TICK, { ...TICK, delayMs: 3000 }]
		const { hops, run } = await drive(replies, [ticks({ timeoutMs: 0 }), ticks()], { script })
		const call = run.trace?.calls[1]
		expect({ error: call?.error, hops: hops.length, observed: run.observed }, run.stderr).toEqual({
			error: expect.objectContaining({ canceled: true, via: "return" }),
			hops: 2,
			observed: [TICKED, null],
		})
		expect(call?.elapsedMs).toBeLessThan(2000)
	})
})

describe.skipIf(!DOTNET)("how an open SSE stream ends: the method's token, take", SLOW, () => {
	/* ported: python sse.test.ts:451 (the cancel 1,000 ms in, the next event held 5,000 ms; red under M2) */
	it("ends an open stream when the method's token fires: the events so far, the OCE traced, the connection let go", async () => {
		const held = sse(["data: 1\n\n", { waitMs: 5000 }, "data: 2\n\n"], "hold")
		/* the third call's answer waits until the held stream's client left (gone.ts): the driver still runs */
		const next = gone(sse(["data: z\n\n"]), { stream: 1 })
		const script: Script = { calls: [null, { cancel: { afterMs: 1000 } }] }
		const { run } = await drive([WARMED, held, next.reply], [WARM, text(), text()], { script })
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
	})

	/* ported: python sse.test.ts:470 (the driver never disposes, so this is the SDK's break; red under M1) */
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

/** `Raw` on a stream open: the status, the URL sent, the content type and the empty body, then the stream's event. */
const RAW = `using var c = Client();
var raw = new RawResponse();
await using var s = await c.Ticks.StreamAsync(since: 5, options: new RequestOptions { Raw = raw });
Note($"{raw.Status} {raw.Url} {raw.Headers["content-type"]} {raw.Body.Length}");
await foreach (var ev in s)
{
    Note($"{ev.Data.N}");
}`

/** A stream read to its end, then asked for a second enumerator. */
const ONCE = `using var c = Client();
var s = await c.Text.StreamAsync();
await foreach (var ev in s)
{
    Note(ev.Data);
}
try
{
    s.GetAsyncEnumerator();
    Note("read again");
}
catch (InvalidOperationException e)
{
    Note($"{e.GetType().Name}: {e.Message}");
}`

describe.skipIf(!DOTNET)("an EventStream's open and its one cursor, through the public API", SLOW, () => {
	/* ported: python contract 34 s-typed's raw (`34-…:245`) */
	it("fills RequestOptions.Raw at the open: the 200, the URL sent, its content type and an empty body", async () => {
		const { run, url } = await served([TICK], async (server) => ({
			run: await consume("sse", "raw-stream", { base: server.url, body: RAW }),
			url: server.url,
		}))
		expect(seen(run), run.stderr).toEqual({ out: [`200 ${url}/ticks?since=5 text/event-stream 0`, "1"], ran: true })
	})

	/* Fd1: a live connection has one cursor */
	it("is read once: a second GetAsyncEnumerator throws InvalidOperationException", async () => {
		const run = await served([sse(["data: a\n\n", "data: b\n\n"])], (server) =>
			consume("sse", "read-once", { base: server.url, body: ONCE }),
		)
		expect(seen(run), run.stderr).toEqual({
			out: ["a", "b", "InvalidOperationException: an EventStream is read once"],
			ran: true,
		})
	})
})
