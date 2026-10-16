import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import { compiledSdk, type DrivenSdk, type Script, type Trace } from "./__fixtures__/compiled.ts"
import { check, once, seen } from "./__fixtures__/consumer.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { type Reply, served } from "./__fixtures__/recording-server.ts"
import { generateGoSdk } from "./sdk.ts"

/** Whether Go is here: a missing one fails where it is required and skips the Go tests elsewhere (go-env). */
const GO = withGo()
const goDescribe = describe.skipIf(!GO)

type Json = Record<string, unknown>

const MODULE = "example.com/ws"
const STRING = { type: "string" }
const UPGRADE = { 101: { description: "upgrade" } }
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** A bearer API with two WebSocket ops: one with a path param, a query param and a declared `reconnect_token`, one with none. */
const WS: Json = {
	components: { securitySchemes: { bearer: { scheme: "bearer", type: "http" } } },
	info: { title: "WS", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/plain": { get: { operationId: "plain.socket", responses: UPGRADE, "x-websocket": true } },
		"/rooms/{room}": {
			get: {
				operationId: "rooms.socket",
				parameters: [
					{ in: "path", name: "room", required: true, schema: STRING },
					{ in: "query", name: "since", schema: { type: "integer" } },
					{ in: "query", name: "reconnect_token", schema: STRING },
				],
				responses: UPGRADE,
				"x-websocket": true,
			},
		},
	},
	security: [{ bearer: [] }],
}

let driven: DrivenSdk | undefined
/** The WS SDK with the driver beside it, compiled once and checked to build and vet clean. */
function wsSdk(): DrivenSdk {
	driven ??= compiledSdk(WS, { modulePath: MODULE })
	expect({ built: driven.built, vet: driven.vet }, driven.stderr).toEqual({ built: true, vet: [] })
	return driven
}

/** A consumer program `body` beside the WS SDK. */
const consumer = (body: string) => check(generateGoSdk(WS, { modulePath: MODULE }).files, MODULE, body)

const route = (path: string) => ({ method: "GET", path })
const rooms = (extra: Partial<Call> = {}): Call => ({
	operation: "rooms.socket",
	params: { room: "r" },
	route: route("/rooms/{room}"),
	...extra,
})
const plain = (extra: Partial<Call> = {}): Call => ({ operation: "plain.socket", route: route("/plain"), ...extra })
const ws = (steps: NonNullable<Reply["ws"]>["steps"], protocol?: string): Reply => ({
	status: 101,
	ws: protocol === undefined ? { steps } : { protocol, steps },
})
const sha = (n: number) =>
	createHash("sha256")
		.update(Buffer.from(Array.from({ length: n }, (_, i) => i & 0xff)))
		.digest("hex")
/** The client's close frame as the server records it. */
const closed = (code: number, reason = "") => ({ code, kind: "close", reason })

type Options = { readonly script?: Script; readonly setup?: Setup }

/** `calls` run by the WS SDK against a server answering `replies`: the run, hops and streams. */
async function drive(replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	const sdk = wsSdk()
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: options.setup ?? {} }, server, options.script)
		return { hops: [...server.hops], run, streams: [...server.streams] }
	})
}

/** The method's signature, TypedWebSocket's method set and the WSStatus codes, as a consumer compiles and prints them. */
const surface = once(() =>
	consumer(`	c := sdk.NewClient(sdk.Config{BaseURL: "http://127.0.0.1:1"})
	var socket func(context.Context, string, *sdk.RoomsSocketOpts, ...sdk.RequestOption) (*sdk.TypedWebSocket, error) = c.Rooms.Socket
	var bare func(context.Context, *sdk.PlainSocketOpts, ...sdk.RequestOption) (*sdk.TypedWebSocket, error) = c.Plain.Socket
	use := func(w *sdk.TypedWebSocket) error {
		w.On("message", func([]byte) {})
		w.SetReadLimit(1 << 20)
		if _, err := w.Read(ctx); err != nil {
			return err
		}
		if err := w.Send(ctx, map[string]int{"n": 1}); err != nil {
			return err
		}
		return w.Close(sdk.WSStatusGoingAway, "bye")
	}
	_, _, _ = socket, bare, use
	note("compiled")
	section("codes")
	note(int(sdk.WSStatusNormalClosure), int(sdk.WSStatusGoingAway), int(sdk.WSStatusProtocolError))
`),
)

