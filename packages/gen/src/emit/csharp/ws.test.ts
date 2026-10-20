/**
 * A WebSocket operation's emitted C# (contract 50 §2.1, §5.4; Fd2, Fd3, Fd5; Python's and Rust's `ws.test.ts`):
 * the awaited `TypedWebSocket` over the SDK's own HTTP/1.1 upgrade, dialing the escaped path with the call's
 * headers, a fresh `X-Request-Id` and no hook or log; `reconnectToken` (one pair, none when empty) and `protocols`;
 * `SendAsync`, `ReceiveAsync`, the `Message`/`Closed`/`Error` events, `ClosedBy`, `Subprotocol`, `CloseAsync` and
 * the BCL's `WebSocketCloseStatus`; how a read ends (the server's close echoed at once, a drop, the 16 MiB cap);
 * what fails before the dial; the method's token on the handshake and on an open socket, a read's own token; a
 * socket used from several tasks. Driven on the `ws` registry document; events, tasks and types are consumers.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { CsError, Script, Trace } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { checked, consume, program, seen } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import { type DrivenCSharpSdk, drivenCSharpSdk } from "./__fixtures__/driven.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/* a C# socket caps a message at 16 MiB (contract 50 §1, "WS reads") */
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
/** The client's close frame as the server records it. */
const closed = (code: number, reason = "") => ({ code, kind: "close", reason })
/** Frames observed, one per call. */
const framed = (...frames: unknown[][]) => frames.map((f) => ({ frames: f, kind: "frames" }))
/** A stream's OCE as traced: the method's token ended it (Fd2), via the stream (contract 50 §4.3). */
const CANCELED = expect.objectContaining({ canceled: true, via: "stream" })
/**
 * The warm call a timed call follows on its client, unbounded (per-call timeout 0): .NET's first request on a
 * starved core pays JIT, handler init and the connect inside the timed window (4d1f701).
 */
const WARM = rooms({ take: 0, timeoutMs: 0 })

