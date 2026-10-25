/**
 * The Python test driver's streams (contract 34 §5.4, Rust's `sdk.driver.stream.test.ts` analog): each stream
 * operation's call plan; SSE events read through `stream.observe` with `take`, the typed headers, `retry` and the
 * stream's error; a stream that ends the reads while the run goes on; the 10 s watchdog; a cancel and a task's
 * cancellation; what the driver refuses on a stream, nothing sent; then a WebSocket's script and its ends, and a
 * realtime connection over WebSocket. Streams are `AsyncSDK`'s alone (G2), so every driven leg runs on it. Driven
 * against the `sse`, `ws` and `realtime` registry documents (shared/__fixtures__/documents-streams.ts).
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Observed } from "../../../tests/integration/conformance/matrix.ts"
import type { PythonError, Script } from "../shared/__fixtures__/protocol.ts"
import { gone } from "../shared/__fixtures__/gone.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { type DrivenPythonSdk, drivenPythonSdk } from "./__fixtures__/driven.ts"
import { withPython } from "./__fixtures__/python-env.ts"
import { pythonCallPlans } from "./sdk.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 }

type StreamKey = "realtime" | "sse" | "ws"

const route = (method: string, path: string) => ({ method, path })
const ticks = (extra: Partial<Call> = {}): Call => ({
	operation: "ticks.stream",
	route: route("GET", "/ticks"),
	...extra,
})
const text = (): Call => ({ operation: "text.stream", route: route("GET", "/text") })
const socket = (extra: Partial<Call> = {}): Call => ({
	operation: "rooms.socket",
	params: { room: "r" },
	route: route("GET", "/rooms/{room}"),
	...extra,
})
const feed = (extra: Partial<Call> = {}): Call => ({
	operation: "feed.live",
	route: route("GET", "/feed"),
	search: { channel: "c" },
	...extra,
})
const tick = (n: number) => `data: {"n":${n}}\n\n`
const sse = (steps: readonly (string | { waitMs: number })[], end: "close" | "drop" | "hold" = "close"): Reply => ({
	sse: { end, steps },
	status: 200,
})
const ws = (steps: NonNullable<Reply["ws"]>["steps"]): Reply => ({ status: 101, ws: { steps } })

/** The registry document `key`'s call plans. */
const plansOf = (key: StreamKey) => pythonCallPlans(FIXTURES[key].document())

/** The registry SDK `key` with the driver aimed at it, which must import. */
function driven(key: "http" | StreamKey): DrivenPythonSdk {
	const sdk = drivenPythonSdk(key)
	expect(sdk.imported, sdk.stderr).toBe(true)
	return sdk
}

/** `calls` run by `sdk` on `AsyncSDK` against a server answering `replies`, under `script` when given: the run, hops and streams. */
async function drive(sdk: DrivenPythonSdk, replies: readonly Reply[], calls: readonly Call[], script?: Script) {
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls }, { url: server.url }, { client: "async", script })
		return { hops: [...server.hops], run, streams: [...server.streams] }
	})
}

/** A Python error as the trace records it: no cause and the method's own raise unless given, any repr. */
const plain = (entry: Partial<PythonError>) => ({ cause: null, repr: expect.any(String), via: "return", ...entry })

