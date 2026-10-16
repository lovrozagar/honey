import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Observed } from "../../../tests/integration/conformance/matrix.ts"
import { compiledSdk, type DrivenSdk, type Script } from "./__fixtures__/compiled.ts"
import { consume } from "./__fixtures__/consumer.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { type Reply, served } from "./__fixtures__/recording-server.ts"
import { generateGoSdk } from "./sdk.ts"

type Json = Record<string, unknown>

const STRING = { type: "string" }
const events = (schema: Json, extra: Json = {}) => ({
	200: { content: { "text/event-stream": { schema } }, description: "ok", ...extra },
})

/** A WebSocket op, a typed and a string SSE op, and a realtime op: one of each stream the driver drives. */
const STREAMS: Json = {
	components: { schemas: { Tick: { properties: { n: { type: "integer" } }, required: ["n"], type: "object" } } },
	info: { title: "Streams", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/feed": {
			get: {
				operationId: "feed.live",
				parameters: [{ in: "query", name: "channel", required: true, schema: STRING }],
				responses: events({ $ref: "#/components/schemas/Tick" }),
				"x-realtime": true,
				"x-websocket": true,
			},
		},
		"/rooms/{room}": {
			get: {
				operationId: "rooms.socket",
				parameters: [{ in: "path", name: "room", required: true, schema: STRING }],
				responses: { 101: { description: "upgrade" } },
				"x-websocket": true,
			},
		},
		"/text/{id}": {
			get: {
				operationId: "text.stream",
				parameters: [{ in: "path", name: "id", required: true, schema: STRING }],
				responses: events(STRING),
			},
		},
		"/ticks": {
			get: {
				operationId: "ticks.stream",
				parameters: [{ in: "query", name: "since", schema: { type: "integer" } }],
				responses: events({ $ref: "#/components/schemas/Tick" }, { headers: { "X-Stream-Id": { schema: STRING } } }),
			},
		},
	},
}

let compiled: DrivenSdk | undefined
/** The STREAMS SDK with the driver, compiled once; it must build and vet clean. */
function streamsSdk(): DrivenSdk {
	compiled ??= compiledSdk(STREAMS, { modulePath: "example.com/streams" })
	expect({ built: compiled.built, vet: compiled.vet }, compiled.stderr).toEqual({ built: true, vet: [] })
	return compiled
}

const route = (path: string) => ({ method: "GET", path })
const socket = (extra: Partial<Call> = {}): Call => ({
	operation: "rooms.socket",
	params: { room: "r" },
	route: route("/rooms/{room}"),
	...extra,
})
const ticks = (extra: Partial<Call> = {}): Call => ({ operation: "ticks.stream", route: route("/ticks"), ...extra })
const feed = (extra: Partial<Call> = {}): Call => ({
	operation: "feed.live",
	route: route("/feed"),
	search: { channel: "c" },
	...extra,
})
const text = (id: string): Call => ({ operation: "text.stream", params: { id }, route: route("/text/{id}") })
const sse = (steps: readonly (string | { waitMs: number })[], end: "close" | "drop" | "hold" = "close"): Reply => ({
	sse: { end, steps },
	status: 200,
})
const ws = (steps: NonNullable<Reply["ws"]>["steps"]): Reply => ({ status: 101, ws: { steps } })
const sha = (n: number) =>
	createHash("sha256")
		.update(Buffer.from(Array.from({ length: n }, (_, i) => i & 0xff)))
		.digest("hex")

/** `calls` run by `sdk` against a server answering `replies`, under `script` when given: the run, hops and streams. */
async function drive(sdk: DrivenSdk, replies: readonly Reply[], calls: readonly Call[], script?: Script) {
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls }, server, script)
		return { hops: [...server.hops], run, streams: [...server.streams] }
	})
}

describe("the Go test driver: SSE, iter.Seq2[SSEEvent[T], error]", () => {
	it("observes typed events with event and id, breaks out after take, and traces retry and the typed headers", async () => {
		if (!withGo()) return
		const reply: Reply = {
			headers: { "x-stream-id": "s-1" },
			...sse(
				[
					'retry: 3000\nid: 1\nevent: tick\ndata: {"n":1}\n\n',
					'data: {"n":2}\n\n',
					{ waitMs: 50 },
					'data: {"n":3}\n\n',
				],
				"hold",
			),
		}
		const call = ticks({ lastEventId: "evt-5", search: { since: 5 }, take: 2 })
		const { hops, run, streams } = await drive(streamsSdk(), [reply], [call], {})
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [
				{
					events: [
						{ data: { n: 1 }, event: "tick", id: "1" },
						{ data: { n: 2 }, id: "1" },
					],
					kind: "events",
				},
			],
			stream: { headers: { "x-stream-id": "s-1" }, retry: [3000, 0], yields: 2 },
		})
		expect(hops[0]).toMatchObject({
			headers: { accept: "text/event-stream", "last-event-id": "evt-5" },
			url: "/ticks?since=5",
		})
		expect(streams[0]?.clientGone).toBe(true)
	}, 600_000)
})