/** The `ws` SDK with the driver aimed at it, which must build. */
function driven(): DrivenCSharpSdk {
	const sdk = drivenCSharpSdk("ws")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

type Options = { readonly script?: Script; readonly setup?: Setup }

/** `calls` run by the `ws` driver against a server answering `replies`: the run, hops and streams. */
async function drive(replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	const sdk = driven()
	return served(replies, async (server) => {
		const cell = { calls, setup: options.setup ?? {} }
		const run = await sdk.runCalls(cell, { url: server.url }, { script: options.script })
		return { hops: [...server.hops], run, streams: [...server.streams] }
	})
}

/** The consumer `name` of the `ws` SDK run against a server answering `replies`: its run, the hops and streams. */
async function consumed(name: string, replies: readonly Reply[], body: string) {
	return served(replies, async (server) => {
		const run = await consume("ws", name, { base: server.url, body })
		return { hops: [...server.hops], run, streams: [...server.streams] }
	})
}

/** How a call's read ended: its own error (via, type), the close frame it ended on, each handler run as `event data`. */
const endOf = ({ error, stream }: Trace<CsError>["calls"][number]) => ({
	closedBy: stream?.closedBy,
	error: error && `${error.via} ${error.type}`,
	handlers: stream?.handlers?.map((h) => `${h.event} ${h.data}`),
})

/** csc's errors for `lines` (statements of a consumer's Main) against `ws`, each as `<the statement> → <CS code>: <message>`. */
function findings(lines: readonly string[]): string[] {
	const source = program("HoneySdk", "HoneySdkClient", lines.join("\n"))
	const rows = source.split("\n")
	return checked("ws", source).map((line) => {
		const found = /^\((\d+),\d+\): error (CS\d+: .*)$/.exec(line)
		return found === null ? line : `${rows[Number(found[1]) - 1]?.trim()} → ${found[2]}`
	})
}

const LAST_EVENT_ID = 'await c.Rooms.SocketAsync("r", lastEventId: "x");'
const TOKEN2 = 'await c.Rooms.SocketAsync("r", reconnectToken2: "x");'
const CODE_INT = "int code = w.ClosedBy!.Status;"
const TYPED = [
	"using var c = Client();",
	'TypedWebSocket w = await c.Rooms.SocketAsync("r");',
	'TypedWebSocket s = await c.Rooms.SocketAsync("r", since: 3, protocols: ["v2"], reconnectToken: "t");',
	'TypedWebSocket p = await c.Plain.SocketAsync(protocols: ["v1"], reconnectToken: "t");',
	"System.IAsyncDisposable d = w;",
	"WsMessage? m = await w.ReceiveAsync();",
	"System.Net.WebSockets.WebSocketMessageType kind = m!.Type;",
	"byte[] data = m.Data;",
	"string text = m.Text;",
	"WsClose? by = w.ClosedBy;",
	"System.Net.WebSockets.WebSocketCloseStatus status = by!.Status;",
	"string? chosen = w.Subprotocol;",
	"w.Message += message => Note(message.Text);",
	"w.Closed += close => Note(close.Reason);",
	"w.Error += error => Note(error.Message);",
	'await w.SendAsync("t");',
	"await w.SendAsync(new byte[] { 1 });",
	"await w.SendAsync(1L, (System.Text.Json.Serialization.Metadata.JsonTypeInfo<long>)null!);",
	'await w.CloseAsync((System.Net.WebSockets.WebSocketCloseStatus)4401, "x");',
	"await w.CloseAsync();",
	LAST_EVENT_ID,
	TOKEN2,
	CODE_INT,
]

describe.skipIf(!DOTNET)("a WebSocket method: an awaited TypedWebSocket over the SDK's own upgrade", SLOW, () => {
	/* ported: python ws.test.ts:118 (types the method and the socket; mypy's findings become csc's) */
	it("types the method, the reads, the events, ClosedBy and Subprotocol; refuses lastEventId, a token2 and an int status", () => {
		/* Fd5: the BCL's WebSocketCloseStatus, no int; the fold claims no reconnectToken2, and a socket has no event id */
		expect(findings(TYPED)).toEqual([
			`${LAST_EVENT_ID} → CS1739: The best overload for 'SocketAsync' does not have a parameter named 'lastEventId'`,
			`${TOKEN2} → CS1739: The best overload for 'SocketAsync' does not have a parameter named 'reconnectToken2'`,
			`${CODE_INT} → CS0266: Cannot implicitly convert type 'System.Net.WebSockets.WebSocketCloseStatus' to 'int'. An explicit conversion exists (are you missing a cast?)`,
		])
	})

	/* ported: python ws.test.ts:128 (an AsyncWebSocketSession inside becomes IAsyncDisposable) */
	it("is a TypedWebSocket and an IAsyncDisposable, whose await using closes 1000", async () => {
		const body = `using var c = Client();
await using (var w = await c.Rooms.SocketAsync("r"))
{
    Note(w.GetType().Name);
    Note($"{w is IAsyncDisposable}");
}`
		const { run, streams } = await consumed("surface", [ws([])], body)
		expect(seen(run), run.stderr).toEqual({ out: ["TypedWebSocket", "True"], ran: true })
		expect(streams[0]?.received).toEqual([closed(1000)])
	})

	/* ported: python ws.test.ts:143 */
	it("dials the escaped path as an upgrade and reads a JSON frame", async () => {
		const call = rooms({ params: { room: "a b/c" }, take: 1 })
		const { hops, run, streams } = await drive([ws([{ json: { n: 1 } }])], [call], { script: {} })
		expect(hops.map((hop) => hop.url)).toEqual(["/rooms/a%20b%2Fc"])
		const upgrade = {
			connection: expect.stringMatching(/upgrade/i),
			"sec-websocket-version": "13",
			upgrade: "websocket",
		}
		expect(hops[0]?.headers).toMatchObject(upgrade)
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: framed([{ n: 1 }]),
			stream: { yields: 1 },
		})
		expect(streams[0]?.received).toEqual([closed(1000)])
	})

	/* ported: python ws.test.ts:160 (the WS_STATUS_* constants become the BCL's WebSocketCloseStatus, Fd5) */
	it("prints a WsClose of the BCL's close status and its reason", async () => {
		const body = `Note(new WsClose(System.Net.WebSockets.WebSocketCloseStatus.NormalClosure, "done").ToString());`
		const run = await consume("ws", "codes", { body })
		expect(seen(run), run.stderr).toEqual({ out: ["WsClose { Status = NormalClosure, Reason = done }"], ran: true })
	})
})

