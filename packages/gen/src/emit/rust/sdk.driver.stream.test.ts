/**
 * The Rust test driver's streams (contract 20 §4.2/§4.4, the Go `sdk.driver.stream.test.ts` analog): the
 * dispatch arm of each stream kind and its Opts lines, the driver files it declares only when a plan needs
 * them; SSE events read through `observe_events` with `take`, the typed headers, `retry` and the stream's
 * error; a stream that ends the reads while the run goes on; the 10 s watchdog; what the driver refuses on a
 * stream, nothing sent; then a WebSocket's script and its ends, and a realtime connection over WebSocket.
 * Driven against the `sse`, `ws` and `realtime` registry documents.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Observed } from "../../../tests/integration/conformance/matrix.ts"
import type { Script } from "../shared/__fixtures__/protocol.ts"
import { gone } from "../shared/__fixtures__/gone.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenRustSdk, drivenRustSdk } from "./__fixtures__/driven.ts"
import { dispatchRs } from "./__fixtures__/dispatch.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { withRust } from "./__fixtures__/rust-env.ts"
import { rustCallPlans } from "./sdk.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()

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
const plansOf = (key: StreamKey) => rustCallPlans(FIXTURES[key].document())

/** The registry SDK `key` compiled with the driver, which must build. */
function driven(key: StreamKey): DrivenRustSdk {
	const sdk = drivenRustSdk(key)
	expect({ built: sdk.built }, sdk.stderr).toEqual({ built: true })
	return sdk
}

/** `calls` run by `sdk` against a server answering `replies`, under `script` when given: the run, hops and streams. */
async function drive(sdk: DrivenRustSdk, replies: readonly Reply[], calls: readonly Call[], script?: Script) {
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls }, server, script)
		return { hops: [...server.hops], run, streams: [...server.streams] }
	})
}

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
		"script: call 0: isErrors is Go's errors.Is; the Rust trace records the variant and text",
	],
	[
		ticks(),
		{ calls: [{ ws: { readLimit: 1024 } }] },
		"script: call 0: ws.readLimit is Go's SetReadLimit; a Rust socket caps a message at 16 MiB",
	],
]

describe("dispatchRs: an SSE and a WebSocket operation's arm", () => {
	it("reads an SSE stream through observe_events with take, its cursor from the call and its typed headers", () => {
		expect(dispatchRs(plansOf("sse"))).toContain(
			[
				'        "ticks.stream" => {',
				"            let mut o = sdk::TicksStreamOpts::default();",
				'            if let Some(v) = call.search("since") { o.since = Some(from(v)?); }',
				'            if let Some(v) = call.header_param("x-tenant") { o.x_tenant = Some(from(v)?); }',
				"            o.last_event_id = call.last_event_id.clone();",
				"            call.no_body()?;",
				"            let c = client.ticks().stream(&o);",
				"            fn read(h: &reqwest::header::HeaderMap) -> Result<BTreeMap<String, String>, sdk::Error> {",
				"                let v = <sdk::TicksStreamHeaders as sdk::FromHeaders>::from_headers(h)?;",
				"                let mut m = BTreeMap::new();",
				'                put(&mut m, "x-stream-id", &v.x_stream_id);',
				"                Ok(m)",
				"            }",
				"            crate::stream::observe_events(apply(c, call, input, d).reading(read), call.take).await",
				"        }\n",
			].join("\n"),
		)
	})

	it("drives a WebSocket through socket::observe_frames, its token from the call and its protocols from the script", () => {
		expect(dispatchRs(plansOf("ws"))).toContain(
			[
				'        "rooms.socket" => {',
				"            let mut o = sdk::RoomsSocketOpts::default();",
				'            if let Some(v) = call.search("since") { o.since = Some(from(v)?); }',
				"            o.reconnect_token = call.reconnect_token.clone();",
				"            if let Some(p) = &d.protocols { o.protocols = p.clone(); }",
				"            call.no_body()?;",
				'            let c = client.rooms().socket(&call.param("room")?, &o);',
				"            socket::observe_frames(apply(c, call, input, d), call, d).await",
				"        }\n",
			].join("\n"),
		)
	})
})

