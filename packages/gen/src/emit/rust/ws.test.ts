/**
 * A WebSocket operation's emitted Rust (contract 20 §2.2, §5.4; Fd2, Fd5, Fd6): the method's
 * `Call<TypedWebSocket>`, dialing the escaped path as an upgrade with the credential, config and call
 * headers and a fresh `X-Request-Id`, and no hooks or log; the Opts stream fields (`reconnect_token`, one
 * pair on the wire, none when empty; `protocols`); the non-generic `TypedWebSocket` (`send_text`,
 * `send_json`, `send_binary`, `recv` bytes, `on` handlers, `closed_by`, `close` and the `WS_STATUS_*`
 * codes); how a read ends (the server's close frame, its echo flushed; a drop; the 16 MiB cap); what fails
 * before or at the handshake (a `..` path param, an error status); and `cancel_on`, which bounds the open
 * and ends an open socket. Driven on the `ws` registry document; types and Opts field sets are consumers.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { RustError, Script, Trace } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenRustSdk, drivenRustSdk } from "./__fixtures__/compiled.ts"
import { consume, once, seen } from "./__fixtures__/consumer.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()

/* cargo builds the crate's dependencies on a cold cache */
const CARGO = 600_000

/** A describe block of Rust legs, each under the cargo timeout, skipped without the toolchain. */
const rustDescribe = (name: string, legs: () => void) => describe.skipIf(!RUST)(name, { timeout: CARGO }, legs)

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/* tungstenite caps a message at 16 MiB (§1 rules: the driver refuses Go's SetReadLimit) */
const MESSAGE_CAP = 16 << 20

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

/** The `ws` SDK compiled with the driver, which must build. */
function driven(): DrivenRustSdk {
	const sdk = drivenRustSdk("ws")
	expect({ built: sdk.built }, sdk.stderr).toEqual({ built: true })
	return sdk
}

type Options = { readonly script?: Script; readonly setup?: Setup }

/** `calls` run by the `ws` driver against a server answering `replies`: the run, hops and streams. */
async function drive(replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	const sdk = driven()
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: options.setup ?? {} }, server, options.script)
		return { hops: [...server.hops], run, streams: [...server.streams] }
	})
}

/** A consumer of the `ws` SDK that only has to compile: `decls` beside a `main` noting "built". */
const compiles = (name: string, decls: string) => consume("ws", name, { body: 'n.note("built");', decls })

/** Whether `run` built, and whether E0560 named `field` on `strukt`. */
const refusedField = (run: { built: boolean; stderr: string }, strukt: string, field: string) => ({
	built: run.built,
	refused: new RegExp(`error\\[E0560\\]: struct \`${strukt}\` has no field named \`${field}\``).test(run.stderr),
})

/** The method's signature, TypedWebSocket's method set and the WS_STATUS_* codes, as a consumer compiles and prints them. */
const surface = once(() =>
	consume("ws", "surface", {
		body: `let c = client(&base).expect("client");
    let _ = surface(&c);
    n.note("compiled");
    n.section("codes");
    let codes: [u16; 3] = [sdk::WS_STATUS_NORMAL_CLOSURE, sdk::WS_STATUS_GOING_AWAY, sdk::WS_STATUS_PROTOCOL_ERROR];
    n.note(format!("{} {} {}", codes[0], codes[1], codes[2]));`,
		decls: `async fn surface(c: &sdk::Client) -> Result<(), sdk::Error> {
    let o = sdk::RoomsSocketOpts::default();
    let call: sdk::Call<sdk::TypedWebSocket> = c.rooms().socket("r", &o);
    let _: sdk::Call<sdk::TypedWebSocket> = c.plain().socket(&sdk::PlainSocketOpts::default());
    let mut w: sdk::TypedWebSocket = call.await?;
    w.on(sdk::WsEvent::Message, |data: &[u8]| { let _ = data.len(); });
    w.on(sdk::WsEvent::Close, |_: &[u8]| {});
    w.on(sdk::WsEvent::Error, |_: &[u8]| {});
    w.send_text("t").await?;
    w.send_binary(vec![0u8, 1, 2]).await?;
    w.send_json(&serde_json::json!({"n": 1})).await?;
    let read: Option<Result<Vec<u8>, sdk::Error>> = w.recv().await;
    let by: Option<&sdk::WsClose> = w.closed_by();
    if let Some(sdk::WsClose { code, reason }) = by {
        let _: (u16, &str) = (*code, reason.as_str());
    }
    w.close(sdk::WS_STATUS_GOING_AWAY, "bye").await
}`,
	}),
)