describe.skipIf(!DOTNET)("the WebSocket dial: the call's headers, a request id, no hook or log (ruled)", SLOW, () => {
	/* ported: python ws.test.ts:170; red under M7 (the dial runs OnRequest/OnLog) */
	it("runs no request or response hook and logs nothing for the dial", async () => {
		const script: Script = { hooks: { request: [{ setHeader: ["x-hook", "1"] }], response: [{}] }, log: true }
		const { hops, run } = await drive([ws([{ text: "hi" }])], [rooms({ take: 1 })], { script })
		expect(hops[0]?.headers["x-hook"]).toBeUndefined()
		expect({ hooks: run.trace?.hooks, log: run.trace?.log, observed: run.observed }, run.stderr).toEqual({
			hooks: [],
			log: [],
			observed: framed(["hi"]),
		})
	})

	/* ported: python ws.test.ts:181 */
	it("sends the bearer token and the config and call headers, a fresh X-Request-Id per dial, a caller's kept", async () => {
		const setup: Setup = { auth: { kind: "bearer", token: "t" }, headers: { "X-Tenant": "acme" } }
		const fixed = { headers: { "x-request-id": "fixed" }, take: 0 }
		const calls = [rooms({ headers: { "x-call": "1" }, take: 0 }), rooms({ take: 0 }), rooms(fixed)]
		const { hops, run } = await drive([ws([]), ws([]), ws([])], calls, { setup })
		expect(hops[0]?.headers).toMatchObject({
			authorization: "Bearer t",
			upgrade: "websocket",
			"x-call": "1",
			"x-request-id": expect.stringMatching(UUID_V4),
			"x-tenant": "acme",
		})
		expect(run.observed, run.stderr).toEqual(framed([], [], []))
		const [first, second, kept] = hops.map((hop) => hop.headers["x-request-id"])
		expect([first !== second, second, kept]).toEqual([true, expect.stringMatching(UUID_V4), "fixed"])
	})
})

describe.skipIf(!DOTNET)("reconnectToken: one pair after the declared query, none when empty", SLOW, () => {
	/* ported: python ws.test.ts:202 */
	it("dials with since and the token, sends hello, reads the echo, and closes 1000", async () => {
		const call = rooms({ reconnectToken: "rt-1", search: { since: 3 }, take: 1 })
		const script: Script = { calls: [{ ws: { send: [{ text: "hello" }] } }] }
		const { hops, run, streams } = await drive([ws([{ receive: 1 }, { text: "echo:hello" }])], [call], { script })
		expect(hops.map((hop) => hop.url)).toEqual(["/rooms/r?since=3&reconnect_token=rt-1"])
		expect(run.observed, run.stderr).toEqual(framed(["echo:hello"]))
		expect(streams[0]?.received).toEqual([{ kind: "text", text: "hello" }, closed(1000)])
	})

	/* ported: python ws.test.ts:212 */
	it("sends reconnect_token once, after since, and nothing when the token is empty or unset", async () => {
		const calls = [
			rooms({ reconnectToken: "rt-1", take: 0 }),
			rooms({ reconnectToken: "rt-1", search: { since: 3 }, take: 0 }),
			rooms({ reconnectToken: "", take: 0 }),
			rooms({ take: 0 }),
			plain({ reconnectToken: "rt-2", take: 0 }),
		]
		const { hops, run } = await drive([ws([]), ws([]), ws([]), ws([]), ws([])], calls)
		expect(run.observed, run.stderr).toEqual(framed([], [], [], [], []))
		expect(hops.map((hop) => hop.url)).toEqual([
			"/rooms/r?reconnect_token=rt-1",
			"/rooms/r?since=3&reconnect_token=rt-1",
			"/rooms/r",
			"/rooms/r",
			"/plain?reconnect_token=rt-2",
		])
	})
})

