/**
 * An SSE operation in the Python SDK (contract 34 §2.1, §6.1; Rust's `sse.test.ts` analog), driven on the `sse`
 * registry document (shared/__fixtures__/documents-streams.ts): awaiting the `AsyncSDK` method opens the stream
 * and returns `EventStream[T]`, `T` from the declared event schema, an async iterator of `SseEvent[T]` and an
 * async context manager with `aclose()` and `last_event_id`; an error status raises its class before any event,
 * in either mode; the request carries `accept`, `Last-Event-ID` (none for an empty cursor), the merged headers,
 * the declared params, the body and the token; a typed stream ends at an event that does not decode or is not the
 * schema's JSON kind (Fd5), the error raised once. Once open no timeout bounds a stream (its connect, write and
 * pool keep the call's), while `options["cancel"]` and dropping it end it quietly (Fd1, Fd4). Streams are
 * `AsyncSDK`'s alone (G2). The hooks and the log on the open are `sse.hooks.test.ts`; the parser is
 * `sse.parse.test.ts`.
 */
import { describe, expect, it } from "vitest"
import type { Call, Observed, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { PythonError, Script } from "../shared/__fixtures__/protocol.ts"
import { gone } from "../shared/__fixtures__/gone.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { checked, consume, seen } from "./__fixtures__/consumer.ts"
import { type DrivenPythonSdk, drivenPythonSdk } from "./__fixtures__/driven.ts"
import { withPython } from "./__fixtures__/python-env.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 }

const route = (method: string, path: string) => ({ method, path })
const ticks = (extra: Partial<Call> = {}): Call => ({
	operation: "ticks.stream",
	route: route("GET", "/ticks"),
	...extra,
})
const text = (extra: Partial<Call> = {}): Call => ({ operation: "text.stream", route: route("GET", "/text"), ...extra })
const pending = (id: string): Call => ({
	operation: "pending.stream",
	params: { id },
	route: route("GET", "/pending/{id}"),
})
/* fixtures-safe's v0 SSE op (documents.ts merges python/sse.json under `/sse`): its stream in safe mode */
const SAFE_EVENTS: Call = { operation: "sse.events.stream", route: route("GET", "/sse/events/stream") }
const CHAT: Call = {
	body: { kind: "json", value: { q: "hi" } },
	operation: "chat.send",
	route: route("POST", "/chat"),
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
const strings = (...data: string[]): Observed => ({ events: data.map((d) => ({ data: d })), kind: "events" })

/** The registry SDK `key` with the driver aimed at it, which must import. */
function driven(key: "fixtures-safe" | "sse" = "sse"): DrivenPythonSdk {
	const sdk = drivenPythonSdk(key)
	expect(sdk.imported, sdk.stderr).toBe(true)
	return sdk
}

type Options = { readonly script?: Script; readonly setup?: Setup; readonly sdk?: DrivenPythonSdk }
/** `calls` run on `AsyncSDK` against a server answering `replies`: the run, hops and streams. */
async function drive(replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	const sdk = options.sdk ?? driven()
	return served(replies, async (server) => {
		const cell = { calls, setup: options.setup ?? {} }
		const run = await sdk.runCalls(cell, { url: server.url }, { client: "async", script: options.script })
		return { hops: [...server.hops], run, streams: [...server.streams] }
	})
}

/** A traced error as a leg pins it: its class, chain, status when it has one, text, and where it came from. */
const errorOf = (e: PythonError | undefined) =>
	e && { chain: e.chain, status: e.status, text: e.text, type: e.type, via: e.via }

/**
 * A typed stream and a text one, opened and read through the public API: the cursor before and after an id, the
 * stream as an `AsyncIterator`, `aclose()` and `async with` each letting the connection go while the program runs.
 * Each next open is the release point of the stream before it (gone.ts): the text stream's, then a last one's.
 */
const TYPED = `from collections.abc import AsyncIterator

async with aclient() as c:
    s = await c.ticks.stream()
    note(repr(s.last_event_id))
    ev = await anext(s)
    note(f"{ev.data['n']} {ev.id} {s.last_event_id}")
    note(f"{type(s).__name__} {isinstance(s, AsyncIterator)}")
    await s.aclose()
    async with await c.text.stream() as t:
        note((await anext(t)).data)
    async with await c.text.stream() as last:
        note((await anext(last)).data)`

/** What mypy holds of the stream methods: `EventStream[Tick]` and `EventStream[str]`, and what it refuses. */
const TYPES = [
	"from typing import assert_type",
	"",
	"import honey_sdk as sdk",
	"",
	"",
	"async def run(c: sdk.AsyncSDK) -> None:",
	'    s: sdk.EventStream[sdk.Tick] = await c.ticks.stream(since=5, last_event_id="7")',
	"    ev = await anext(s)",
	"    assert_type(ev, sdk.SseEvent[sdk.Tick])",
	"    assert_type(ev.data, sdk.Tick)",
	"    assert_type(s.last_event_id, str)",
	"    await s.aclose()",
	"    async with await c.text.stream() as t:",
	"        async for e in t:",
	"            assert_type(e.data, str)",
	"    wrong: sdk.EventStream[str] = await c.ticks.stream()",
	'    await c.ticks.stream(reconnect_token="r")',
	"    print(wrong)",
	"",
	"",
	"print(sdk.SDK().ticks)",
]
/** The finding mypy gives at `line` of TYPES, as `<line>: <message>`. */
const at = (line: string, message: string) => `${TYPES.indexOf(line) + 1}: ${message}`

describe.skipIf(!PY)("an SSE method: awaiting it opens EventStream[T], an async iterator of SseEvent[T]", SLOW, () => {
	// v0: 7e7eeffad8
	// v0: dc6bf18cd5
	it("reads a typed event with its id and the stream's cursor, and aclose and async with let the connection go", async () => {
		/* the text stream's answer waits until the typed stream's client left, the last one's until the text's */
		const [afterTyped, afterText] = [gone(sse(["data: a\n\n"], "hold")), gone(sse(["data: z\n\n"]), { stream: 1 })]
		const replies = [sse(['id: 7\ndata: {"n":1}\n\n'], "hold"), afterTyped.reply, afterText.reply]
		const run = await served(replies, (server) => consume("sse", "typed_stream", { base: server.url, body: TYPED }))
		const released = [afterTyped.released(), afterText.released()]
		expect({ ...seen(run), released }, run.stderr).toEqual({
			out: ["''", "1 7 7", "EventStream True", "a", "z"],
			ran: true,
			released: [true, true],
		})
	})

	// v0: 7e7eeffad8
	it("types the methods EventStream[Tick] and EventStream[str], refuses a WebSocket cursor, and SDK has none", () => {
		/* V0BUG: v0's SSEEvent data was an untyped str (ruling G15); G2: streams are AsyncSDK's alone */
		const findings = checked("sse", `${TYPES.join("\n")}\n`).map((line) =>
			line.replace(/^[^:]+:(\d+): error: /, "$1: "),
		)
		expect(findings).toEqual([
			at(
				"    wrong: sdk.EventStream[str] = await c.ticks.stream()",
				'Incompatible types in assignment (expression has type "EventStream[Tick]", variable has type "EventStream[str]")  [assignment]',
			),
			at(
				'    await c.ticks.stream(reconnect_token="r")',
				'Unexpected keyword argument "reconnect_token" for "stream" of "AsyncTicksResource"  [call-arg]',
			),
			at("print(sdk.SDK().ticks)", '"SDK" has no attribute "ticks"  [attr-defined]'),
		])
	})
})

describe.skipIf(!PY)("an SSE stream's events: data decoded as T, the event and id, the stream's end", SLOW, () => {
	it("decodes each event's data into T with its event and id, and keeps a string stream's data as sent", async () => {
		const replies = [sse([tick(1), tick(2), tick(3)]), sse(['data: {"a":1}\n\n'])]
		const { run } = await drive(replies, [ticks({ take: 3 }), text()])
		expect(run.observed, run.stderr).toEqual([
			{ events: [1, 2, 3].map((n) => ({ data: { n }, event: "tick", id: String(n) })), kind: "events" },
			strings('{"a":1}'),
		] satisfies Observed[])
	})

	// v0: c00bdd765e
	it("yields a text stream's events in order with their ids, then ends at the end of the body", async () => {
		/* v0 asserted len >= 1 and a tautology (hasattr(first, "data") or isinstance(first, object)) */
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

describe.skipIf(!PY)("an SSE stream's failures and typed headers: raised once, then the end (Fd1, Fd5)", SLOW, () => {
	// v0: 7e7eeffad8
	it("ends a typed stream at an event that does not decode or is not a JSON object: one DecodeError, nothing after", async () => {
		/* contract 34 §3.4 #2, #3: HEAD's EventStream yields the error and reads on, and delivers `5` as a Tick */
		const replies = [
			sse(['data: {"n":1}\n\n', "data: nope\n\n", 'data: {"n":3}\n\n']),
			sse(["data: 5\n\n", 'data: {"n":2}\n\n']),
		]
		const { run } = await drive(replies, [ticks(), ticks()], { script: {} })
		const decoded = {
			chain: ["DecodeError", "HoneyError"],
			status: undefined,
			text: "an event's data is not a JSON object",
			type: "DecodeError",
			via: "stream",
		}
		expect(
			{
				calls: run.trace?.calls.map(({ error, stream }) => ({ error: errorOf(error), stream })),
				observed: run.observed,
			},
			run.stderr,
		).toEqual({
			calls: [
				{ error: decoded, stream: { retry: [null], yields: 2 } },
				{ error: decoded, stream: { yields: 1 } },
			],
			observed: [TICKED, { events: [], kind: "events" }],
		})
	})

	it("fills the typed headers at the open: the declared X-Stream-Id when the answer sends it, nothing when not", async () => {
		/* contract 34 §3.4 #1: HEAD never fills an SSE call's headers_into */
		const replies = [{ ...TICK, headers: { "x-stream-id": "s-1" } }, TICK]
		const { run } = await drive(replies, [ticks(), ticks()], { script: {} })
		expect({ headers: run.trace?.calls.map((c) => c.stream?.headers), observed: run.observed }, run.stderr).toEqual({
			headers: [{ "x-stream-id": "s-1" }, undefined],
			observed: [TICKED, TICKED],
		})
	})
})

/** The two error statuses an open answers, and what each call observes and traces: the same in either mode. */
const FAILED_OPENS: Reply[] = [
	{ json: { message: "nope" }, status: 404 },
	{ json: { message: "boom" }, status: 500 },
]
const failedOpens = ({ hops, run }: Awaited<ReturnType<typeof drive>>) => ({
	calls: run.trace?.calls.map(({ error, stream }) => ({ error: errorOf(error), stream })),
	hops: hops.length,
	observed: run.observed,
})
const FAILED_OPENED = {
	calls: [
		{
			error: {
				chain: ["NotFoundError", "APIStatusError", "HoneyError"],
				status: 404,
				text: "HTTP 404: nope",
				type: "NotFoundError",
				via: "return",
			},
			stream: undefined,
		},
		{
			error: {
				chain: ["InternalServerError", "APIStatusError", "HoneyError"],
				status: 500,
				text: "HTTP 500: boom",
				type: "InternalServerError",
				via: "return",
			},
			stream: undefined,
		},
	],
	hops: 2,
	observed: [
		{ body: { message: "nope" }, errorKey: null, kind: "error", status: 404 },
		{ body: { message: "boom" }, errorKey: null, kind: "error", status: 500 },
	] satisfies Observed[],
}

describe.skipIf(!PY)("an SSE open that fails: its status class raised before any event, in either mode", SLOW, () => {
	// v0: ff9fbb8384
	it("raises an error status's APIStatusError subclass from the await, never as a stream's first event", async () => {
		/* V0BUG: v0's _open_stream ran on_request only (_runtime.py:813-815, survey 8); v1's open is the shared exchange (sse.hooks.test.ts) */
		const opened = await drive(FAILED_OPENS, [ticks(), ticks()], { script: {} })
		expect(failedOpens(opened), opened.run.stderr).toEqual(FAILED_OPENED)
	})

	// v0: ff9fbb8384
	it("raises it the same in safe mode: a stream ignores throwOnError, its error via return, never a result", async () => {
		const opened = await drive(FAILED_OPENS, [SAFE_EVENTS, SAFE_EVENTS], { script: {}, sdk: driven("fixtures-safe") })
		expect(failedOpens(opened), opened.run.stderr).toEqual(FAILED_OPENED)
	})

	it("fails a bad path param before any request: null, a PathParamError via return, no hop", async () => {
		const { hops, run } = await drive([], [pending("..")], { script: {} })
		const call = run.trace?.calls[0]
		expect(
			{ hops: hops.length, observed: run.observed, stream: call?.stream, type: call?.error?.type },
			run.stderr,
		).toEqual({ hops: 0, observed: [null], stream: undefined, type: "PathParamError" })
		expect(call?.error?.via).toBe("return")
	})
})

describe.skipIf(!PY)("an SSE request on the wire: accept and Last-Event-ID", SLOW, () => {
	// v0: 1d58736a77
	it("asks for text/event-stream, and a per-call accept header wins", async () => {
		const { hops, run } = await drive([TICK, TICK], [ticks(), ticks({ headers: { accept: "text/plain" } })])
		expect({ accept: hops.map((hop) => hop.headers.accept), observed: run.observed }, run.stderr).toEqual({
			accept: ["text/event-stream", "text/plain"],
			observed: [TICKED, TICKED],
		})
	})

	// v0: dc6bf18cd5
	it("sends last_event_id as Last-Event-ID, and no such header without one or for an empty one", async () => {
		const calls = [ticks({ lastEventId: "evt-5" }), ticks(), ticks({ lastEventId: "" })]
		const { hops, run } = await drive([TICK, TICK, TICK], calls)
		expect({ ids: hops.map((hop) => hop.headers["last-event-id"]), observed: run.observed }, run.stderr).toEqual({
			ids: ["evt-5", undefined, undefined],
			observed: [TICKED, TICKED, TICKED],
		})
	})
})

describe.skipIf(!PY)("an SSE request on the wire: headers, params, method, body and auth", SLOW, () => {
	it("sends the config's headers with the call's merged over them, one value each", async () => {
		const setup: Setup = { headers: { "X-Both": "cfg", "X-Cfg": "1" } }
		const call = ticks({ headers: { "x-both": "call", "x-call": "1" } })
		const { hops, run } = await drive([TICK], [call], { setup })
		expect(run.observed, run.stderr).toEqual([TICKED])
		expect(hops.map(({ headers }) => [headers["x-cfg"], headers["x-both"], headers["x-call"]])).toEqual([
			["1", "call", "1"],
		])
	})

	// v0: 690fdb61ac
	it("sends the declared query and header params", async () => {
		const call = ticks({ headers: { "x-tenant": "acme" }, search: { since: 5 } })
		const { hops, run } = await drive([TICK], [call])
		expect(run.observed, run.stderr).toEqual([TICKED])
		expect(hops.map(({ headers, method, url }) => ({ method, tenant: headers["x-tenant"], url }))).toEqual([
			{ method: "GET", tenant: "acme", url: "/ticks?since=5" },
		])
	})

	// v0: 690fdb61ac
	// v0: e035a8555e
	it("sends a POST stream's method, query, JSON body and bearer token, then yields its events", async () => {
		const setup: Setup = { auth: { kind: "bearer", token: "tok" } }
		const { hops, run } = await drive([sse(["data: one\n\n"])], [CHAT], { setup })
		expect(run.observed, run.stderr).toEqual([strings("one")])
		expect(
			hops.map(({ body, headers, method, url }) => ({
				authorization: headers.authorization,
				body: body.json,
				contentType: headers["content-type"],
				method,
				url,
			})),
		).toEqual([
			{
				authorization: "Bearer tok",
				body: { q: "hi" },
				contentType: "application/json",
				method: "POST",
				url: "/chat?model=m",
			},
		])
	})
})

/** A `MockTransport` client that records each request's timeout extension, behind a client with `timeout=5`. */
const TIMEOUTS = `import httpx2

seen = []


async def handler(request):
    seen.append(request.extensions.get("timeout"))
    return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=b"data: 1\\n\\n")


http = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
async with aclient(timeout=5, async_http_client=http) as c:
    s = await c.text.stream()
    note([e.data async for e in s])
note(seen)
await http.aclose()`

describe.skipIf(!PY)(
	"what bounds an SSE call: the call's timeout bounds the open, never the stream's reads",
	SLOW,
	() => {
		// v0: 8805daee95
		it("is not cut by the client's or the call's timeout: a gap past both still delivers the next event", async () => {
			/* N-H60: v0's 6 s gap could not see a read bound above 6 s; here the gap is past both bounds set */
			const reply = sse(["data: 1\n\n", { waitMs: 500 }, "data: 2\n\n"])
			const { run } = await drive([reply], [text({ timeoutMs: 100 })], { script: {}, setup: { timeoutMs: 200 } })
			const call = run.trace?.calls[0]
			expect({ error: call?.error, observed: run.observed }, run.stderr).toEqual({
				error: undefined,
				observed: [strings("1", "2")],
			})
			/* the gap really outlasted both bounds: the server paused 500 ms between the events */
			expect(call?.elapsedMs).toBeGreaterThanOrEqual(450)
		})

		// v0: 8805daee95
		// v0: 31aba57f46
		it("sends the open with the client's timeout for connect, write and pool, and none for read", async () => {
			/* contract 34 §3.4 #8: HEAD sends all four as None */
			const run = await consume("sse", "timeouts", { body: TIMEOUTS })
			expect({ ran: run.ran, out: run.out?.main?.map((line) => JSON.parse(line)) }, run.stderr).toEqual({
				out: [["1"], [{ connect: 5, pool: 5, read: null, write: 5 }]],
				ran: true,
			})
		})

		it("bounds the open with options['cancel']: a slow answer is CanceledError via return, one hop, well before it comes", async () => {
			const slow: Reply = { ...TICK, delayMs: 3_000 }
			const { hops, run } = await drive([slow], [ticks()], { script: { calls: [{ cancel: { afterMs: 1000 } }] } })
			const call = run.trace?.calls[0]
			expect({ error: errorOf(call?.error), hops: hops.length, observed: run.observed }, run.stderr).toEqual({
				error: {
					chain: ["CanceledError", "HoneyError"],
					status: undefined,
					text: "the call was canceled",
					type: "CanceledError",
					via: "return",
				},
				hops: 1,
				observed: [null],
			})
			expect(call?.elapsedMs).toBeLessThan(2_500)
		})
	},
)

/** A stream dropped after a read and one dropped unread, no aclose either time, then the program's next open. */
const DROPPED = `async with aclient() as c:
    s = await c.ticks.stream()
    note((await anext(s)).data["n"])
    del s
    s = await c.ticks.stream()
    del s
    async with await c.ticks.stream() as last:
        note((await anext(last)).data["n"])`

describe.skipIf(!PY)("how an open SSE stream ends: the call's cancel, dropping it", SLOW, () => {
	/*
	 * Fd4: options["cancel"] races every read, so it also ends an open stream, quietly. sdk.driver.stream.test.ts
	 * pins the driver's half with `take 2`; this is the behavior with no `take`: the cancel alone ends a stream
	 * that never would, and lets the connection go while the run goes on.
	 */
	it("ends an open stream when the call's cancel fires: the events so far, no error, the connection let go", async () => {
		const held = sse(["data: 1\n\n"], "hold")
		/* the second call's answer waits until the first stream's client left (gone.ts): the driver still runs */
		const next = gone(sse(["data: z\n\n"]))
		const script: Script = { calls: [{ cancel: { afterMs: 1000 } }] }
		const { run } = await drive([held, next.reply], [text(), text()], { script })
		const calls = run.trace?.calls ?? []
		expect(
			{ errors: calls.map((call) => call.error), observed: run.observed, released: next.released() },
			run.stderr,
		).toEqual({
			errors: [undefined, undefined],
			observed: [strings("1"), strings("z")],
			released: true,
		})
		expect(calls[0]?.elapsedMs).toBeGreaterThanOrEqual(950)
		expect(calls[0]?.elapsedMs).toBeLessThan(5_000)
	})

	it("closes the connection when the reads stop at take, before the run goes on", async () => {
		const spaced = sse(["data: 1\n\n", { waitMs: 50 }, "data: 2\n\n", { waitMs: 50 }, "data: 3\n\n"], "hold")
		/* the second call's answer waits until the first stream's client left (gone.ts): the driver still runs */
		const next = gone(sse(["data: z\n\n"]))
		const { run } = await drive([spaced, next.reply], [text({ take: 1 }), text()], { script: {} })
		expect({ observed: run.observed, released: next.released() }, run.stderr).toEqual({
			observed: [strings("1"), strings("z")],
			released: true,
		})
		expect(run.trace?.calls[0]?.elapsedMs).toBeLessThan(1_000)
	})

	it("lets the connection go when a stream is dropped unclosed, read or never read, while the program runs", async () => {
		/* Fd1's ordered finalizer: each next open's answer waits until the dropped stream's client left (gone.ts) */
		const [afterRead, afterUnread] = [gone(sse(['data: {"n":2}\n\n'], "hold")), gone(TICK, { stream: 1 })]
		const run = await served([sse(['data: {"n":1}\n\n'], "hold"), afterRead.reply, afterUnread.reply], (server) =>
			consume("sse", "dropped", { base: server.url, body: DROPPED }),
		)
		const released = [afterRead.released(), afterUnread.released()]
		expect({ ...seen(run), released }, run.stderr).toEqual({ out: ["1", "1"], ran: true, released: [true, true] })
	})
})
