/**
 * The C# test driver's streams (contract 50 §4.4; Python's and Rust's `sdk.driver.stream.test.ts` analog): each
 * stream operation's call plan; SSE events read with `take`, the typed headers, `retry` and the stream's error; a
 * `take` that lets the connection go while the run goes on (the driver never disposes what it observed, so this is
 * the SDK's own `break` path); the method's token ending an open stream quietly, its OCE traced; the 10 s watchdog;
 * what the driver refuses on a stream, nothing sent; then a WebSocket's script and its ends, and a realtime
 * connection over WebSocket. Driven against the `sse`, `ws` and `realtime` registry documents
 * (shared/__fixtures__/documents-streams.ts, and C#'s `clash.feed` beside `realtime`). The refusals run on
 * hand-written plans against a dependency-free dll: they come before the SDK loads.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Observed } from "../../../tests/integration/conformance/matrix.ts"
import { gone } from "../shared/__fixtures__/gone.ts"
import type { Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { compiledCSharp } from "./__fixtures__/compiled.ts"
import { execDotnet, withDotnet } from "./__fixtures__/csharp-env.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { type DrivenCSharpSdk, drivenCSharpSdk, driverDll } from "./__fixtures__/driven.ts"
import type { CSharpCallPlan } from "./sdk-plan.ts"
import { csharpCallPlans } from "./sdk.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

type StreamKey = "realtime" | "sse" | "ws"

const route = (method: string, path: string) => ({ method, path })
const ticks = (extra: Partial<Call> = {}): Call => ({
	operation: "ticks.stream",
	route: route("GET", "/ticks"),
	...extra,
})
const text = (extra: Partial<Call> = {}): Call => ({ operation: "text.stream", route: route("GET", "/text"), ...extra })
const rooms = (extra: Partial<Call> = {}): Call => ({
	operation: "rooms.socket",
	params: { room: "r" },
	route: route("GET", "/rooms/{room}"),
	...extra,
})
const live = (extra: Partial<Call> = {}): Call => ({
	operation: "feed.live",
	route: route("GET", "/feed"),
	search: { channel: "c" },
	...extra,
})
const ECHO: Call = { operation: "echo.get", route: route("GET", "/echo") }
const tick = (n: number) => `data: {"n":${n}}\n\n`
const sse = (steps: readonly (string | { waitMs: number })[], end: "close" | "drop" | "hold" = "close"): Reply => ({
	sse: { end, steps },
	status: 200,
})
const ws = (steps: NonNullable<Reply["ws"]>["steps"]): Reply => ({ status: 101, ws: { steps } })
/** An untyped stream's events as observed: each text its event's data. */
const strings = (...texts: readonly string[]): Observed => ({ events: texts.map((data) => ({ data })), kind: "events" })
/** A stream's OCE as traced: the method's token ended it (Fd2), via the stream (contract 50 §4.3). */
const CANCELED = expect.objectContaining({ canceled: true, via: "stream" })
const CONNECTION = ["ApiConnectionException", "HoneyException"]

/** The registry document `key`'s call plans. */
const plansOf = (key: StreamKey) => csharpCallPlans(FIXTURES[key].document())

/** The registry SDK `key` with the driver aimed at it, which must build. */
function on(key: StreamKey): DrivenCSharpSdk {
	const sdk = drivenCSharpSdk(key)
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

/** `calls` run by `sdk` against a server answering `replies`, under `script` when given: the run, hops and streams. */
async function drive(sdk: DrivenCSharpSdk, replies: readonly Reply[], calls: readonly Call[], script?: Script) {
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: {} }, { url: server.url }, { script })
		return { hops: [...server.hops], run, streams: [...server.streams] }
	})
}

/** A stream plan in the emitter's names, written by hand: the refusals come before the SDK loads. */
const plan = (
	operation: string,
	accessor: string,
	method: string,
	stream: CSharpCallPlan["stream"],
): CSharpCallPlan => ({
	accessors: [accessor],
	body: null,
	headers: {},
	idempotencyKey: null,
	method,
	operation,
	path: [],
	query: {},
	required: [],
	response: "none",
	responseHeaders: null,
	stream,
})
const PLANS: Readonly<Record<string, CSharpCallPlan>> = {
	"echo.get": plan("echo.get", "Echo", "GetAsync", null),
	"feed.live": plan("feed.live", "Feed", "LiveAsync", "realtime"),
	"rooms.socket": plan("rooms.socket", "Rooms", "SocketAsync", "ws"),
	"ticks.stream": plan("ticks.stream", "Ticks", "StreamAsync", "sse"),
}