describe.skipIf(!DOTNET)("protocols: the subprotocols offered in order, the server's choice exposed", SLOW, () => {
	/* ported: python ws.test.ts:235 */
	it("offers the protocols in order, and none without them", async () => {
		const replies = [ws([{ json: { p: 1 } }], "v1"), ws([{ json: { p: 2 } }], "v2"), ws([{ json: { p: 3 } }])]
		const calls = [plain({ take: 1 }), rooms({ take: 1 }), rooms({ take: 1 })]
		const script: Script = { calls: [{ protocols: ["v2", "v1"] }, { protocols: ["v2"] }, null] }
		const { hops, run } = await drive(replies, calls, { script })
		expect(run.observed, run.stderr).toEqual(framed([{ p: 1 }], [{ p: 2 }], [{ p: 3 }]))
		expect(hops.map((hop) => [hop.url, hop.headers["sec-websocket-protocol"]])).toEqual([
			["/plain", "v2, v1"],
			["/rooms/r", "v2"],
			["/rooms/r", undefined],
		])
	})

	/* ported: python ws.test.ts:250 */
	it("exposes the server's choice as Subprotocol, null when it picked none", async () => {
		const body = `using var c = Client();
var w = await c.Plain.SocketAsync(protocols: ["v2", "v1"]);
Note(w.Subprotocol);
await w.CloseAsync();
var bare = await c.Plain.SocketAsync();
Note(bare.Subprotocol);
await bare.CloseAsync();`
		const { run } = await consumed("subprotocol", [ws([], "v1"), ws([])], body)
		expect(seen(run), run.stderr).toEqual({ out: ["v1", "null"], ran: true })
	})
})

describe.skipIf(!DOTNET)("SendAsync: text as text, bytes as binary, a JsonTypeInfo's value as JSON text", SLOW, () => {
	/* ported: python ws.test.ts:266 */
	it("sends the grid's text, then JSON, text and binary, in order, and reads text and binary", async () => {
		const send = [{ json: { a: 1, é: "ü" } }, { text: "t" }, { bytes: 3 }]
		const script: Script = { calls: [{ ws: { on: true, send } }] }
		const reply = ws([{ receive: 4 }, { binary: 3 }, { json: { ok: true } }])
		const { run, streams } = await drive([reply], [rooms({ send: ['{"x":1}'], take: 2 })], { script })
		const three = createHash("sha256")
			.update(Buffer.from([0, 1, 2]))
			.digest("hex")
		/* §7's flag: STJ's default encoder escapes non-ASCII, where Python and Rust send raw UTF-8 */
		expect(streams[0]?.received.slice(0, 4)).toEqual([
			{ kind: "text", text: '{"x":1}' },
			{ kind: "text", text: '{"a":1,"\\u00E9":"\\u00FC"}' },
			{ kind: "text", text: "t" },
			{ kind: "binary", sha256: three, size: 3 },
		])
		const handlers = ["message \u0000\u0001\u0002", 'message {"ok":true}', "close "]
		const call = run.trace?.calls[0]
		expect({ end: call && endOf(call), observed: run.observed }, run.stderr).toEqual({
			end: { closedBy: undefined, error: undefined, handlers },
			observed: framed(["\u0000\u0001\u0002", { ok: true }]),
		})
		expect(streams[0]?.received[4]).toEqual(closed(1000))
	})

	/* ported: python ws.test.ts:289 */
	it("throws a send on an ended socket without the payload in its message or ToString()", async () => {
		const body = `using var c = Client();
var w = await c.Rooms.SocketAsync("r");
Note(await w.ReceiveAsync());
var secret = "SECRET-" + new string('x', 64);
try
{
    await w.SendAsync(secret);
    Note("sent");
}
catch (Exception e)
{
    Note($"{e.GetType().Name}: {e.Message}");
    Note($"{e.Message.Contains(secret)} {e.ToString().Contains(secret)}");
}
await w.CloseAsync();`
		const { run } = await consumed("send_ended", [ws([{ close: { code: 1000, reason: "done" } }])], body)
		const out = ["null", "ApiConnectionException: the WebSocket is closed", "False False"]
		expect(seen(run), run.stderr).toEqual({ out, ran: true })
	})
})