/** Each control an SSE call cannot take, its script when it is one, and the reason the driver exits 1 with. */
const SSE_REFUSALS: readonly (readonly [Call, Script | undefined, string])[] = [
	[
		ticks({ send: ["x"] }),
		undefined,
		"call 0 (ticks.stream): send on an SSE operation: only a WebSocket or realtime call sends",
	],
	[
		ticks({ reconnectToken: "t" }),
		undefined,
		"call 0 (ticks.stream): reconnectToken on an SSE operation: only a WebSocket or realtime call resumes by token",
	],
	[
		ticks(),
		{ calls: [{ protocols: ["v1"] }] },
		"call 0 (ticks.stream): protocols on an SSE operation: only a WebSocket or realtime dial offers subprotocols",
	],
	[ticks(), { calls: [{ realtime: {} }] }, "call 0 (ticks.stream): a realtime script on an SSE operation"],
	[ticks(), { calls: [{ ws: { on: true } }] }, "call 0 (ticks.stream): a ws script on an SSE operation"],
	[
		ticks({ raw: true }),
		undefined,
		"call 0 (ticks.stream): raw: true on an SSE operation, which has no single response to read",
	],
	[
		ticks(),
		{ calls: [{ isErrors: ["ErrSSELineTooLong"] }] },
		"script: call 0: isErrors is Go's errors.Is; the Python trace records the type and text",
	],
	[
		ticks(),
		{ calls: [{ ws: { readLimit: 1024 } }] },
		"script: call 0: ws.readLimit is Go's SetReadLimit; a Python socket caps a message at 16 MiB",
	],
]

describe("pythonCallPlans: a stream operation's plan", () => {
	it("names the stream kind, no SDK method, the typed headers, and the declared params a stream field folds or claims", () => {
		const [events, sockets, live] = [plansOf("sse"), plansOf("ws"), plansOf("realtime")]
		expect({
			live: [live["feed.live"]?.query, live["feed.live"]?.required, live["feed.live"]?.stream],
			resume: live["feed.resume"]?.query,
			socket: [sockets["rooms.socket"]?.query, sockets["rooms.socket"]?.stream, sockets["rooms.socket"]?.sync],
			ticks: events["ticks.stream"],
		}).toEqual({
			live: [{ channel: "channel" }, ["channel"], "realtime"],
			resume: { protocols: "protocols2" },
			socket: [{ since: "since" }, "ws", false],
			ticks: {
				accessors: ["ticks"],
				body: null,
				headers: { "x-tenant": "x_tenant" },
				idempotencyKey: null,
				method: "stream",
				operation: "ticks.stream",
				pathParams: [],
				query: { since: "since" },
				required: [],
				response: "none",
				responseHeaders: { fields: { "X-Stream-Id": "x_stream_id" }, type: "TicksStreamHeaders" },
				stream: "sse",
				sync: false,
			},
		})
	})
})

describe.skipIf(!PY)("the Python test driver: SSE, EventStream[T]", SLOW, () => {
	it("observes typed events with event and id until take, and traces retry (null when unset) and the typed headers", async () => {
		const reply: Reply = {
			headers: { "x-stream-id": "s-1" },
			...sse(['retry: 3000\nid: 1\nevent: tick\ndata: {"n":1}\n\n', tick(2), { waitMs: 50 }, tick(3)], "hold"),
		}
		const call = ticks({ headers: { "x-tenant": "acme" }, lastEventId: "evt-5", search: { since: 5 }, take: 2 })
		const { hops, run, streams } = await drive(driven("sse"), [reply, sse(['data: {"a":1}\n\n'])], [call, text()], {})
		const traced = run.trace?.calls.map((c) => c.stream)
		expect({ observed: run.observed, streams: traced?.map((s) => ({ ...s, headers: undefined })) }, run.stderr).toEqual(
			{
				observed: [
					{
						events: [
							{ data: { n: 1 }, event: "tick", id: "1" },
							{ data: { n: 2 }, id: "1" },
						],
						kind: "events",
					},
					{ events: [{ data: '{"a":1}' }], kind: "events" },
				] satisfies Observed[],
				streams: [
					{ headers: undefined, retry: [3000, null], yields: 2 },
					{ headers: undefined, retry: [null], yields: 1 },
				],
			},
		)
		expect(hops[0]).toMatchObject({
			headers: { accept: "text/event-stream", "last-event-id": "evt-5", "x-tenant": "acme" },
			url: "/ticks?since=5",
		})
		expect(streams[0]?.clientGone).toBe(true)
		/* the typed headers the open fills (contract 34 §3.4 #1): red until the runtime fills `headers_into` (2b) */
		expect(traced?.map((s) => s?.headers)).toEqual([{ "x-stream-id": "s-1" }, undefined])
	})

	it("ends a held stream's reads at take while the run goes on: the client leaves before the next call", async () => {
		const held = sse([tick(1), { waitMs: 100 }, tick(2), { waitMs: 100 }, tick(3)], "hold")
		/* the second call's answer waits until the first stream's client left (gone.ts): the driver still runs */
		const next = gone(sse([tick(9)]))
		const { run } = await drive(driven("sse"), [held, next.reply], [ticks({ take: 1 }), ticks()], {})
		expect({ observed: run.observed, released: next.released() }, run.stderr).toEqual({
			observed: [
				{ events: [{ data: { n: 1 } }], kind: "events" },
				{ events: [{ data: { n: 9 } }], kind: "events" },
			],
			released: true,
		})
	})
})