/** Each control a call cannot take as its operation streams (or does not), its script when it is one, and the reason. */
const STREAM_REFUSALS: readonly (readonly [Call, Script | undefined, string])[] = [
	[ticks({ send: ["x"] }), undefined, "send on an SSE operation: only a WebSocket or realtime call sends"],
	[
		ticks({ reconnectToken: "t" }),
		undefined,
		"reconnectToken on an SSE operation: only a WebSocket or realtime call resumes by token",
	],
	[
		ticks(),
		{ calls: [{ protocols: ["v1"] }] },
		"protocols on an SSE operation: only a WebSocket or realtime dial offers subprotocols",
	],
	[ticks(), { calls: [{ realtime: {} }] }, "a realtime script on an SSE operation"],
	[ticks(), { calls: [{ ws: { on: true } }] }, "a ws script on an SSE operation"],
	[ticks({ raw: true }), undefined, "raw: true on an SSE operation, which has no single response to read"],
	[
		rooms({ lastEventId: "1" }),
		undefined,
		"lastEventId on a WebSocket operation: only an SSE or realtime call resumes by event id",
	],
	[rooms(), { calls: [{ realtime: { maxReconnectAttempts: 1 } }] }, "a realtime script on a WebSocket operation"],
	[rooms({ raw: true }), undefined, "raw: true on a WebSocket operation, which has no single response to read"],
	[live(), undefined, "a realtime call needs take: the connection never ends by itself"],
	[live({ take: 1 }), { calls: [{ ws: { on: true } }] }, "a ws script on a realtime operation"],
	[live({ raw: true, take: 1 }), undefined, "raw: true on a realtime operation, which has no single response to read"],
	[{ ...ECHO, take: 1 }, undefined, "take on an operation that does not stream"],
	[{ ...ECHO, send: ["x"] }, undefined, "send on an operation that does not stream"],
	[{ ...ECHO, lastEventId: "1" }, undefined, "lastEventId on an operation that does not stream"],
	[{ ...ECHO, reconnectToken: "t" }, undefined, "reconnectToken on an operation that does not stream"],
	[ECHO, { calls: [{ protocols: ["v1"] }] }, "protocols on an operation that does not stream"],
	[ECHO, { calls: [{ realtime: {} }] }, "a realtime script on an operation that does not stream"],
	[ECHO, { calls: [{ ws: {} }] }, "a ws script on an operation that does not stream"],
]
const REFUSALS = STREAM_REFUSALS.map(
	([call, script, reason]) => [call, script, `call 0 (${call.operation}): ${reason}`] as const,
)

/** What the script decoding refuses for good on a stream call, before any call. */
const SCRIPT_REFUSALS: readonly (readonly [Script, string])[] = [
	[
		{ calls: [{ ws: { readLimit: 1024 } }] },
		"script: call 0: ws.readLimit is Go's SetReadLimit; a C# socket caps a message at 16 MiB",
	],
	[
		{ calls: [{ taskCancel: { afterMs: 150 } }] },
		"script: call 0: taskCancel is a Python AsyncSDK task's; a C# call ends by its token (cancel)",
	],
	[
		{ calls: [{ isErrors: ["ErrSSELineTooLong"] }] },
		"script: call 0: isErrors is Go's errors.Is; the C# trace records the type and text",
	],
	[
		{ calls: [{ ws: { send: [{ json: 1, text: "t" } as never] } }] },
		"script: call 0: ws.send: a message holds exactly one of json, text and bytes",
	],
	[{ calls: [{ ws: { lines: 1 } as never }] }, "script: unknown member lines"],
]

/** What a plan names that a hand-written one must match: its accessors, its method and its stream kind. */
const named = (given?: CSharpCallPlan) => [given?.accessors, given?.method, given?.stream]

describe("csharpCallPlans: a stream operation's plan", () => {
	it("names the stream kind, the typed headers and no idempotency key, and folds the declared params a stream field carries", () => {
		const [events, sockets, feeds] = [plansOf("sse"), plansOf("ws"), plansOf("realtime")]
		expect({
			hand: [feeds["feed.live"], sockets["rooms.socket"], events["ticks.stream"]].map(named),
			live: [feeds["feed.live"]?.query, feeds["feed.live"]?.headers],
			resume: [feeds["feed.resume"]?.query, feeds["feed.resume"]?.headers],
			socket: [sockets["rooms.socket"]?.query, sockets["rooms.socket"]?.stream],
			ticks: events["ticks.stream"],
		}).toEqual({
			/* the hand-written plans the refusals run on name what the emitter's do */
			hand: [PLANS["feed.live"], PLANS["rooms.socket"], PLANS["ticks.stream"]].map(named),
			live: [{ channel: "channel" }, { "x-tenant": "xTenant" }],
			resume: [{ protocols: "protocols2" }, {}],
			socket: [{ since: "since" }, "ws"],
			ticks: expect.objectContaining({
				accessors: ["Ticks"],
				idempotencyKey: null,
				method: "StreamAsync",
				query: { since: "since" },
				responseHeaders: { fields: { "X-Stream-Id": "XStreamId" }, type: "TicksStreamHeaders" },
				stream: "sse",
			}),
		})
	})
})