describe.skipIf(!DOTNET)("how a read ends: the server's close echoed at once, a drop, the client's close", SLOW, () => {
	/* ported: python ws.test.ts:308 */
	it("ends on the server's close as ClosedBy, the echo sent, Closed once; on a drop, Error once", async () => {
		const replies = [ws([{ close: { code: 1000, reason: "done" } }]), ws([{ drop: true }])]
		const script: Script = { calls: [{ ws: { on: true } }, { ws: { on: true } }] }
		const { run, streams } = await drive(replies, [rooms(), rooms()], { script })
		expect(streams[0]?.received).toEqual([closed(1000, "done")])
		expect(run.observed, run.stderr).toEqual(framed([], []))
		const [server, drop] = run.trace?.calls ?? []
		expect([server && endOf(server), drop && endOf(drop)]).toEqual([
			{ closedBy: { code: 1000, reason: "done" }, error: undefined, handlers: ["close done"] },
			{ closedBy: undefined, error: "stream ApiConnectionException", handlers: ["error the WebSocket failed"] },
		])
	})

	/* ported: python ws.test.ts:323; red under M6 (no echo): .NET sends no WS frame at exit, so the frame is the SDK's */
	it("echoes the server's close at once with its code and reason, the client never closing", async () => {
		const body = `var c = Client();
var w = await c.Plain.SocketAsync();
Note(await w.ReceiveAsync());
await Task.Delay(500);`
		const { run, streams } = await consumed("echo", [ws([{ close: { code: 1001, reason: "bye" } }])], body)
		expect(streams[0]?.received).toEqual([closed(1001, "bye")])
		expect(seen(run), run.stderr).toEqual({ out: ["null"], ran: true })
	})

	/* ported: python ws.test.ts:337 */
	it("fires Closed with the client's own code and reason, cut at 123 bytes on a character, a throwing handler ignored", async () => {
		const body = `using var c = Client();
var w = await c.Plain.SocketAsync();
w.Closed += _ => throw new InvalidOperationException("boom");
w.Closed += by => Note(JsonSerializer.Serialize(new object[] { (int)by.Status, by.Reason }));
await w.CloseAsync((System.Net.WebSockets.WebSocketCloseStatus)1001, new string('a', 122) + "\\u00e9");
await w.CloseAsync();
Note(await w.ReceiveAsync());`
		const { run, streams } = await consumed("client_close", [ws([])], body)
		/* a close frame's payload is at most 125 bytes, the code's 2 among them: "é" would end at byte 124 */
		expect(streams[0]?.received).toEqual([closed(1001, "a".repeat(122))])
		const out = [JSON.stringify([1001, "a".repeat(122)]), "null"]
		expect(seen(run), run.stderr).toEqual({ out, ran: true })
	})
})

describe.skipIf(!DOTNET)("one message cap, 16 MiB: over it is an error, never a clean close", SLOW, () => {
	/* ported: python ws.test.ts:358; red under M14 (the cap off) */
	it("reads a 64 KiB frame, and fires Error once on a message one byte over 16 MiB, closing 1009", async () => {
		const big = "x".repeat(65_536)
		const replies = [ws([{ json: big }]), ws([{ text: "x".repeat(MESSAGE_CAP + 1) }, { json: "after" }])]
		const script: Script = { calls: [null, { ws: { on: true } }] }
		const { run, streams } = await drive(replies, [rooms({ take: 1 }), rooms()], { script })
		expect(run.observed, run.stderr).toEqual(framed([big], []))
		const [over, text] = [run.trace?.calls[1], "the WebSocket ended: 1009 Message too big"]
		expect({ end: over && endOf(over), text: over?.error?.text }).toEqual({
			end: { closedBy: undefined, error: "stream ApiConnectionException", handlers: [`error ${text}`] },
			text,
		})
		/* Q-d4: C# tells the server why (§7's 1009 flag) */
		expect(streams[1]?.received).toEqual([closed(1009, "Message too big")])
	})
})

describe.skipIf(!DOTNET)("what fails before the dial, and an idle open socket", SLOW, () => {
	/* ported: python ws.test.ts:373 */
	it("refuses a `..` room before dialing: PathParamException via return, nothing sent", async () => {
		const { hops, run } = await drive([ws([])], [rooms({ params: { room: ".." } })], { script: {} })
		const error = run.trace?.calls[0]?.error
		expect(run.observed, run.stderr).toEqual([null])
		expect([hops.length, error?.type, error?.via]).toEqual([0, "PathParamException", "return"])
	})

	/* ported: python ws.test.ts:421 (the timed open follows an unbounded warm one on the same client) */
	it("lets an open socket idle past the timeout: no read bound once it opened", async () => {
		const body = `using var c = Client(new ClientConfig { Timeout = TimeSpan.FromMilliseconds(300) });
var warm = await c.Rooms.SocketAsync("r", options: new RequestOptions { Timeout = TimeSpan.Zero });
await warm.CloseAsync();
var w = await c.Rooms.SocketAsync("r");
Note((await w.ReceiveAsync())?.Text);
await w.CloseAsync();`
		const replies = [ws([]), ws([{ waitMs: 1000 }, { json: { late: true } }])]
		const { run } = await consumed("idle", replies, body)
		expect(seen(run), run.stderr).toEqual({ out: ['{"late":true}'], ran: true })
	})
})