describe("the Go test driver: SSE errors and string data", () => {
	it("observes the events before an undecodable one, its error traced, and an error status before any event as error", async () => {
		if (!withGo()) return
		const sdk = streamsSdk()
		const replies = [sse(['data: {"n":1}\n\n', "data: nope\n\n"]), { json: { message: "nope" }, status: 404 }]
		const { run } = await drive(sdk, replies, [ticks(), ticks()], {})
		const [decode, status] = run.trace?.calls ?? []
		expect(run.observed, run.stderr).toEqual([
			{ events: [{ data: { n: 1 } }], kind: "events" },
			{ body: { message: "nope" }, errorKey: null, kind: "error", status: 404 },
		] satisfies Observed[])
		expect({
			decode: decode?.error?.text,
			status: status?.error?.status,
			streams: [decode?.stream, status?.stream],
		}).toEqual({
			decode: expect.stringMatching(/^honey: decode sse event:/),
			status: 404,
			streams: [{ retry: [0], yields: 2 }, { yields: 1 }],
		})
		expect([decode?.error?.via, status?.error?.via]).toEqual(["stream", "stream"])
		const bare = await served(replies.slice(0, 1), (server) => sdk.runCalls({ calls: [ticks()] }, server))
		expect({ status: bare.status, stderr: bare.stderr }).toEqual({
			status: 1,
			stderr: expect.stringMatching(/honey: decode sse event/),
		})
	}, 600_000)
	it("observes a string stream's data as sent, a path failing before the stream as no events, and asks isErrors", async () => {
		if (!withGo()) return
		const long = `data: ${"x".repeat(2 ** 20 + 1)}\n\n`
		const replies = [sse(['data: {"a":1}\n\n']), sse(["data: ok\n\n", long])]
		const script: Script = { calls: [null, null, { isErrors: ["ErrSSELineTooLong", "ErrSSEEventTooLarge"] }] }
		const { hops, run } = await drive(streamsSdk(), replies, [text("a"), text(".."), text("b")], script)
		expect(run.observed, run.stderr).toEqual([
			{ events: [{ data: '{"a":1}' }], kind: "events" },
			{ events: [], kind: "events" },
			{ events: [{ data: "ok" }], kind: "events" },
		])
		const [, path, cap] = run.trace?.calls ?? []
		expect({ cap: cap?.error?.sentinels, hops: hops.length, path: path?.error?.pathParam }).toEqual({
			cap: { ErrSSEEventTooLarge: false, ErrSSELineTooLong: true },
			hops: 2,
			path: { missing: false, name: "id", value: ".." },
		})
	}, 600_000)
})

describe("the Go test driver: an SSE call's ctx", () => {
	it("ends quietly when the call's ctx ends mid-stream: the events so far, no error", async () => {
		if (!withGo()) return
		const script: Script = { calls: [{ cancel: { afterMs: 150 } }] }
		const { run } = await drive(streamsSdk(), [sse(['data: {"n":1}\n\n'], "hold")], [ticks()], script)
		expect({ error: run.trace?.calls[0]?.error, observed: run.observed }, run.stderr).toEqual({
			error: undefined,
			observed: [{ events: [{ data: { n: 1 } }], kind: "events" }],
		})
	}, 600_000)
})

describe("the Go test driver: a WebSocket's script, (*TypedWebSocket, error)", () => {
	it("records handlers, sends scripted JSON, text and bytes after the grid's send, and closes with the scripted code", async () => {
		if (!withGo()) return
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
		const { run, streams } = await drive(streamsSdk(), [reply], [socket({ send: ['{"x":1}'], take: 1 })], script)
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
			{ kind: "binary", sha256: sha(3), size: 3 },
			{ code: 1001, kind: "close", reason: "bye" },
		])
	}, 600_000)
})