describe.skipIf(!DOTNET)("the C# test driver: SSE, EventStream<T>", SLOW, () => {
	it("observes typed events with event and id until take, and traces retry (null when unset) and the typed headers", async () => {
		const reply: Reply = {
			headers: { "x-stream-id": "s-1" },
			...sse(['retry: 3000\nid: 1\nevent: tick\ndata: {"n":1}\n\n', tick(2), { waitMs: 50 }, tick(3)], "hold"),
		}
		const call = ticks({ headers: { "x-tenant": "acme" }, lastEventId: "evt-5", search: { since: 5 }, take: 2 })
		const { hops, run, streams } = await drive(on("sse"), [reply, sse(['data: {"a":1}\n\n'])], [call, text()], {})
		expect({ observed: run.observed, streams: run.trace?.calls.map((c) => c.stream) }, run.stderr).toEqual({
			observed: [
				{
					events: [
						{ data: { n: 1 }, event: "tick", id: "1" },
						{ data: { n: 2 }, id: "1" },
					],
					kind: "events",
				},
				strings('{"a":1}'),
			] satisfies Observed[],
			streams: [
				{ headers: { "X-Stream-Id": "s-1" }, retry: [3000, null], yields: 2 },
				{ retry: [null], yields: 1 },
			],
		})
		expect(hops[0]).toMatchObject({
			headers: { accept: "text/event-stream", "last-event-id": "evt-5", "x-tenant": "acme" },
			url: "/ticks?since=5",
		})
		expect(streams[0]?.clientGone).toBe(true)
	})

	it("lets a held stream's connection go at take while the run goes on: the SDK's break, not the driver", async () => {
		const held = sse([tick(1), { waitMs: 100 }, tick(2), { waitMs: 100 }, tick(3)], "hold")
		/* the second call's answer waits until the first stream's client left (gone.ts): the driver still runs */
		const next = gone(sse([tick(9)]))
		const { run } = await drive(on("sse"), [held, next.reply], [ticks({ take: 1 }), ticks()], {})
		expect({ observed: run.observed, released: next.released() }, run.stderr).toEqual({
			observed: [
				{ events: [{ data: { n: 1 } }], kind: "events" },
				{ events: [{ data: { n: 9 } }], kind: "events" },
			],
			released: true,
		})
	})
})

describe.skipIf(!DOTNET)("the C# test driver: how an SSE call fails", SLOW, () => {
	it("observes the events before a dropped connection, the stream's error traced and counted; unscripted, failed as transport", async () => {
		const sdk = on("sse")
		const dropped = sse([tick(1), tick(2), { waitMs: 50 }], "drop")
		const { run } = await drive(sdk, [dropped], [ticks()], {})
		const call = run.trace?.calls[0]
		expect({ error: call?.error, observed: run.observed, stream: call?.stream }, run.stderr).toEqual({
			error: expect.objectContaining({
				chain: CONNECTION,
				text: "the event stream failed",
				type: "ApiConnectionException",
				via: "stream",
			}),
			observed: [{ events: [{ data: { n: 1 } }, { data: { n: 2 } }], kind: "events" }],
			stream: { retry: [null, null], yields: 3 },
		})
		/* unscripted, the grid's stream/mid-drop (bit 21 i0): the events, then the no-answer failure (f2) */
		const bare = await drive(sdk, [dropped], [ticks()])
		expect({ observed: bare.run.observed, status: bare.run.status }, bare.run.stderr).toEqual({
			observed: [{ events: [{ data: { n: 1 } }, { data: { n: 2 } }], failed: "transport", kind: "events" }],
			status: 0,
		})
		/* a drop before any event is no outcome the grid has: unscripted, the run fails */
		const early = await drive(sdk, [sse([{ waitMs: 50 }], "drop")], [ticks()])
		expect({ status: early.run.status, stderr: early.run.stderr }).toEqual({
			status: 1,
			stderr: expect.stringMatching(
				/^driver: call 0 \(ticks\.stream\): the call ended in an error the grid has no outcome for: ApiConnectionException/,
			),
		})
	})

	it("observes an error status at the open as error and a path failing before any stream as null, both via return", async () => {
		const replies: Reply[] = [{ json: { message: "nope" }, status: 404 }]
		const pending: Call = { operation: "pending.stream", params: { id: ".." }, route: route("GET", "/pending/{id}") }
		const { hops, run } = await drive(on("sse"), replies, [ticks(), pending], {})
		const [status, path] = run.trace?.calls ?? []
		expect({ hops: hops.length, observed: run.observed }, run.stderr).toEqual({
			hops: 1,
			observed: [{ body: { message: "nope" }, errorKey: null, kind: "error", status: 404 }, null],
		})
		expect([status?.error?.via, status?.error?.type, status?.stream, path?.error?.type, path?.error?.via]).toEqual([
			"return",
			"NotFoundException",
			undefined,
			"PathParamException",
			"return",
		])
	})
})

