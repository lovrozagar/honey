/**
 * An SSE operation in the Rust SDK (contract 20 §2.1, §5.1; the Go `sse.test.ts` analog), driven on the `sse`
 * registry document (documents-streams.ts): the method is a `Call<EventStream<T>[, <Op>Headers]>`, `T` from the
 * declared event schema, and the stream a `futures_util::Stream` of `Result<SseEvent<T>, Error>`; an error status
 * is `Err(Error::Api)` before any event, in either mode; the request carries `accept`, `Last-Event-ID` (none for
 * an empty cursor), the merged headers, the declared params, the body and the token; a typed stream ends at an
 * event that does not decode. Once open no timeout bounds a stream, while `cancel_on` (Fd6, ruled the
 * alternative) and dropping it end it. The hooks and the log on the open are `sse.hooks.test.ts`; the parser
 * is `sse.parse.test.ts`.
 */
import { describe, expect, it } from "vitest"
import type { Call, Observed, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { RustError, Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordingServer, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenRustSdk, drivenRustSdk } from "./__fixtures__/driven.ts"
import { consume, sections, seen } from "./__fixtures__/consumer.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()
const CARGO = 600_000

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
/* fixtures-safe's v0 SSE op (documents.ts merges it under `/sse`): its stream in safe mode */
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

const sdks = new Map<"fixtures-safe" | "sse", DrivenRustSdk>()
/** The `sse` SDK (or the safe-mode `fixtures-safe`) compiled with the driver, once: it must build. */
function driven(key: "fixtures-safe" | "sse" = "sse"): DrivenRustSdk {
	const sdk = sdks.get(key) ?? drivenRustSdk(key)
	sdks.set(key, sdk)
	expect({ built: sdk.built }, sdk.stderr).toEqual({ built: true })
	return sdk
}

type Options = { readonly script?: Script; readonly setup?: Setup; readonly sdk?: DrivenRustSdk }
/** `calls` run against a server answering `replies`: the run, hops and streams. */
async function drive(replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	const sdk = options.sdk ?? driven()
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: options.setup ?? {} }, server, options.script)
		return { hops: [...server.hops], run, streams: [...server.streams] }
	})
}

/** Poll `check` every 10 ms until it holds, for at most 12 s (past the driver's 10 s watchdog). */
async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 1200 && !check(); i++) await new Promise((wake) => setTimeout(wake, 10))
}

/** `running`'s result, and whether `server` saw stream 0's client leave while it still ran (not at its exit). */
async function leftWhileRunning<T>(server: RecordingServer, running: Promise<T>) {
	const state = { ended: false }
	const watched = running.finally(() => (state.ended = true))
	const gone = () => server.streams[0]?.clientGone === true
	await until(() => state.ended || gone())
	return { goneWhileRunning: !state.ended && gone(), result: await watched }
}

/** A traced error as a leg pins it: its variant, kind and status when it has them, and where it came from. */
const errorOf = (e: RustError | undefined) =>
	e && { kind: e.kind, status: e.status, text: e.text, variant: e.variant, via: e.via }

/**
 * Holds both stream methods in their declared types and a stream as a boxed `Stream` (compiling is the
 * assertion), reads one event through `StreamExt`, and notes its `data.n`, `id` and the stream's cursor.
 */
const TYPED = sections({
	typed: `    let c = client(base)?;
    let call: sdk::Call<sdk::EventStream<sdk::Tick>, sdk::TicksStreamHeaders> = c.ticks().stream(&sdk::TicksStreamOpts::default());
    let _: sdk::Call<sdk::EventStream<String>> = c.text().stream(&sdk::TextStreamOpts::default());
    let mut s: sdk::EventStream<sdk::Tick> = call.await?;
    let first: Option<Result<sdk::SseEvent<sdk::Tick>, sdk::Error>> = futures_util::StreamExt::next(&mut s).await;
    let ev = first.expect("one event")?;
    n.note(format!("{} {} {}", ev.data.n, ev.id, s.last_event_id()));
    stored(Box::new(s));`,
})
const STORED =
	"fn stored(_: Box<dyn futures_util::Stream<Item = Result<sdk::SseEvent<sdk::Tick>, sdk::Error>> + Unpin>) {}"