describe("dispatchRs: a realtime operation's arm, and the stream files dispatch.rs declares", () => {
	it("drives a realtime connection through live::observe_live, every stream field set, in either error mode", () => {
		const arm = [
			'        "feed.live" => {',
			"            let mut o = sdk::FeedLiveOpts::default();",
			'            if let Some(v) = call.search("channel") { o.channel = from(v)?; }',
			'            if let Some(v) = call.header_param("x-tenant") { o.x_tenant = Some(from(v)?); }',
			"            o.last_event_id = call.last_event_id.clone();",
			"            o.reconnect_token = call.reconnect_token.clone();",
			"            if let Some(p) = &d.protocols { o.protocols = p.clone(); }",
			"            if let Some(r) = &d.realtime { o.max_reconnect_attempts = r.max_reconnect_attempts; o.reconnect_delay_ms = r.reconnect_delay_ms; }",
			"            call.no_body()?;",
			"            let c = client.feed().live(&o);",
			"            live::observe_live(apply(c, call, input, d), call).await",
			"        }\n",
		].join("\n")
		expect([dispatchRs(plansOf("realtime")), dispatchRs(plansOf("realtime"), false)]).toEqual([
			expect.stringContaining(arm),
			expect.stringContaining(arm),
		])
		expect(dispatchRs(plansOf("realtime"))).toContain(
			'if let Some(v) = call.search("protocols") { o.protocols2 = Some(from(v)?); }',
		)
	})

	it("declares socket.rs for any WebSocket or realtime plan and live.rs for any realtime plan, and neither otherwise", () => {
		const SOCKET = '#[path = "socket.rs"]\nmod socket;'
		const LIVE = '#[path = "live.rs"]\nmod live;'
		const declared = (key: "http" | StreamKey) => {
			const source = dispatchRs(rustCallPlans(FIXTURES[key].document()))
			return [source.includes(SOCKET), source.includes(LIVE)]
		}
		expect({
			http: declared("http"),
			realtime: declared("realtime"),
			sse: declared("sse"),
			ws: declared("ws"),
		}).toEqual({ http: [false, false], realtime: [true, true], sse: [false, false], ws: [true, false] })
	})
})

describe.skipIf(!RUST)("the Rust test driver: SSE, EventStream<T>", () => {
	it("observes typed events with event and id until take, and traces retry (null when unset) and the typed headers", async () => {
		const reply: Reply = {
			headers: { "x-stream-id": "s-1" },
			...sse(['retry: 3000\nid: 1\nevent: tick\ndata: {"n":1}\n\n', tick(2), { waitMs: 50 }, tick(3)], "hold"),
		}
		const call = ticks({ headers: { "x-tenant": "acme" }, lastEventId: "evt-5", search: { since: 5 }, take: 2 })
		/* the second call's answer waits until the first stream's client left (gone.ts): the driver still runs */
		const next = gone(sse(['data: {"a":1}\n\n']))
		const { hops, run } = await drive(driven("sse"), [reply, next.reply], [call, text()], {})
		expect({ observed: run.observed, streams: run.trace?.calls.map((c) => c.stream) }, run.stderr).toEqual({
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
				{ headers: { "x-stream-id": "s-1" }, retry: [3000, null], yields: 2 },
				{ retry: [null], yields: 1 },
			],
		})
		expect(hops[0]).toMatchObject({
			headers: { accept: "text/event-stream", "last-event-id": "evt-5", "x-tenant": "acme" },
			url: "/ticks?since=5",
		})
		expect(next.released()).toBe(true)
	}, 600_000)

	it("ends a held stream's reads at take while the run goes on: the client leaves before the next call", async () => {
		const held = sse([tick(1), { waitMs: 100 }, tick(2), { waitMs: 100 }, tick(3)], "hold")
		/* the second call's answer waits until the first stream's client left (gone.ts): the driver still runs */
		const next = gone(sse([tick(9)]))
		const { run } = await drive(driven("sse"), [held, next.reply], [ticks({ take: 1 }), ticks()])
		expect({ observed: run.observed, released: next.released() }, run.stderr).toEqual({
			observed: [
				{ events: [{ data: { n: 1 } }], kind: "events" },
				{ events: [{ data: { n: 9 } }], kind: "events" },
			],
			released: true,
		})
	}, 600_000)
})