describe.skipIf(!DOTNET)("the C# test driver: what ends an SSE call", SLOW, () => {
	it("ends an open stream quietly when the method's token fires after it opened: the events so far, the OCE traced", async () => {
		/* the cancel lands 1,000 ms in, after the first event, and 4,000 ms before the second (the bit-14 timing rule);
		 * one unbounded open first on the same client, so the timed open is never .NET's first request */
		const held = sse(["data: 1\n\n", { waitMs: 5000 }, "data: 2\n\n"], "hold")
		const script: Script = { calls: [null, { cancel: { afterMs: 1000 } }] }
		const warm = text({ take: 1, timeoutMs: 0 })
		const { run } = await drive(on("sse"), [sse(["data: w\n\n"]), held], [warm, text({ take: 2 })], script)
		const call = run.trace?.calls[1]
		expect(
			{ error: call?.error, observed: run.observed, status: run.status, stream: call?.stream },
			run.stderr,
		).toEqual({
			error: CANCELED,
			observed: [strings("w"), strings("1")],
			status: 0,
			stream: { retry: [null], yields: 2 },
		})
		expect(call?.elapsedMs).toBeGreaterThanOrEqual(990)
		expect(call?.elapsedMs).toBeLessThan(4000)
	})

	it("fails the run when a stream never ends: stream stalled, after 10 s", async () => {
		/* the watchdog's own text proves it fired; no wall-clock ceiling, which would span the process spawn */
		const { run } = await drive(on("sse"), [sse([tick(1)], "hold")], [ticks()])
		expect({ status: run.status, stderr: run.stderr.trim() }).toEqual({
			status: 1,
			stderr: "driver: call 0 (ticks.stream): stream stalled: no end within 10s",
		})
	})
})

describe.skipIf(!DOTNET)("the C# test driver: what it refuses on a stream call, nothing sent", SLOW, () => {
	it("exits 1 naming each stream control the operation cannot take, and what is Go's or Python's alone, before the SDK loads", async () => {
		/* the dependency-free `cache` dll stands in for an SDK: every refusal comes before the driver loads one */
		const target = { client: "SseClient", dll: compiledCSharp("cache").dll, namespace: "Sse" }
		const cases = [...REFUSALS, ...SCRIPT_REFUSALS.map(([script, reason]) => [ticks(), script, reason] as const)]
		const { hops, runs } = await served([], async (server) => {
			const ran = []
			for (const [call, script] of cases) {
				const envelope = { base: server.url, cell: { calls: [call] }, plans: PLANS, script, sdk: target }
				ran.push(await execDotnet([driverDll()], { input: JSON.stringify(envelope) }))
			}
			return { hops: server.hops.length, runs: ran }
		})
		expect({ hops, runs: runs.map((run) => [run.status, run.stderr.trim(), run.stdout]) }).toEqual({
			hops: 0,
			runs: cases.map(([, , reason]) => [1, `driver: ${reason}`, ""]),
		})
	})
})