rustDescribe("a WebSocket operation's method: Call<TypedWebSocket>, dialing the operation's path", () => {
	// v0: 9500341438
	it("compiles with that signature, and dials the escaped path as an upgrade, reading a JSON frame", async () => {
		expect(seen(await surface()), (await surface()).stderr).toEqual({ built: true, out: ["compiled"] })
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
	})
})

rustDescribe("the WebSocket dial's headers: the credential, config and call headers, a request id per dial", () => {
	// v0: 57ea7ae0b6
	it("has no headers field on the WebSocket Opts: a per-call header goes on the Call", async () => {
		const run = await compiles(
			"ws_headers_field",
			"fn headers() -> sdk::RoomsSocketOpts {\n    sdk::RoomsSocketOpts { headers: Default::default(), ..Default::default() }\n}",
		)
		expect(refusedField(run, "RoomsSocketOpts", "headers"), run.stderr).toEqual({ built: false, refused: true })
	})

	/* the Rust leg of the Go-tagged 1f8936180b rides on 57ea7ae0b6 (triage) */
	// v0: 57ea7ae0b6
	it("sends the bearer token, the config headers, a per-call header and a UUIDv4 X-Request-Id on the upgrade", async () => {
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
	})

	it("mints a fresh X-Request-Id for each dial, and keeps the caller's own", async () => {
		const calls = [rooms({ take: 0 }), rooms({ take: 0 }), rooms({ headers: { "x-request-id": "fixed" }, take: 0 })]
		const { hops, run } = await drive([ws([]), ws([]), ws([])], calls)
		expect(run.observed, run.stderr).toEqual(calls.map(() => ({ frames: [], kind: "frames" })))
		const [first, second, fixed] = hops.map((hop) => hop.headers["x-request-id"])
		expect({ distinct: first !== second, first, fixed, second }).toEqual({
			distinct: true,
			first: expect.stringMatching(UUID_V4),
			fixed: "fixed",
			second: expect.stringMatching(UUID_V4),
		})
	})

	it("runs no request or response hook and logs nothing for the dial (Fd5: tungstenite's handshake)", async () => {
		const script: Script = { hooks: { request: [{ setHeader: ["x-hook", "1"] }], response: [{}] }, log: true }
		const { hops, run } = await drive([ws([{ text: "hi" }])], [rooms({ take: 1 })], { script })
		expect({ hooks: run.trace?.hooks, log: run.trace?.log, observed: run.observed }, run.stderr).toEqual({
			hooks: [],
			log: [],
			observed: [{ frames: ["hi"], kind: "frames" }],
		})
		expect(hops[0]?.headers["x-hook"]).toBeUndefined()
	})
})

rustDescribe("Opts.reconnect_token: one reconnect_token pair, after the declared query params", () => {
	// v0: 4bae4b2f51
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
		/* an empty cursor is no cursor (§1 rules, WHATWG): HEAD sends `reconnect_token=` (query.rs texts("") is [""]) */
		expect(hops.map((hop) => hop.url)).toEqual([
			"/rooms/r?reconnect_token=rt-1",
			"/rooms/r?since=3&reconnect_token=rt-1",
			"/rooms/r",
			"/rooms/r",
			"/plain?reconnect_token=rt-2",
		])
	})

	// v0: 4bae4b2f51
	it("folds the declared reconnect_token into the one Opts field: no reconnect_token2", async () => {
		const fields = await consume("ws", "ws_fields", {
			body: `let o = sdk::RoomsSocketOpts { since: Some(3), reconnect_token: Some("x".into()), protocols: vec!["v2".into(), "v1".into()] };
    let token: Option<String> = o.reconnect_token;
    let protocols: Vec<String> = o.protocols;
    let bare = sdk::PlainSocketOpts { reconnect_token: Some("y".into()), protocols: vec!["v3".into()] };
    n.note(format!("{token:?} {protocols:?} {:?} {:?}", bare.reconnect_token, bare.protocols));`,
		})
		expect(seen(fields), fields.stderr).toEqual({ built: true, out: ['Some("x") ["v2", "v1"] Some("y") ["v3"]'] })
		const duplicate = await compiles(
			"ws_token2",
			"fn token2() -> sdk::RoomsSocketOpts {\n    sdk::RoomsSocketOpts { reconnect_token2: None, ..Default::default() }\n}",
		)
		/* V0BUG: v0 emitted the declared param beside the stream field and sent reconnect_token twice; v1 folds
		   it into Opts.reconnect_token (Fd3 parity), so the wire carries exactly one pair. */
		expect(refusedField(duplicate, "RoomsSocketOpts", "reconnect_token2"), duplicate.stderr).toEqual({
			built: false,
			refused: true,
		})
	})
})