describe.skipIf(!RUST)("the Rust test driver: how an SSE call fails", () => {
	/* bit 21 i0: a drop after events is the grid's `failed: "transport"` (f2), so the unscripted run observes it too */
	it("observes the events before a dropped connection, then failed transport, the stream's error traced", async () => {
		const sdk = driven("sse")
		const dropped = sse([tick(1), { waitMs: 50 }], "drop")
		const { run } = await drive(sdk, [dropped], [ticks()], {})
		const call = run.trace?.calls[0]
		const observed = [{ events: [{ data: { n: 1 } }], failed: "transport", kind: "events" }]
		expect({ observed: run.observed, stream: call?.stream, via: call?.error?.via }, run.stderr).toEqual({
			observed,
			stream: { retry: [null], yields: 2 },
			via: "stream",
		})
		expect(call?.error?.variant).toBe("Transport")
		const bare = await drive(sdk, [dropped], [ticks()])
		expect({ observed: bare.run.observed, status: bare.run.status }, bare.run.stderr).toEqual({ observed, status: 0 })
	}, 600_000)

	it("observes an error status at the open as error and a path failing before any stream as null, both via return", async () => {
		const replies: Reply[] = [{ json: { message: "nope" }, status: 404 }]
		const pending: Call = { operation: "pending.stream", params: { id: ".." }, route: route("GET", "/pending/{id}") }
		const { hops, run } = await drive(driven("sse"), replies, [ticks(), pending], {})
		const [status, path] = run.trace?.calls ?? []
		expect({ hops: hops.length, observed: run.observed }, run.stderr).toEqual({
			hops: 1,
			observed: [{ body: { message: "nope" }, errorKey: null, kind: "error", status: 404 }, null],
		})
		expect([status?.error?.via, status?.error?.kind, status?.stream, path?.error?.variant, path?.error?.via]).toEqual([
			"return",
			"NotFound",
			undefined,
			"PathParam",
			"return",
		])
	}, 600_000)

	/* Fd6 (ruled the alternative): `cancel_on` also ends an open stream, quietly; the driver's cancel reaches past the open */
})

describe.skipIf(!RUST)("the Rust test driver: what ends an SSE call", () => {
	it("ends an open stream quietly when the call's cancel fires after it opened: the events so far, no error", async () => {
		const held = sse([tick(1), { waitMs: 3000 }, tick(2)], "hold")
		const script: Script = { calls: [{ cancel: { afterMs: 1000 } }] }
		const { run } = await drive(driven("sse"), [held], [ticks({ take: 2 })], script)
		expect({ error: run.trace?.calls[0]?.error, observed: run.observed }, run.stderr).toEqual({
			error: undefined,
			observed: [{ events: [{ data: { n: 1 } }], kind: "events" }],
		})
		expect(run.trace?.calls[0]?.elapsedMs).toBeLessThan(2500)
	}, 600_000)

	it("fails the run when a stream never ends: stream stalled, after 10 s", async () => {
		const started = Date.now()
		const { run } = await drive(driven("sse"), [sse([tick(1)], "hold")], [ticks()])
		expect({ status: run.status, stderr: run.stderr.trim() }).toEqual({
			status: 1,
			stderr: "driver: call 0 (ticks.stream): stream stalled: no end within 10s",
		})
		expect(Date.now() - started).toBeLessThan(12_000)
	}, 600_000)
})