describe.skipIf(!DOTNET)("the C# test driver: a WebSocket, TypedWebSocket", SLOW, () => {
	it("records handlers, sends the grid's text then the scripted JSON, text and bytes, reads take frames, and closes as scripted", async () => {
		const script: Script = {
			calls: [
				{
					ws: {
						close: { code: 1001, reason: "bye" },
						on: true,
						send: [{ json: { a: 1 } }, { text: "t" }, { bytes: 3 }],
					},
				},
			],
		}
		const reply = ws([{ receive: 4 }, { json: { ok: true } }])
		const { run, streams } = await drive(on("ws"), [reply], [rooms({ send: ['{"x":1}'], take: 1 })], script)
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [{ frames: [{ ok: true }], kind: "frames" }],
			stream: {
				handlers: [
					{ data: '{"ok":true}', event: "message" },
					{ data: "bye", event: "close" },
				],
				yields: 1,
			},
		})
		expect(streams[0]?.received).toEqual([
			{ kind: "text", text: '{"x":1}' },
			{ kind: "text", text: '{"a":1}' },
			{ kind: "text", text: "t" },
			{
				kind: "binary",
				sha256: createHash("sha256")
					.update(Buffer.from([0, 1, 2]))
					.digest("hex"),
				size: 3,
			},
			{ code: 1001, kind: "close", reason: "bye" },
		])
	})
})

describe.skipIf(!DOTNET)("the C# test driver: how a WebSocket read ends", SLOW, () => {
	it("ends on the server's close frame as closedBy, and on a drop with the error traced via stream, each end fired once", async () => {
		const replies = [
			ws([{ close: { code: 1000, reason: "done" } }]),
			ws([{ text: "one" }, { waitMs: 50 }, { drop: true }]),
		]
		const script: Script = { calls: [{ ws: { on: true } }, { ws: { on: true } }] }
		const { run } = await drive(on("ws"), replies, [rooms(), rooms()], script)
		const ends = (run.trace?.calls ?? []).map(({ error, stream }) => ({
			chain: error?.chain,
			closeError: stream?.closeError,
			closedBy: stream?.closedBy,
			handlers: stream?.handlers?.map((h) => `${h.event} ${h.data}`),
			via: error?.via,
		}))
		expect(run.observed, run.stderr).toEqual([
			{ frames: [], kind: "frames" },
			{ frames: ["one"], kind: "frames" },
		])
		expect(ends).toEqual([
			{
				chain: undefined,
				closeError: undefined,
				closedBy: { code: 1000, reason: "done" },
				handlers: ["close done"],
				via: undefined,
			},
			{
				chain: CONNECTION,
				closeError: undefined,
				closedBy: undefined,
				handlers: ["message one", "error the WebSocket failed"],
				via: "stream",
			},
		])
	})

	it("keeps reading after a send fails: the server's close frame still waiting is closedBy, the send's error traced", async () => {
		/* the server closes and hangs up as the socket opens; 12 MiB outgrows the client's send buffer, so the send fails */
		const reply = ws([{ close: { code: 4401, hangUp: true, reason: "unauthorized" } }])
		const script: Script = { calls: [{ ws: { on: true, send: [{ bytes: 12 << 20 }] } }] }
		const { run } = await drive(on("ws"), [reply], [rooms()], script)
		const call = run.trace?.calls[0]
		expect(
			{
				closedBy: call?.stream?.closedBy,
				error: [call?.error?.type, call?.error?.via],
				observed: run.observed,
				yields: call?.stream?.yields,
			},
			run.stderr,
		).toEqual({
			closedBy: { code: 4401, reason: "unauthorized" },
			error: ["ApiConnectionException", "stream"],
			observed: [{ frames: [], kind: "frames" }],
			yields: 0,
		})
	})
})

describe.skipIf(!DOTNET)("the C# test driver: realtime, ResumableConnection<T>", SLOW, () => {
	it("opens over WebSocket with the resume cursor, sends the grid's JSON, reads take frames, and traces the settled cursor", async () => {
		const reply = ws([
			{ receive: 1 },
			{ json: { id: "1", n: 1, reconnect_token: "rt-1" } },
			{ json: { id: "2", n: 2, reconnect_token: "rt-2" } },
		])
		const call = live({ lastEventId: "0", reconnectToken: "rt-0", send: ['{"hi":1}'], take: 2 })
		const { hops, run, streams } = await drive(on("realtime"), [reply], [call], {})
		/* `Payload` declares no `id`, so a frame drops it (Rust's serde does too); the cursor still advances by it */
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [
				{
					frames: [
						{ n: 1, reconnect_token: "rt-1" },
						{ n: 2, reconnect_token: "rt-2" },
					],
					kind: "frames",
				},
			],
			stream: {
				realtime: { cursor: { lastEventId: "2", reconnectToken: "rt-2" }, errors: [], proven: "ws" },
				yields: 2,
			},
		})
		expect({ received: streams[0]?.received, url: hops[0]?.url }).toEqual({
			received: [
				{ kind: "text", text: '{"hi":1}' },
				{ code: 1000, kind: "close", reason: "" },
			],
			url: "/feed?channel=c&last_event_id=0&reconnect_token=rt-0",
		})
	})
})