describe.skipIf(!DOTNET)("the method's token: it bounds the handshake and ends an open socket (Fd2)", SLOW, () => {
	/* ported: python ws.test.ts:434 (a 300 ms cancel against a 5 s handshake, after a warm call) */
	it("cancels before dialing and a slow handshake while it waits: canceled via return, one upgrade sent", async () => {
		const slow: Reply = { ...ws([]), delayMs: 5000 }
		const script: Script = { calls: [null, { cancel: "before" }, { cancel: { afterMs: 300 } }] }
		const { hops, run } = await drive([ws([]), slow], [WARM, rooms(), rooms()], { script })
		const [, before, during] = run.trace?.calls ?? []
		expect(during?.elapsedMs).toBeLessThan(4000)
		expect(run.observed, run.stderr).toEqual([...framed([]), null, null])
		const ended = [before, during].map((call) => [call?.error?.canceled, call?.error?.via])
		expect({ ended, upgrades: hops.map((hop) => hop.headers.upgrade) }).toEqual({
			ended: [
				[true, "return"],
				[true, "return"],
			],
			upgrades: ["websocket", "websocket"],
		})
	})

	/* ported: python ws.test.ts:447; red under M2 (no registration): the read waits for frame 2, then the driver's close */
	it("ends an open socket when the token fires after it opened: the frames so far, the OCE, the SDK's 1000 close", async () => {
		/* the cancel lands 1,000 ms in, after the first frame, and 4,000 ms before the second (the bit-14 timing rule) */
		const held = ws([{ json: { n: 1 } }, { waitMs: 5000 }, { json: { n: 2 } }])
		const own = { cancel: { afterMs: 1000 }, ws: { close: { code: 4000, reason: "driver" } } }
		const { run, streams } = await drive([ws([]), held], [WARM, rooms({ take: 2 })], { script: { calls: [null, own] } })
		const call = run.trace?.calls[1]
		expect({ error: call?.error, observed: run.observed }, run.stderr).toEqual({
			error: CANCELED,
			observed: framed([], [{ n: 1 }]),
		})
		/* a `4000 driver` frame is the driver's own close: a cancel that closed nothing sends that, never 1000 */
		expect(streams[1]?.received).toEqual([closed(1000)])
		expect(call?.elapsedMs).toBeLessThan(4000)
	})
})

describe.skipIf(!DOTNET)("a read's own token, and a socket used from several tasks (Fd3)", SLOW, () => {
	/* Fd3: C#'s own; a socket has no cursor, so a cancelled read ends it */
	it("ends the socket on a read's own token: OperationCanceledException, a 1000 close, then null", async () => {
		const body = `using var c = Client();
var w = await c.Rooms.SocketAsync("r");
try
{
    await w.ReceiveAsync(new System.Threading.CancellationTokenSource(300).Token);
    Note("read");
}
catch (OperationCanceledException)
{
    Note("OperationCanceledException");
}
Note(await w.ReceiveAsync());`
		const { run, streams } = await consumed("read_token", [ws([])], body)
		expect(seen(run), run.stderr).toEqual({ out: ["OperationCanceledException", "null"], ran: true })
		expect(streams[0]?.received).toEqual([closed(1000)])
	})

	/* ported: python ws.test.ts:459 (its dropped half is Fd9's: no finalizer, so no C# port) */
	it("closes from the main flow a socket dialed in one task and read in another", async () => {
		const body = `using var c = Client();
var w = await Task.Run(() => c.Rooms.SocketAsync("r"));
var m = await Task.Run(() => w.ReceiveAsync());
Note(m?.Text);
try
{
    await w.CloseAsync();
    Note("close ok");
}
catch (Exception e)
{
    Note(e.GetType().Name);
}`
		const { run, streams } = await consumed("tasks", [ws([{ json: { ok: 1 } }])], body)
		expect(seen(run), run.stderr).toEqual({ out: ['{"ok":1}', "close ok"], ran: true })
		expect(streams[0]?.received).toEqual([closed(1000)])
	})
})