rustDescribe("Opts.protocols: the subprotocols offered as Sec-WebSocket-Protocol", () => {
	// v0: b7032e2046
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
		/* tungstenite joins the offered list with ", " (Go's coder/websocket with ","; RFC 7230 reads both alike) */
		expect(hops.map((hop) => [hop.url, hop.headers["sec-websocket-protocol"]])).toEqual([
			["/plain", "v2, v1"],
			["/rooms/r", "v2"],
			["/rooms/r", undefined],
		])
	})
})

rustDescribe("TypedWebSocket: send_text, send_json, send_binary, recv and on round-trip", () => {
	// v0: 468db67b4b
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
	})
})

rustDescribe("close codes and reasons", () => {
	// v0: 9fba20717a
	it("exports WS_STATUS_NORMAL_CLOSURE, WS_STATUS_GOING_AWAY and WS_STATUS_PROTOCOL_ERROR as 1000, 1001 and 1002", async () => {
		expect(seen(await surface(), "codes"), (await surface()).stderr).toEqual({ built: true, out: ["1000 1001 1002"] })
	})

	// v0: 9fba20717a
	it("sends close's code and reason, cutting a reason over 123 bytes at a char boundary", async () => {
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
		/* a close frame's payload is at most 125 bytes, the code's 2 among them: "é" would end at byte 124 */
		expect(streams.map((stream) => stream?.received)).toEqual([[closed(1001, "bye")], [closed(1000, "a".repeat(122))]])
		expect(run.trace?.calls.map((call) => call.stream)).toEqual([
			{ handlers: [{ data: "bye", event: "close" }], yields: 0 },
			{ handlers: [{ data: "a".repeat(122), event: "close" }], yields: 0 },
		])
	})
})

/** How a call's read ended: close's error, the close frame it ended on, its own error (via, variant), each handler run as `event data`. */
const endOf = ({ error, stream }: Trace<RustError>["calls"][number]) => ({
	closeError: stream?.closeError,
	closedBy: stream?.closedBy,
	error: error && `${error.via} ${error.variant}`,
	handlers: stream?.handlers?.map((h) => `${h.event} ${h.data}`),
})

rustDescribe("how a WebSocket read ends: the server's close frame, a drop, a message over the cap", () => {
	/* v0's lock and poison greps drop (H22): a handler gets `&[u8]` and `on` takes `&mut self`, so a handler
	   calling back into the socket cannot compile, and the driver's handlers record under a poison-safe lock */
	// v0: 4f78c7a023
	it("ends on the server's close as closed_by with the echo flushed, its close handler once, and close Ok after it", async () => {
		const script: Script = { calls: [{ ws: { on: true } }] }
		const { run, streams } = await drive([ws([{ close: { code: 1000, reason: "done" } }])], [rooms()], { script })
		expect(run.observed, run.stderr).toEqual([{ frames: [], kind: "frames" }])
		/* the committed close errored after a server close (SendAfterClosing) and never sent the queued echo:
		   `close` on an ended socket is Ok and sends nothing (§2.2) */
		expect((run.trace?.calls ?? []).map(endOf)).toEqual([
			{ closeError: undefined, closedBy: { code: 1000, reason: "done" }, error: undefined, handlers: ["close done"] },
		])
		expect(streams[0]).toEqual({ clientGone: false, received: [closed(1000, "done")] })
	})

	// v0: 4f78c7a023
	it("fires error once on a drop, never close, the error read via stream, and close Ok after it", async () => {
		const script: Script = { calls: [{ ws: { on: true } }] }
		const { run } = await drive([ws([{ drop: true }])], [rooms()], { script })
		expect(run.observed, run.stderr).toEqual([{ frames: [], kind: "frames" }])
		/* V0BUG: v0's error fanout was not once-guarded (ws.rs:117); v1 fires one end, once (Fd2) */
		expect((run.trace?.calls ?? []).map(endOf)).toEqual([
			{
				closeError: undefined,
				closedBy: undefined,
				error: "stream Transport",
				handlers: ["error transport: WebSocket protocol error: Connection reset without closing handshake"],
			},
		])
	})

	it("reads a 64 KiB frame, and fires error once on a message one byte over 16 MiB, then reads nothing", async () => {
		const big = "x".repeat(65_536)
		const replies = [ws([{ json: big }]), ws([{ text: "x".repeat(MESSAGE_CAP + 1) }, { json: "after" }])]
		const script: Script = { calls: [null, { ws: { on: true } }] }
		const { run } = await drive(replies, [rooms({ take: 1 }), rooms()], { script })
		expect(run.observed, run.stderr).toEqual([
			{ frames: [big], kind: "frames" },
			{ frames: [], kind: "frames" },
		])
		expect((run.trace?.calls ?? []).map(endOf)[1]).toEqual({
			closeError: undefined,
			closedBy: undefined,
			error: "stream Transport",
			handlers: [expect.stringMatching(/^error transport: .*Message too long: 16777217 > 16777216$/)],
		})
	})
})