describe.skipIf(!PY)("the Python test driver: how an SSE call fails", SLOW, () => {
	it("observes the events before a dropped connection, the stream's error traced; unscripted, the run fails", async () => {
		const sdk = driven("sse")
		const dropped = sse([tick(1), { waitMs: 50 }], "drop")
		const { run } = await drive(sdk, [dropped], [ticks()], {})
		const call = run.trace?.calls[0]
		expect({ observed: run.observed, stream: call?.stream, via: call?.error?.via }, run.stderr).toEqual({
			observed: [{ events: [{ data: { n: 1 } }], kind: "events" }],
			stream: { retry: [null], yields: 2 },
			via: "stream",
		})
		expect(call?.error?.chain).toEqual(["APIConnectionError", "HoneyError"])
		const bare = await drive(sdk, [dropped], [ticks()])
		expect({ status: bare.run.status, stderr: bare.run.stderr }).toEqual({
			status: 1,
			stderr: expect.stringMatching(
				/^driver: call 0 \(ticks\.stream\): the call ended in an error the grid has no outcome for: /,
			),
		})
	})

	it("observes an error status at the open as error and a path failing before any stream as null, both via return", async () => {
		const replies: Reply[] = [{ json: { message: "nope" }, status: 404 }]
		const pending: Call = { operation: "pending.stream", params: { id: ".." }, route: route("GET", "/pending/{id}") }
		const { hops, run } = await drive(driven("sse"), replies, [ticks(), pending], {})
		const [status, path] = run.trace?.calls ?? []
		expect({ hops: hops.length, observed: run.observed }, run.stderr).toEqual({
			hops: 1,
			observed: [{ body: { message: "nope" }, errorKey: null, kind: "error", status: 404 }, null],
		})
		expect([status?.error?.via, status?.error?.type, status?.stream, path?.error?.type, path?.error?.via]).toEqual([
			"return",
			"NotFoundError",
			undefined,
			"PathParamError",
			"return",
		])
	})
})

describe.skipIf(!PY)("the Python test driver: what ends an SSE call", SLOW, () => {
	it("ends an open stream quietly when the call's cancel fires after it opened: the events so far, no error", async () => {
		const held = sse([tick(1), { waitMs: 3000 }, tick(2)], "hold")
		const script: Script = { calls: [{ cancel: { afterMs: 1000 } }] }
		const { run } = await drive(driven("sse"), [held], [ticks({ take: 2 })], script)
		expect({ error: run.trace?.calls[0]?.error, observed: run.observed }, run.stderr).toEqual({
			error: undefined,
			observed: [{ events: [{ data: { n: 1 } }], kind: "events" }],
		})
		expect(run.trace?.calls[0]?.elapsedMs).toBeLessThan(2500)
	})

	it("runs the open and the reads in the call's task: a task cancelled mid-read observes null, CancelledError via return", async () => {
		const held = sse([tick(1), { waitMs: 2000 }, tick(2)], "hold")
		const script: Script = { calls: [{ taskCancel: { afterMs: 150 } }] }
		const { run } = await drive(driven("sse"), [held], [ticks({ take: 2 })], script)
		expect({ error: run.trace?.calls[0]?.error, observed: run.observed }, run.stderr).toEqual({
			error: plain({ chain: ["CancelledError"], text: "", type: "CancelledError" }),
			observed: [null],
		})
		expect(run.trace?.calls[0]?.elapsedMs).toBeLessThan(1000)
	})

	it("fails the run when a stream never ends: stream stalled, after 10 s", async () => {
		const started = Date.now()
		const { run } = await drive(driven("sse"), [sse([tick(1)], "hold")], [ticks()])
		expect({ status: run.status, stderr: run.stderr.trim() }).toEqual({
			status: 1,
			stderr: "driver: call 0 (ticks.stream): stream stalled: no end within 10s",
		})
		expect(Date.now() - started).toBeLessThan(12_000)
	})
})