describe("the Go test driver: how a WebSocket read ends", () => {
	it("ends on the server's close frame as closedBy, and on a drop or an over-limit frame with the error traced", async () => {
		if (!withGo()) return
		const replies = [
			ws([{ close: { code: 1000, reason: "done" } }]),
			ws([{ text: "one" }, { waitMs: 50 }, { drop: true }]),
			ws([{ json: "x".repeat(2048) }]),
		]
		const script: Script = {
			calls: [{ ws: { on: true } }, { ws: { on: true } }, { ws: { on: true, readLimit: 1024 } }],
		}
		const { run } = await drive(streamsSdk(), replies, [socket(), socket(), socket()], script)
		const ends = (run.trace?.calls ?? []).map(({ error, stream }) => ({
			closedBy: stream?.closedBy,
			handlers: stream?.handlers?.map((h) => `${h.event} ${h.event === "error" ? "…" : h.data}`),
			via: error?.via,
		}))
		expect(run.observed, run.stderr).toEqual([
			{ frames: [], kind: "frames" },
			{ frames: ["one"], kind: "frames" },
			{ frames: [], kind: "frames" },
		])
		expect(ends).toEqual([
			{ closedBy: { code: 1000, reason: "done" }, handlers: ["close done"], via: undefined },
			{ closedBy: undefined, handlers: ["message one", "error …", "close "], via: "stream" },
			{ closedBy: undefined, handlers: ["error …", "close "], via: "stream" },
		])
	}, 600_000)

	it("fails the run when a stream never ends: stream stalled, after 10 s", async () => {
		if (!withGo()) return
		const started = Date.now()
		const { run } = await drive(streamsSdk(), [ws([])], [socket()])
		expect({ status: run.status, stderr: run.stderr.trim() }).toEqual({
			status: 1,
			stderr: "driver: call 0 (rooms.socket): stream stalled: no end within 10s",
		})
		expect(Date.now() - started).toBeLessThan(15_000)
	}, 600_000)
})

describe("the Go test driver: realtime, (*ResumableConnection, error)", () => {
	it("opens over WebSocket with the resume cursor, sends, reads take frames, and traces the settled cursor", async () => {
		if (!withGo()) return
		const reply = ws([
			{ receive: 1 },
			{ json: { id: "1", n: 1, reconnect_token: "rt-1" } },
			{ json: { id: "2", n: 2, reconnect_token: "rt-2" } },
		])
		const call = feed({ lastEventId: "0", reconnectToken: "rt-0", send: ["hello"], take: 2 })
		const { hops, run, streams } = await drive(streamsSdk(), [reply], [call], {})
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
				{ kind: "text", text: "hello" },
				{ code: 1000, kind: "close", reason: "client close" },
			],
			url: "/feed?channel=c&last_event_id=0&reconnect_token=rt-0",
		})
	}, 600_000)

	it("falls back to SSE when the upgrade is refused, and to long-poll when SSE is refused too", async () => {
		if (!withGo()) return
		const sdk = streamsSdk()
		const refused = { json: { message: "no" }, status: 404 }
		const replies = [refused, sse(['id: 3\ndata: {"n":3,"reconnect_token":"rt-3"}\n\n'], "hold")]
		const script: Script = { calls: [{ realtime: { reconnectDelayMs: 10 } }] }
		const { hops, run } = await drive(sdk, replies, [feed({ take: 1 })], script)
		expect({ observed: run.observed, realtime: run.trace?.calls[0]?.stream?.realtime }, run.stderr).toEqual({
			observed: [{ frames: [{ n: 3, reconnect_token: "rt-3" }], kind: "frames" }],
			realtime: { cursor: { lastEventId: "3", reconnectToken: "rt-3" }, errors: [], proven: "sse" },
		})
		expect(hops.map((hop) => hop.headers.accept)).toEqual([undefined, "text/event-stream"])
		const polled = { json: { id: "7", n: 1, reconnect_token: "rt-7" }, status: 200 }
		const chain = await drive(sdk, [refused, { status: 503, text: "" }, polled], [feed({ take: 1 })], script)
		expect({ observed: chain.run.observed, proven: chain.run.trace?.calls[0]?.stream?.realtime?.proven }).toEqual({
			observed: [{ frames: [{ id: "7", n: 1, reconnect_token: "rt-7" }], kind: "frames" }],
			proven: "longpoll",
		})
		expect(chain.hops.slice(0, 3).map((hop) => hop.url)).toEqual([
			"/feed?channel=c",
			"/feed?channel=c",
			"/feed?channel=c",
		])
	}, 600_000)
})

describe("the Go test driver: a stream method failing before any stream", () => {
	it("observes a refused WebSocket handshake as error, and one refused with 200 as null with its error traced", async () => {
		if (!withGo()) return
		const replies: Reply[] = [
			{ json: { message: "no" }, status: 403 },
			{ json: {}, status: 200 },
		]
		const { run } = await drive(streamsSdk(), replies, [socket(), socket()], {})
		const [forbidden, ok] = run.trace?.calls ?? []
		expect({ observed: run.observed, via: [forbidden?.error?.via, ok?.error?.via] }, run.stderr).toEqual({
			observed: [{ body: { message: "no" }, errorKey: null, kind: "error", status: 403 }, null],
			via: ["return", "return"],
		})
		expect([forbidden?.error?.status, forbidden?.stream, ok?.error?.text]).toEqual([
			403,
			undefined,
			expect.stringMatching(/^honey: http do:/),
		])
	}, 600_000)
})