goDescribe("a WebSocket operation's method: (*TypedWebSocket, error), dialing the operation's path", () => {
	// v0: 11520ddd49
	it("compiles with that signature, and dials the escaped path as an upgrade, reading a JSON frame", async () => {
		expect(seen(surface()), surface().stderr).toEqual({ built: true, out: ["compiled"], vet: [] })
		const call = rooms({ params: { room: "a b/c" }, take: 1 })
		const { hops, run, streams } = await drive([ws([{ json: { n: 1 } }])], [call], { script: {} })
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [{ frames: [{ n: 1 }], kind: "frames" }],
			stream: { yields: 1 },
		})
		expect({ hops: hops.length, received: streams[0]?.received }).toEqual({ hops: 1, received: [closed(1000)] })
		expect(hops[0]).toMatchObject({
			headers: { connection: expect.stringMatching(/upgrade/i), "sec-websocket-version": "13", upgrade: "websocket" },
			method: "GET",
			url: "/rooms/a%20b%2Fc",
		})
	}, 600_000)
})

goDescribe("the WebSocket dial's headers: the auth credential, config and call headers, a request id", () => {
	// v0: 1f8936180b
	it("sends the bearer token, Config.Headers, a per-call header and a UUIDv4 X-Request-Id on the upgrade", async () => {
		const setup: Setup = { auth: { kind: "bearer", token: "t" }, headers: { "X-Tenant": "acme" } }
		const call = rooms({ headers: { "x-call": "1" }, take: 1 })
		const { hops, run } = await drive([ws([{ text: "hi" }])], [call], { setup })
		expect(run.observed, run.stderr).toEqual([{ frames: ["hi"], kind: "frames" }])
		expect(hops.map((hop) => hop.headers)).toEqual([
			expect.objectContaining({
				authorization: "Bearer t",
				upgrade: "websocket",
				"x-call": "1",
				"x-request-id": expect.stringMatching(UUID_V4),
				"x-tenant": "acme",
			}),
		])
	}, 600_000)
})

goDescribe("Opts.ReconnectToken: one reconnect_token pair, after the declared query params", () => {
	// v0: c8c670b75f
	it("sends reconnect_token once, after since, and nothing when the token is empty or unset", async () => {
		const calls = [
			rooms({ reconnectToken: "rt-1", take: 0 }),
			rooms({ reconnectToken: "rt-1", search: { since: 3 }, take: 0 }),
			rooms({ reconnectToken: "", take: 0 }),
			rooms({ take: 0 }),
			plain({ reconnectToken: "rt-2", take: 0 }),
		]
		const { hops, run } = await drive(
			calls.map(() => ws([])),
			calls,
		)
		expect(run.observed, run.stderr).toEqual(calls.map(() => ({ frames: [], kind: "frames" })))
		/* V0BUG: v0 emitted the declared param as ReconnectToken2 beside Opts.ReconnectToken and sent
		   reconnect_token twice (codegen-go.ts:506,646-647); v1 folds it into Opts.ReconnectToken (Fd3),
		   so the wire carries exactly one pair. */
		expect(hops.map((hop) => hop.url)).toEqual([
			"/rooms/r?reconnect_token=rt-1",
			"/rooms/r?since=3&reconnect_token=rt-1",
			"/rooms/r",
			"/rooms/r",
			"/plain?reconnect_token=rt-2",
		])
	}, 600_000)

	// v0: c8c670b75f
	it("has a string ReconnectToken and a Protocols field on every WebSocket Opts, and no ReconnectToken2", () => {
		const fields = consumer(`	opts := sdk.RoomsSocketOpts{ReconnectToken: "x", Protocols: []string{"v2", "v1"}}
	var token string = opts.ReconnectToken
	var protocols []string = opts.Protocols
	bare := sdk.PlainSocketOpts{ReconnectToken: "y", Protocols: []string{"v3"}}
	note(token, protocols, bare.ReconnectToken, bare.Protocols)
`)
		expect(seen(fields), fields.stderr).toEqual({ built: true, out: ["x [v2 v1] y [v3]"], vet: [] })
		const duplicate = consumer("\t_ = sdk.RoomsSocketOpts{ReconnectToken2: nil}\n")
		expect({ built: duplicate.built, stderr: duplicate.stderr }).toEqual({
			built: false,
			stderr: expect.stringMatching(/unknown field ReconnectToken2 in struct literal of type sdk\.RoomsSocketOpts/),
		})
	}, 600_000)
})