describe.skipIf(!PY)("the Python test driver: what it refuses on a stream call, nothing sent", SLOW, () => {
	it("exits 1 naming each control that does not fit an SSE call, and Go's isErrors and ws.readLimit for good", async () => {
		const sdk = driven("sse")
		const [runs, hops] = await served([], async (server) => {
			const ran = []
			for (const [call, script] of SSE_REFUSALS)
				ran.push(await sdk.runCalls({ calls: [call] }, server, { client: "async", script }))
			return [ran, server.hops.length] as const
		})
		expect({ hops, runs: runs.map((run) => [run.status, run.stderr.trim()]) }).toEqual({
			hops: 0,
			runs: SSE_REFUSALS.map(([, , reason]) => [1, `driver: ${reason}`]),
		})
		const bad = await sdk.runCalls(
			{ calls: [ticks()] },
			{ url: "http://127.0.0.1:9" },
			{ client: "async", script: { calls: [{ ws: { send: [{ json: 1, text: "t" } as never] } }] } },
		)
		expect({ status: bad.status, stderr: bad.stderr }).toEqual({
			status: 1,
			stderr: expect.stringMatching(/^driver: script: /),
		})
	})

	it("refuses lastEventId on a WebSocket, a realtime call without take, take on a call that does not stream, and SDK", async () => {
		const echo: Call = { operation: "echo.get", route: route("GET", "/echo"), take: 1 }
		const runs = await served([], async (server) => {
			const ran = [
				await driven("ws").runCalls({ calls: [socket({ lastEventId: "1" })] }, server, { client: "async" }),
				await driven("realtime").runCalls({ calls: [feed()] }, server, { client: "async" }),
				await driven("http").runCalls({ calls: [echo] }, server, { client: "async" }),
				await driven("sse").runCalls({ calls: [ticks()] }, server, { client: "sync" }),
			]
			return { hops: server.hops.length, stderr: ran.map((run) => [run.status, run.stderr.trim()]) }
		})
		expect(runs).toEqual({
			hops: 0,
			stderr: [
				[
					1,
					"driver: call 0 (rooms.socket): lastEventId on a WebSocket operation: only an SSE or realtime call resumes by event id",
				],
				[1, "driver: call 0 (feed.live): a realtime call needs take: the connection never ends by itself"],
				[1, "driver: call 0 (echo.get): take on an operation that does not stream"],
				[1, "driver: call 0 (ticks.stream): SDK has no method for this operation"],
			],
		})
	})
})

/*
 * The WebSocket and realtime legs read the phase-d surface (contract 34 §5.4): `TypedWebSocket.closed_by` and
 * `ResumableConnection.proven_transport`. Against the committed runtime the driver exits 1 with the AttributeError
 * naming them (the Fb8 precedent); they go green at 2a/2b.
 */