describe.skipIf(!RUST)("the Rust test driver: what it refuses on an SSE call, nothing sent", () => {
	it("exits 1 naming each control that does not fit the stream, and Go's isErrors and ws.readLimit for good", async () => {
		const sdk = driven("sse")
		const [runs, hops] = await served([], async (server) => {
			const ran = await Promise.all(
				SSE_REFUSALS.map(([call, script]) => sdk.runCalls({ calls: [call] }, server, script)),
			)
			return [ran, server.hops.length] as const
		})
		expect({ hops, runs: runs.map((run) => [run.status, run.stderr.trim()]) }).toEqual({
			hops: 0,
			runs: SSE_REFUSALS.map(([, , reason]) => [1, `driver: ${reason}`]),
		})
		const bad = await sdk.runCalls(
			{ calls: [ticks()] },
			{ url: "http://127.0.0.1:9" },
			{
				calls: [{ ws: { send: [{ json: 1, text: "t" } as never] } }],
			},
		)
		expect({ status: bad.status, stderr: bad.stderr }).toEqual({
			status: 1,
			stderr: expect.stringMatching(/^driver: script: /),
		})
	}, 600_000)
})

describe.skipIf(!RUST)("the Rust test driver: what it refuses on a WebSocket or realtime call, nothing sent", () => {
	it("refuses lastEventId on a WebSocket and a realtime call without take", async () => {
		const runs = await served([], async (server) => {
			const ran = [
				await driven("ws").runCalls({ calls: [socket({ lastEventId: "1" })] }, server),
				await driven("realtime").runCalls({ calls: [feed()] }, server),
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
			],
		})
	}, 600_000)
})

describe.skipIf(!RUST)("the Rust test driver: a WebSocket, TypedWebSocket", () => {
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
	}, 600_000)
})

describe.skipIf(!RUST)("the Rust test driver: how a WebSocket read ends", () => {
	it("ends on the server's close frame as closedBy, and on a drop with the error traced via stream, each end fired once", async () => {
		const replies = [
			ws([{ close: { code: 1000, reason: "done" } }]),
			ws([{ text: "one" }, { waitMs: 50 }, { drop: true }]),
		]
		const script: Script = { calls: [{ ws: { on: true } }, { ws: { on: true } }] }
		const { run } = await drive(driven("ws"), replies, [socket(), socket()], script)
		const ends = (run.trace?.calls ?? []).map(({ error, stream }) => ({
			closeError: stream?.closeError,
			closedBy: stream?.closedBy,
			handlers: stream?.handlers?.map((h) => `${h.event} ${h.event === "error" ? "…" : h.data}`),
			via: error?.via,
		}))
		expect(run.observed, run.stderr).toEqual([
			{ frames: [], kind: "frames" },
			{ frames: ["one"], kind: "frames" },
		])
		expect(ends).toEqual([
			{ closeError: undefined, closedBy: { code: 1000, reason: "done" }, handlers: ["close done"], via: undefined },
			{ closeError: undefined, closedBy: undefined, handlers: ["message one", "error …"], via: "stream" },
		])
	}, 600_000)

	it("keeps reading after a send fails: the server's close frame still waiting is closedBy, the send's error traced", async () => {
		/* the server closes and hangs up before the client sends; 12 MiB outgrows the client's send buffer (tcp_wmem caps it at 4 MiB), so the send fails every time */
		const reply = ws([{ close: { code: 4401, hangUp: true, reason: "unauthorized" } }])
		const script: Script = { calls: [{ ws: { on: true, send: [{ bytes: 12 << 20 }] } }] }
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
	}, 600_000)
})

describe.skipIf(!RUST)("the Rust test driver: realtime, ResumableConnection<E>", () => {
	it("opens over WebSocket with the resume cursor, sends the grid's JSON, reads take typed frames, and traces the settled cursor", async () => {
		const reply = ws([
			{ receive: 1 },
			{ json: { id: "1", n: 1, reconnect_token: "rt-1" } },
			{ json: { id: "2", n: 2, reconnect_token: "rt-2" } },
		])
		const call = feed({ lastEventId: "0", reconnectToken: "rt-0", send: ['{"hi":1}'], take: 2 })
		const { hops, run, streams } = await drive(driven("realtime"), [reply], [call], {})
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
	}, 600_000)
})