goDescribe("Opts.Protocols: the subprotocols offered as Sec-WebSocket-Protocol", () => {
	// v0: bbdff81676
	it("offers the protocols in order, reads frames once the server picks one, and offers none without them", async () => {
		const replies = [ws([{ json: { p: 1 } }], "v1"), ws([{ json: { p: 2 } }], "v2"), ws([{ json: { p: 3 } }])]
		const calls = [plain({ take: 1 }), rooms({ take: 1 }), rooms({ take: 1 })]
		const script: Script = { calls: [{ protocols: ["v2", "v1"] }, { protocols: ["v2"] }, null] }
		const { hops, run } = await drive(replies, calls, { script })
		expect(run.observed, run.stderr).toEqual([
			{ frames: [{ p: 1 }], kind: "frames" },
			{ frames: [{ p: 2 }], kind: "frames" },
			{ frames: [{ p: 3 }], kind: "frames" },
		])
		/* coder/websocket joins the offered list with "," and no space (RFC 7230 reads both alike) */
		expect(hops.map((hop) => [hop.url, hop.headers["sec-websocket-protocol"]])).toEqual([
			["/plain", "v2,v1"],
			["/rooms/r", "v2"],
			["/rooms/r", undefined],
		])
	}, 600_000)
})

goDescribe("TypedWebSocket: Send, Read, On and Close round-trip", () => {
	// v0: 9b47c082c4
	it("sends text, JSON and binary frames in order, reads the server's JSON, fires message then close, closes 1000", async () => {
		const script: Script = {
			calls: [{ ws: { on: true, send: [{ json: { a: 1 } }, { text: "t" }, { bytes: 3 }] } }],
		}
		const reply = ws([{ receive: 4 }, { json: { ok: true } }])
		const { run, streams } = await drive([reply], [rooms({ send: ['{"x":1}'], take: 1 })], { script })
		expect({ observed: run.observed, trace: run.trace?.calls[0] }, run.stderr).toEqual({
			observed: [{ frames: [{ ok: true }], kind: "frames" }],
			trace: {
				elapsedMs: expect.any(Number),
				stream: {
					handlers: [
						{ data: '{"ok":true}', event: "message" },
						{ data: "", event: "close" },
					],
					yields: 1,
				},
			},
		})
		expect(streams[0]).toEqual({
			clientGone: false,
			received: [
				{ kind: "text", text: '{"x":1}' },
				{ kind: "text", text: '{"a":1}' },
				{ kind: "text", text: "t" },
				{ kind: "binary", sha256: sha(3), size: 3 },
				closed(1000),
			],
		})
	}, 600_000)
})

goDescribe("close codes and reasons", () => {
	// v0: 10518c3bac
	it("exports WSStatusNormalClosure, WSStatusGoingAway and WSStatusProtocolError as 1000, 1001 and 1002", () => {
		expect(seen(surface(), "codes"), surface().stderr).toEqual({ built: true, out: ["1000 1001 1002"], vet: [] })
	}, 600_000)

	// v0: 10518c3bac
	it("sends Close's code and reason, cutting a reason over 123 bytes at a rune boundary", async () => {
		const long = `${"a".repeat(122)}é`
		const script: Script = {
			calls: [
				{ ws: { close: { code: 1001, reason: "bye" }, on: true } },
				{ ws: { close: { code: 1000, reason: long }, on: true } },
			],
		}
		const { run, streams } = await drive([ws([]), ws([])], [rooms({ take: 0 }), rooms({ take: 0 })], { script })
		expect(run.observed, run.stderr).toEqual([
			{ frames: [], kind: "frames" },
			{ frames: [], kind: "frames" },
		])
		/* V0BUG: v0 cut the reason by bytes, reason[:123] (ws.go:68-72), leaving half of "é" in the
		   frame; v1 drops the whole rune, so the close frame and the close handler see 122 "a"s. */
		expect(streams.map((stream) => stream?.received)).toEqual([[closed(1001, "bye")], [closed(1000, "a".repeat(122))]])
		expect(run.trace?.calls.map((call) => call.stream)).toEqual([
			{ handlers: [{ data: "bye", event: "close" }], yields: 0 },
			{ handlers: [{ data: "a".repeat(122), event: "close" }], yields: 0 },
		])
	}, 600_000)
})