describe.skipIf(!PY)("the Python test driver: a WebSocket, TypedWebSocket", SLOW, () => {
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
		const { run, streams } = await drive(driven("ws"), [reply], [socket({ send: ['{"x":1}'], take: 1 })], script)
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

describe.skipIf(!PY)("the Python test driver: how a WebSocket read ends", SLOW, () => {
	it("ends on the server's close frame as closedBy, and on a drop with the error traced via stream, each end fired once", async () => {
		const replies = [
			ws([{ close: { code: 1000, reason: "done" } }]),
			ws([{ text: "one" }, { waitMs: 50 }, { drop: true }]),
		]
		const script: Script = { calls: [{ ws: { on: true } }, { ws: { on: true } }] }
		const { run } = await drive(driven("ws"), replies, [socket(), socket()], script)
		const ends = (run.trace?.calls ?? []).map(({ error, stream }) => ({
			closedBy: stream?.closedBy,
			handlers: stream?.handlers?.map((h) => `${h.event} ${h.event === "error" ? "…" : h.data}`),
			via: error?.via,
		}))
		expect(run.observed, run.stderr).toEqual([
			{ frames: [], kind: "frames" },
			{ frames: ["one"], kind: "frames" },
		])
		expect(ends).toEqual([
			{ closedBy: { code: 1000, reason: "done" }, handlers: ["close done"], via: undefined },
			{ closedBy: undefined, handlers: ["message one", "error …"], via: "stream" },
		])
	})

	it("keeps reading after a send fails: the server's close frame still waiting is closedBy, the send's error traced", async () => {
		/*
		 * the server closes and hangs up as the socket opens. asyncio buffers a write, so the 12 MiB send returns once
		 * the hang-up ends it; the send after it then fails, the server's close frame already read
		 */
		const reply = ws([{ close: { code: 4401, hangUp: true, reason: "unauthorized" } }])
		const script: Script = { calls: [{ ws: { on: true, send: [{ bytes: 12 << 20 }, { text: "after" }] } }] }
		const { run } = await drive(driven("ws"), [reply], [socket()], script)
		const call = run.trace?.calls[0]
		expect({ error: call?.error?.via, observed: run.observed, stream: call?.stream }, run.stderr).toEqual({
			error: "stream",
			observed: [{ frames: [], kind: "frames" }],
			stream: {
				closedBy: { code: 4401, reason: "unauthorized" },
				handlers: [{ data: "unauthorized", event: "close" }],
				yields: 0,
			},
		})
		/* a failed send is the SDK's own error (contract 34 §1: a TCP failure is APIConnectionError), never wsproto's, whose text carries the whole message */
		expect(call?.error?.chain).toEqual(["APIConnectionError", "HoneyError"])
	})
})

describe.skipIf(!PY)("the Python test driver: realtime, ResumableConnection[T]", SLOW, () => {
	it("opens over WebSocket with the resume cursor, sends the grid's JSON, reads take frames, and traces the settled cursor", async () => {
		const reply = ws([
			{ receive: 1 },
			{ json: { id: "1", n: 1, reconnect_token: "rt-1" } },
			{ json: { id: "2", n: 2, reconnect_token: "rt-2" } },
		])
		const call = feed({ lastEventId: "0", reconnectToken: "rt-0", send: ['{"hi":1}'], take: 2 })
		const { hops, run, streams } = await drive(driven("realtime"), [reply], [call], {})
		/* a TypedDict payload is not narrowed at runtime: each frame keeps the `id` Rust's serde drops */
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [
				{
					frames: [
						{ id: "1", n: 1, reconnect_token: "rt-1" },
						{ id: "2", n: 2, reconnect_token: "rt-2" },
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

	it("sends a send that is no JSON as its raw text, a JSON string as JSON (sweep 14)", async () => {
		const reply = ws([{ receive: 2 }, { json: { n: 1 } }])
		const { run, streams } = await drive(driven("realtime"), [reply], [feed({ send: ["hello", '"hi"'], take: 1 })], {})
		expect(streams[0]?.received?.slice(0, 2), run.stderr).toEqual([
			{ kind: "text", text: "hello" },
			{ kind: "text", text: '"hi"' },
		])
	})
})