/** What the compiler refuses: a WebSocket cursor on an SSE op's Opts, and a typed stream held as a text one. */
const REFUSED = `fn no_ws_cursor() -> sdk::TicksStreamOpts {
    sdk::TicksStreamOpts { reconnect_token: None, ..Default::default() }
}

fn typed_is_not_text(c: &sdk::Client) -> sdk::Call<sdk::EventStream<String>, sdk::TicksStreamHeaders> {
    c.ticks().stream(&sdk::TicksStreamOpts::default())
}`

describe.skipIf(!RUST)("an SSE method: Call<EventStream<T>>, a Stream of Result<SseEvent<T>, Error>", () => {
	// v0: fd79926b03
	it(
		"holds EventStream<Tick> with its typed headers and EventStream<String>, and reads one as a boxed Stream with its cursor",
		async () => {
			const run = await served([sse(['id: 7\ndata: {"n":1}\n\n'])], (server) =>
				consume("sse", "typed_stream", { base: server.url, body: TYPED.body, decls: `${TYPED.decls}\n\n${STORED}` }),
			)
			expect(seen(run, "typed"), run.stderr).toEqual({ built: true, out: ["1 7 7"] })
		},
		CARGO,
	)

	// v0: fd79926b03
	it(
		"refuses a WebSocket cursor on the SSE Opts and a typed stream held as a text one, at compile time",
		async () => {
			const run = await consume("sse", "sse_refused", { body: 'n.note("built");', decls: REFUSED })
			expect(
				{
					built: run.built,
					cursor: /error\[E0560\]: struct `TicksStreamOpts` has no field named `reconnect_token`/.test(run.stderr),
					typed: /error\[E0308\]: mismatched types/.test(run.stderr),
				},
				run.stderr,
			).toEqual({ built: false, cursor: true, typed: true })
		},
		CARGO,
	)

	// v0: fd79926b03
	it("decodes each event's data into T with its event and id, and keeps a string stream's data as sent", async () => {
		const replies = [sse([tick(1), tick(2), tick(3)]), sse(['data: {"a":1}\n\n'])]
		const { run } = await drive(replies, [ticks({ take: 3 }), text()])
		expect(run.observed, run.stderr).toEqual([
			{ events: [1, 2, 3].map((n) => ({ data: { n }, event: "tick", id: String(n) })), kind: "events" },
			strings('{"a":1}'),
		] satisfies Observed[])
	}, 600_000)

	// v0: fd79926b03
	it("ends a typed stream at an event that does not decode: the events before it, one Decode error, nothing after", async () => {
		/* a committed-code defect (contract 20, the defects at HEAD, 3): HEAD's EventStream yields the error and reads on (yields 3) */
		const reply = sse(['data: {"n":1}\n\n', "data: nope\n\n", 'data: {"n":3}\n\n'])
		const { run } = await drive([reply], [ticks()], { script: {} })
		const call = run.trace?.calls[0]
		expect({ observed: run.observed, stream: call?.stream }, run.stderr).toEqual({
			observed: [TICKED],
			stream: { retry: [null], yields: 2 },
		})
		expect({ text: call?.error?.text, variant: call?.error?.variant, via: call?.error?.via }).toEqual({
			text: expect.stringMatching(/^decode: /),
			variant: "Decode",
			via: "stream",
		})
	}, 600_000)
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
			error: { kind: "NotFound", status: 404, text: "404 Not Found: nope", variant: "Api", via: "return" },
			stream: undefined,
		},
		{
			error: {
				kind: "InternalServer",
				status: 500,
				text: "500 Internal Server Error: boom",
				variant: "Api",
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

describe.skipIf(!RUST)("an SSE open that fails: Err(Error::Api) before any event, in either mode", () => {
	// v0: 9e9ae72622
	it("resolves an error status to a typed Api error with no stream, never a stream's first item", async () => {
		/* V0BUG: v0 yielded the error status as the stream's first item (codegen-rust.ts:715); v1's call is Err before any stream */
		const opened = await drive(FAILED_OPENS, [ticks(), ticks()], { script: {} })
		expect(failedOpens(opened), opened.run.stderr).toEqual(FAILED_OPENED)
	}, 600_000)

	// v0: 9e9ae72622
	it("resolves it the same in safe mode: a stream ignores throwOnError, its error via return, never a result", async () => {
		const opened = await drive(FAILED_OPENS, [SAFE_EVENTS, SAFE_EVENTS], { script: {}, sdk: driven("fixtures-safe") })
		expect(failedOpens(opened), opened.run.stderr).toEqual(FAILED_OPENED)
	}, 600_000)

	it("fails a bad path param before any request: null, a PathParam error via return, no hop", async () => {
		const { hops, run } = await drive([], [pending("..")], { script: {} })
		const call = run.trace?.calls[0]
		expect(
			{ hops: hops.length, observed: run.observed, stream: call?.stream, variant: call?.error?.variant },
			run.stderr,
		).toEqual({ hops: 0, observed: [null], stream: undefined, variant: "PathParam" })
		expect(call?.error?.via).toBe("return")
	}, 600_000)
})

describe.skipIf(!RUST)("an SSE request on the wire: accept and Last-Event-ID", () => {
	// v0: 6e7d0244ad
	it("asks for text/event-stream, and a per-call accept header wins", async () => {
		const { hops, run } = await drive([TICK, TICK], [ticks(), ticks({ headers: { accept: "text/plain" } })])
		expect({ accept: hops.map((hop) => hop.headers.accept), observed: run.observed }, run.stderr).toEqual({
			accept: ["text/event-stream", "text/plain"],
			observed: [TICKED, TICKED],
		})
	}, 600_000)

	// v0: 34fa37e963
	it("sends lastEventId as Last-Event-ID, and no such header without one or for an empty one", async () => {
		/* a committed-code defect (contract 20, the defects at HEAD, 4): HEAD sends `Last-Event-ID: ` for Some(""); WHATWG and Go send none */
		const calls = [ticks({ lastEventId: "evt-5" }), ticks(), ticks({ lastEventId: "" })]
		const { hops, run } = await drive([TICK, TICK, TICK], calls)
		expect({ ids: hops.map((hop) => hop.headers["last-event-id"]), observed: run.observed }, run.stderr).toEqual({
			ids: ["evt-5", undefined, undefined],
			observed: [TICKED, TICKED, TICKED],
		})
	}, 600_000)
})

describe.skipIf(!RUST)("an SSE request on the wire: headers, params, method, body and auth", () => {
	// v0: 415a27aa0a
	it("sends the config's headers with the call's merged over them, one value each", async () => {
		const setup: Setup = { headers: { "X-Both": "cfg", "X-Cfg": "1" } }
		const call = ticks({ headers: { "x-both": "call", "x-call": "1" } })
		const { hops, run } = await drive([TICK], [call], { setup })
		expect(run.observed, run.stderr).toEqual([TICKED])
		expect(hops.map(({ headers }) => [headers["x-cfg"], headers["x-both"], headers["x-call"]])).toEqual([
			["1", "call", "1"],
		])
	}, 600_000)

	// v0: 21cd2e88c0
	it("sends the declared query and header params", async () => {
		const call = ticks({ headers: { "x-tenant": "acme" }, search: { since: 5 } })
		const { hops, run } = await drive([TICK], [call])
		expect(run.observed, run.stderr).toEqual([TICKED])
		expect(hops.map(({ headers, method, url }) => ({ method, tenant: headers["x-tenant"], url }))).toEqual([
			{ method: "GET", tenant: "acme", url: "/ticks?since=5" },
		])
	}, 600_000)

	// v0: 0d2b9f5b96
	// v0: 21cd2e88c0
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
	}, 600_000)
})

describe.skipIf(!RUST)("what bounds an SSE call: cancel_on bounds the open, no timeout bounds the stream", () => {
	it("is not cut by the client's or the call's timeout: a gap past both still delivers the next event", async () => {
		const reply = sse(["data: 1\n\n", { waitMs: 500 }, "data: 2\n\n"])
		const { run } = await drive([reply], [text({ timeoutMs: 100 })], { script: {}, setup: { timeoutMs: 200 } })
		const call = run.trace?.calls[0]
		expect({ error: call?.error, observed: run.observed }, run.stderr).toEqual({
			error: undefined,
			observed: [strings("1", "2")],
		})
		/* the gap really outlasted both bounds: the server paused 500 ms between the events */
		expect(call?.elapsedMs).toBeGreaterThanOrEqual(450)
	}, 600_000)

	it("bounds the open with cancel_on: a slow answer is Canceled via return, one hop, well before it comes", async () => {
		const slow: Reply = { ...TICK, delayMs: 2_000 }
		const { hops, run } = await drive([slow], [ticks()], { script: { calls: [{ cancel: { afterMs: 100 } }] } })
		const call = run.trace?.calls[0]
		expect({ error: errorOf(call?.error), hops: hops.length, observed: run.observed }, run.stderr).toEqual({
			error: { kind: undefined, status: undefined, text: "the call was canceled", variant: "Canceled", via: "return" },
			hops: 1,
			observed: [null],
		})
		expect(call?.elapsedMs).toBeLessThan(1_500)
	}, 600_000)
})

describe.skipIf(!RUST)("how an open SSE stream ends: the call's cancel, dropping it", () => {
	/*
	 * Fd6, ruled the alternative: `cancel_on` also ends an open stream, quietly. sdk.driver.stream.test.ts
	 * ("ends an open stream quietly when the call's cancel fires after it opened") pins the driver's half: a
	 * held stream read to `take 2` ends at the cancel with 1 event. This is the behavior with no `take`: the
	 * cancel alone ends a stream that never would, and lets the connection go while the run goes on.
	 */
	it("ends an open stream when the call's cancel fires: the events so far, no error, the connection let go", async () => {
		const held = sse(["data: 1\n\n"], "hold")
		/* a second call after a 2 s pause keeps the driver alive, so its exit cannot be what closed the body */
		const script: Script = { calls: [{ cancel: { afterMs: 150 } }, { sleepMs: 2_000 }] }
		const { goneWhileRunning, run } = await served([held, sse(["data: z\n\n"])], async (server) => {
			const watched = await leftWhileRunning(server, driven().runCalls({ calls: [text(), text()] }, server, script))
			return { goneWhileRunning: watched.goneWhileRunning, run: watched.result }
		})
		const calls = run.trace?.calls ?? []
		expect({ errors: calls.map((call) => call.error), goneWhileRunning, observed: run.observed }, run.stderr).toEqual({
			errors: [undefined, undefined],
			goneWhileRunning: true,
			observed: [strings("1"), strings("z")],
		})
		expect(calls[0]?.elapsedMs).toBeGreaterThanOrEqual(140)
		expect(calls[0]?.elapsedMs).toBeLessThan(5_000)
	}, 600_000)

	it("closes the connection when the stream is dropped, before the run goes on", async () => {
		const spaced = sse(["data: 1\n\n", { waitMs: 50 }, "data: 2\n\n", { waitMs: 50 }, "data: 3\n\n"], "hold")
		/* a second call after a 2 s pause keeps the driver alive, so its exit cannot be what closed the body */
		const script: Script = { calls: [null, { sleepMs: 2_000 }] }
		const { goneWhileRunning, run } = await served([spaced, sse(["data: z\n\n"])], async (server) => {
			const running = driven().runCalls({ calls: [text({ take: 1 }), text()] }, server, script)
			const watched = await leftWhileRunning(server, running)
			return { goneWhileRunning: watched.goneWhileRunning, run: watched.result }
		})
		expect({ goneWhileRunning, observed: run.observed }, run.stderr).toEqual({
			goneWhileRunning: true,
			observed: [strings("1"), strings("z")],
		})
		expect(run.trace?.calls[0]?.elapsedMs).toBeLessThan(1_000)
	}, 600_000)
})