/** How a call's read ended: Close's error, the close frame it ended on, its own error (via a stream), each handler run as `event data`. */
const endOf = ({ error, stream }: Trace["calls"][number]) => ({
	closeError: stream?.closeError,
	closedBy: stream?.closedBy,
	error: error && `${error.via}: ${error.text}`,
	handlers: stream?.handlers?.map((h) => `${h.event} ${h.data}`),
})

/**
 * A read ended by the server's close frame: its close handler once, closedBy, no error, and Close
 * after it benign. coder/websocket returns net.ErrClosed from a Close once the peer's close frame
 * closed the conn; v0's nhooyr.io/websocket v1.8.17 returned nil there, so Close maps it to nil.
 */
const STREAM_BY_SERVER = {
	closeError: undefined,
	closedBy: { code: 1000, reason: "done" },
	handlers: ["close done"],
}

goDescribe("how a WebSocket read ends: a frame over 32 KiB, a close frame, a drop, the read limit", () => {
	// v0: 53d2bbf44d
	it("reads a 64 KiB frame, ends on a close frame as closedBy, and fires error on a drop and an over-limit frame", async () => {
		const big = "x".repeat(65_536)
		const replies = [
			ws([{ json: big }]),
			ws([{ close: { code: 1000, reason: "done" } }]),
			ws([{ drop: true }]),
			ws([{ json: "x".repeat(2048) }]),
		]
		const script: Script = {
			calls: [null, { ws: { on: true } }, { ws: { on: true } }, { ws: { on: true, readLimit: 1024 } }],
		}
		const calls = [rooms({ take: 1 }), rooms(), rooms(), rooms()]
		const { run, streams } = await drive(replies, calls, { script })
		expect(run.observed, run.stderr).toEqual([
			{ frames: [big], kind: "frames" },
			{ frames: [], kind: "frames" },
			{ frames: [], kind: "frames" },
			{ frames: [], kind: "frames" },
		])
		/* a drop or an over-limit frame fires error, never close; the trailing "close " is the driver's own Close */
		expect((run.trace?.calls ?? []).map(endOf)).toEqual([
			{ closeError: undefined, closedBy: undefined, error: undefined, handlers: undefined },
			{ ...STREAM_BY_SERVER, error: undefined },
			{
				closeError: expect.stringMatching(/^failed to close WebSocket: .*EOF$/),
				closedBy: undefined,
				error: expect.stringMatching(/^stream: failed to get reader: .*EOF$/),
				handlers: [expect.stringMatching(/^error failed to get reader: .*EOF$/), "close "],
			},
			{
				closeError: expect.stringMatching(/StatusMessageTooBig/),
				closedBy: undefined,
				error: expect.stringMatching(/^stream: failed to read: .*message too big: read limited at 1025 bytes$/),
				handlers: [expect.stringMatching(/^error .*read limited at 1025 bytes$/), "close "],
			},
		])
		/* the drop half-closes, so the client's own close still lands; past the limit the client closes 1009 */
		expect(streams.map((stream) => stream?.received)).toEqual([
			[closed(1000)],
			[closed(1000, "done")],
			[closed(1000)],
			[closed(1009, "read limited at 1025 bytes")],
		])
	}, 600_000)
})

goDescribe("a refused WebSocket handshake", () => {
	it("is a typed error for an error status, and a transport error for a 2xx, both before any stream", async () => {
		const replies: Reply[] = [
			{ json: { message: "no" }, status: 403 },
			{ json: {}, status: 200 },
		]
		const { hops, run } = await drive(replies, [rooms(), plain()], { script: {} })
		const [forbidden, ok] = run.trace?.calls ?? []
		expect(run.observed, run.stderr).toEqual([
			{ body: { message: "no" }, errorKey: null, kind: "error", status: 403 },
			null,
		])
		expect({
			forbidden: [
				forbidden?.error?.via,
				forbidden?.error?.chain.filter((t) => t.startsWith("*sdk.")),
				forbidden?.stream,
			],
			ok: [ok?.error?.via, ok?.error?.chain.filter((t) => t.startsWith("*sdk.")), ok?.error?.text],
			upgrades: hops.map((hop) => [hop.url, hop.headers.upgrade]),
		}).toEqual({
			forbidden: ["return", ["*sdk.ForbiddenError", "*sdk.ClientError"], undefined],
			ok: ["return", [], expect.stringMatching(/^honey: http do:/)],
			upgrades: [
				["/rooms/r", "websocket"],
				["/plain", "websocket"],
			],
		})
	}, 600_000)
})