describe("the Go test driver: what it refuses on a stream, nothing sent", () => {
	it("refuses controls that do not fit the stream", async () => {
		if (!withGo()) return
		const sdk = streamsSdk()
		const cases: [Call, Script | undefined, RegExp][] = [
			[feed({}), undefined, /a realtime call without take/],
			[socket({ lastEventId: "1" }), undefined, /lastEventId on a WebSocket operation/],
			[socket({ raw: true }), undefined, /raw: true on a ws operation/],
			[
				{ operation: "ticks.stream", route: route("/ticks"), send: ["x"] },
				undefined,
				/send or protocols on an SSE operation/,
			],
			[
				{ operation: "ticks.stream", route: route("/ticks") },
				{ calls: [{ ws: { on: true } }] },
				/a ws script on a sse operation/,
			],
			[socket(), { calls: [{ realtime: {} }] }, /a realtime script on a ws operation/],
			[
				socket(),
				{ calls: [{ isErrors: ["ErrNope" as "ErrSSELineTooLong"] }] },
				/isErrors: "ErrNope" is not a sentinel/,
			],
			[
				socket(),
				{ calls: [{ ws: { send: [{ json: 1, text: "t" } as never] } }] },
				/ws\.send 0 names 2 of json, text and bytes/,
			],
		]
		const [runs, hops] = await served([], async (server) => {
			const ran = await Promise.all(cases.map(([call, script]) => sdk.runCalls({ calls: [call] }, server, script)))
			return [ran, server.hops.length] as const
		})
		expect(runs.map((run) => run.status)).toEqual(cases.map(() => 1))
		for (const [i, run] of runs.entries()) expect(run.stderr).toMatch(cases[i]?.[2] as RegExp)
		expect(hops).toBe(0)
	}, 600_000)
})

describe("consumer programs for streams: top-level decls and a -race link", () => {
	it("compiles decls beside main, and links -race only when asked: a data race then fails the run", async () => {
		if (!withGo()) return
		const { files } = generateGoSdk(STREAMS)
		const decls = "type counter struct{ n int }\n\nfunc (c *counter) bump() { c.n++ }"
		const body =
			"\tc := &counter{}\n\tdone := make(chan bool)\n\tgo func() { c.bump(); done <- true }()\n\tc.bump()\n\t<-done\n\tnote(c.n)"
		const plain = await consume(files, "example.com/sdk", { body, decls })
		const raced = await consume(files, "example.com/sdk", { body, decls, race: true })
		expect({ plain: [plain.built, plain.vet, plain.out], raced: [raced.built, raced.out] }, plain.stderr).toEqual({
			plain: [true, [], { main: ["2"] }],
			raced: [true, undefined],
		})
		expect(raced.stderr).toContain("WARNING: DATA RACE")
	}, 600_000)
})

/* a transport whose Close records whether the read it is blocked in still has a live ctx */
const CLOSING = `type closing struct {
	entered chan struct{}
	read    context.Context
	atClose string
}

func (c *closing) Name() string                   { return "closing" }
func (c *closing) Kind() sdk.TransportKind         { return sdk.TransportWs }
func (c *closing) Send(context.Context, any) error { return nil }
func (c *closing) Close() error                    { c.atClose = fmt.Sprint(c.read.Err()); return nil }
func (c *closing) Recv(ctx context.Context) (any, error) {
	c.read = ctx
	close(c.entered)
	<-ctx.Done()
	return nil, ctx.Err()
}
func (c *closing) Connect(context.Context, string, *sdk.TransportOpts) (sdk.TransportConn, error) { return c, nil }`

describe("ResumableConnection.Close: the transport's close before the read's cancel", () => {
	/* coder/websocket drops the connection when a Read's ctx ends (conn.go setupReadTimeout), so a
	 * cancel first races the close frame Close sends: the server could see no `1000 client close` */
	it("closes the transport while its read is still live, then cancels the read", async () => {
		if (!withGo()) return
		const body = `	c := &closing{entered: make(chan struct{})}
	rc := sdk.NewResumableConnection("http://rt.test/feed", []sdk.Transport{c}, nil)
	note(rc.Connect(ctx))
	<-c.entered
	note(rc.Close(), c.atClose, rc.State())`
		const run = await consume(generateGoSdk(STREAMS).files, "example.com/sdk", { body, decls: CLOSING })
		expect({ built: run.built, out: run.out, vet: run.vet }, run.stderr).toEqual({
			built: true,
			out: { main: ["<nil>", "<nil> <nil> disconnected"] },
			vet: [],
		})
	}, 600_000)
})