rustDescribe("what fails before or at the handshake: a `..` path param, an error status", () => {
	it("refuses a `..` room before dialing: PathParam via return, nothing sent", async () => {
		const { hops, run } = await drive([ws([])], [rooms({ params: { room: ".." } })], { script: {} })
		const error = run.trace?.calls[0]?.error
		expect(run.observed, run.stderr).toEqual([null])
		/* the committed ws::dial ignored spec.failed (ws.rs:133-139) and dialed the base URL: a path-guard bypass */
		expect({ hops: hops.map((hop) => hop.url), variant: error?.variant, via: error?.via }).toEqual({
			hops: [],
			variant: "PathParam",
			via: "return",
		})
	})

	it("is a typed Api error for a handshake refused with an error status, before any stream", async () => {
		const { hops, run } = await drive([{ json: { message: "no" }, status: 403 }], [rooms()], { script: {} })
		const call = run.trace?.calls[0]
		expect(run.observed, run.stderr).toEqual([{ body: { message: "no" }, errorKey: null, kind: "error", status: 403 }])
		expect({
			error: [call?.error?.variant, call?.error?.kind, call?.error?.via],
			stream: call?.stream,
			upgrades: hops.map((hop) => [hop.url, hop.headers.upgrade]),
		}).toEqual({ error: ["Api", "Forbidden", "return"], stream: undefined, upgrades: [["/rooms/r", "websocket"]] })
	})
})

rustDescribe("cancel_on on a WebSocket call: it bounds the handshake and ends an open socket (Fd6)", () => {
	it("cancels a ready signal before dialing and a slow handshake while it waits, Canceled via return", async () => {
		const slow: Reply = { ...ws([]), delayMs: 2000 }
		const script: Script = { calls: [{ cancel: "before" }, { cancel: { afterMs: 100 } }] }
		const started = Date.now()
		const { hops, run } = await drive([slow], [rooms(), rooms()], { script })
		expect(run.observed, run.stderr).toEqual([null, null])
		expect({
			errors: run.trace?.calls.map((call) => [call.error?.variant, call.error?.via]),
			hops: hops.map((hop) => hop.headers.upgrade),
		}).toEqual({
			errors: [
				["Canceled", "return"],
				["Canceled", "return"],
			],
			hops: ["websocket"],
		})
		expect(Date.now() - started).toBeLessThan(1500)
	})

	/* Fd6 ruled the alternative (Go/TS parity): the signal also ends an open socket, quietly */
	it("ends an open socket quietly when the cancel fires after it opened: the frames so far, no error", async () => {
		const held = ws([{ json: { n: 1 } }, { waitMs: 2000 }, { json: { n: 2 } }])
		const script: Script = { calls: [{ cancel: { afterMs: 150 } }] }
		const { run } = await drive([held], [rooms({ take: 2 })], { script })
		const call = run.trace?.calls[0]
		expect({ observed: run.observed, ...(call && endOf(call)) }, run.stderr).toEqual({
			closeError: undefined,
			closedBy: undefined,
			error: undefined,
			handlers: undefined,
			observed: [{ frames: [{ n: 1 }], kind: "frames" }],
		})
		expect(call?.elapsedMs).toBeLessThan(1000)
	})
})
