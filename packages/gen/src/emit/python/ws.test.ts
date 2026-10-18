/**
 * A WebSocket operation's emitted Python (contract 34 §2.2, §6.4; Fd2, Fd4, Fd5; Rust's `ws.test.ts`): the awaited
 * `TypedWebSocket` over httpx2's `AsyncWebSocketSession`, dialing the escaped path with the call's headers, a fresh
 * `X-Request-Id` and no hook or log; `reconnect_token` (one pair, none when empty) and `protocols`; `send`, `recv`,
 * `on`, `closed_by`, `subprotocol`, `close` and the `WS_STATUS_*` codes; how a read ends (the server's close echoed
 * at once, a drop, the 16 MiB cap); what fails at the handshake; `options["cancel"]`; a socket held in its own task.
 * Streams are `AsyncSDK`'s alone (G2). Driven on the `ws` registry document; tasks, drops and types are consumers.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { PythonError, Script, Trace } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { checked, consume, seen } from "./__fixtures__/consumer.ts"
import { type DrivenPythonSdk, drivenPythonSdk } from "./__fixtures__/driven.ts"
import { withPython } from "./__fixtures__/python-env.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 }

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/* httpx2's session caps a message at 16 MiB (Fd2's `max_message_size_bytes`) */
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

/** The `ws` SDK with the driver aimed at it, which must import. */
function driven(): DrivenPythonSdk {
	const sdk = drivenPythonSdk("ws")
	expect(sdk.imported, sdk.stderr).toBe(true)
	return sdk
}

type Options = { readonly script?: Script; readonly setup?: Setup }

/** `calls` run on `AsyncSDK` by the `ws` driver against a server answering `replies`: the run, hops and streams. */
async function drive(replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	const sdk = driven()
	return served(replies, async (server) => {
		const cell = { calls, setup: options.setup ?? {} }
		const run = await sdk.runCalls(cell, { url: server.url }, { client: "async", script: options.script })
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

/** A consumer's tail (in `async with`) that prints its notes and exits at once: what the server got came before it. */
const EXIT_NOW = "    print(json.dumps(OUT), flush=True)\n    os._exit(0)"

/** How a call's read ended: its own error (via, type), the close frame it ended on, each handler run as `event data`. */
const endOf = ({ error, stream }: Trace<PythonError>["calls"][number]) => ({
	closedBy: stream?.closedBy,
	error: error && `${error.via} ${error.type}`,
	handlers: stream?.handlers?.map((h) => `${h.event} ${h.data}`),
})

/** mypy's findings for `lines` (one program) against `ws`, each as `<line>: <message>`. */
const findings = (lines: readonly string[]) =>
	checked("ws", `${lines.join("\n")}\n`).map((line) => line.replace(/^[^:]+:(\d+): error: /, "$1: "))

const OPEN = '    w.on("open", print)'
const TOKEN2 = '    await c.rooms.socket("r", reconnect_token2="t")'
const SYNC = "sdk.SDK().rooms"
const TYPED = [
	"from typing import assert_type",
	"import honey_sdk as sdk",
	"async def run(c: sdk.AsyncSDK) -> None:",
	'    w: sdk.TypedWebSocket = await c.rooms.socket("r", since=3, protocols=["v2"], reconnect_token="t")',
	'    _: sdk.TypedWebSocket = await c.plain.socket(protocols=("v1",))',
	"    async with w as same:",
	"        assert_type(same, sdk.TypedWebSocket)",
	"    assert_type(await w.recv(), str | bytes | None)",
	"    async for message in w:",
	"        assert_type(message, str | bytes)",
	'    await w.send({"a": 1})',
	"    assert_type(w.closed_by, sdk.WsClose | None)",
	"    assert_type(w.subprotocol, str | None)",
	"    codes: list[int] = [sdk.WS_STATUS_NORMAL_CLOSURE, sdk.WS_STATUS_GOING_AWAY, sdk.WS_STATUS_PROTOCOL_ERROR]",
	'    w.on("close", lambda by: print(by.code, by.reason, codes))',
	OPEN,
	TOKEN2,
	'    await w.close(sdk.WS_STATUS_GOING_AWAY, "bye")',
	SYNC,
]
/** The finding mypy gives at `line` of TYPED. */
const at = (line: string, message: string) => `${TYPED.indexOf(line) + 1}: ${message}`
const NO_OPEN = `Argument 1 to "on" of "TypedWebSocket" has incompatible type "Literal['open']"; expected "Literal['message', 'close', 'error']"  [arg-type]`
const NO_TOKEN2 = `Unexpected keyword argument "reconnect_token2" for "socket" of "AsyncRoomsResource"; did you mean "reconnect_token"?  [call-arg]`

describe.skipIf(!PY)("a WebSocket method: an awaited TypedWebSocket over httpx2's session", SLOW, () => {
	/* ruling G9/G15: v0's `subscribe` context manager over `websockets` becomes an awaited TypedWebSocket over httpx2 */
	// v0: a362efa7d9
	// v0: cb06f34876
	it("types the method, the reads, closed_by, subprotocol and the codes; refuses open, a token2 and SDK", () => {
		/* ruling Fd2: v0's `open` event drops (the awaited socket is already open); the fold claims no reconnect_token2 */
		expect(findings(TYPED)).toEqual([
			at(OPEN, NO_OPEN),
			at(TOKEN2, NO_TOKEN2),
			at(SYNC, '"SDK" has no attribute "rooms"  [attr-defined]'),
		])
	})

	// v0: a362efa7d9
	it("is a TypedWebSocket holding an AsyncWebSocketSession, whose async with closes 1000; recv then reads None", async () => {
		const body = `async with aclient() as c:
    w: sdk.TypedWebSocket = await c.rooms.socket("r")
    note(type(w).__name__)
    note(type(w.session).__name__)
    async with w as same:
        note(same is w)
    note(repr(await w.recv()))`
		const { run, streams } = await consumed("surface", [ws([])], body)
		const out = ["TypedWebSocket", "AsyncWebSocketSession", "true", "None"]
		expect(seen(run), run.stderr).toEqual({ out, ran: true })
		expect(streams[0]?.received).toEqual([closed(1000)])
	})

	// v0: a362efa7d9
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

	it("exports WS_STATUS_NORMAL_CLOSURE, WS_STATUS_GOING_AWAY, WS_STATUS_PROTOCOL_ERROR and WsClose", async () => {
		const body = `note([sdk.WS_STATUS_NORMAL_CLOSURE, sdk.WS_STATUS_GOING_AWAY, sdk.WS_STATUS_PROTOCOL_ERROR])
note(repr(sdk.WsClose(1000, "done")))`
		const run = await consume("ws", "codes", { body })
		const out = ["[1000, 1001, 1002]", "WsClose(code=1000, reason='done')"]
		expect(seen(run), run.stderr).toEqual({ out, ran: true })
	})
})

describe.skipIf(!PY)("the WebSocket dial: the call's headers, a request id, no hook or log (Fd5)", SLOW, () => {
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

describe.skipIf(!PY)("reconnect_token: one pair after the declared query, none when empty", SLOW, () => {
	/* v0 asserted ws._url, a private attribute; v1 pins the hop */
	// v0: 93f3817cbc
	it("dials with since and the token, sends hello, reads the echo, and closes 1000", async () => {
		const call = rooms({ reconnectToken: "rt-1", search: { since: 3 }, take: 1 })
		const script: Script = { calls: [{ ws: { send: [{ text: "hello" }] } }] }
		const { hops, run, streams } = await drive([ws([{ receive: 1 }, { text: "echo:hello" }])], [call], { script })
		expect(hops.map((hop) => hop.url)).toEqual(["/rooms/r?since=3&reconnect_token=rt-1"])
		expect(run.observed, run.stderr).toEqual(framed(["echo:hello"]))
		expect(streams[0]?.received).toEqual([{ kind: "text", text: "hello" }, closed(1000)])
	})

	// v0: 93f3817cbc
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

describe.skipIf(!PY)("protocols: the subprotocols offered in order, the server's choice exposed", SLOW, () => {
	/* SOURCE-TEXT → behavior (H22): v0 grepped `protocols\s*[=:]` in client.py */
	// v0: fb16532a18
	it("offers the protocols in order, and none without them", async () => {
		const replies = [ws([{ json: { p: 1 } }], "v1"), ws([{ json: { p: 2 } }], "v2"), ws([{ json: { p: 3 } }])]
		const calls = [plain({ take: 1 }), rooms({ take: 1 }), rooms({ take: 1 })]
		const script: Script = { calls: [{ protocols: ["v2", "v1"] }, { protocols: ["v2"] }, null] }
		const { hops, run } = await drive(replies, calls, { script })
		expect(hops[0]?.headers["sec-websocket-protocol"]).toBe("v2, v1")
		expect(run.observed, run.stderr).toEqual(framed([{ p: 1 }], [{ p: 2 }], [{ p: 3 }]))
		expect(hops.map((hop) => [hop.url, hop.headers["sec-websocket-protocol"]])).toEqual([
			["/plain", "v2, v1"],
			["/rooms/r", "v2"],
			["/rooms/r", undefined],
		])
	})

	// v0: fb16532a18
	it("exposes the server's choice as subprotocol, None when it picked none", async () => {
		const body = `async with aclient() as c:
    w = await c.plain.socket(protocols=["v2", "v1"])
    note(repr(w.subprotocol))
    await w.close()
    bare = await c.plain.socket()
    note(repr(bare.subprotocol))
    await bare.close()`
		const { run } = await consumed("subprotocol", [ws([], "v1"), ws([])], body)
		expect(seen(run), run.stderr).toEqual({ out: ["'v1'", "None"], ran: true })
	})
})

describe.skipIf(!PY)("send: text as text, bytes as binary, anything else as compact JSON", SLOW, () => {
	/* SOURCE-TEXT → behavior (H22): v0 grepped `def send` and `json.dumps`; v1 pins the frames and their encoding */
	// v0: 0c20c0a498
	it("sends the grid's text, then JSON as compact UTF-8 text, text and binary, in order, and reads text and binary", async () => {
		const send = [{ json: { a: 1, é: "ü" } }, { text: "t" }, { bytes: 3 }]
		const script: Script = { calls: [{ ws: { on: true, send } }] }
		const reply = ws([{ receive: 4 }, { binary: 3 }, { json: { ok: true } }])
		const { run, streams } = await drive([reply], [rooms({ send: ['{"x":1}'], take: 2 })], { script })
		const three = createHash("sha256")
			.update(Buffer.from([0, 1, 2]))
			.digest("hex")
		expect(streams[0]?.received.slice(0, 4)).toEqual([
			{ kind: "text", text: '{"x":1}' },
			{ kind: "text", text: '{"a":1,"é":"ü"}' },
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

	it("raises a send on an ended socket without the payload in its text or repr", async () => {
		const body = `async with aclient() as c:
    w = await c.rooms.socket("r")
    note(repr(await w.recv()))
    secret = "SECRET-" + "x" * 64
    try:
        await w.send(secret)
        note("sent")
    except Exception as e:
        note([secret in str(e), secret in repr(e)])
    await w.close()`
		const { run } = await consumed("send_ended", [ws([{ close: { code: 1000, reason: "done" } }])], body)
		expect(seen(run), run.stderr).toEqual({ out: ["None", "[false, false]"], ran: true })
	})
})

describe.skipIf(!PY)("how a read ends: the server's close echoed at once, a drop, the client's close", SLOW, () => {
	/* N-WS4: v0's error handlers were not once-guarded; ruling Fd2: one end fires, once, and open drops */
	// v0: cb06f34876
	it("ends on the server's close as closed_by, the echo sent, its close handler once; on a drop, error once", async () => {
		const replies = [ws([{ close: { code: 1000, reason: "done" } }]), ws([{ drop: true }])]
		const script: Script = { calls: [{ ws: { on: true } }, { ws: { on: true } }] }
		const { run, streams } = await drive(replies, [rooms(), rooms()], { script })
		/* the committed runtime echoed nothing at receipt, and later sent 1000 "" at close() (contract 34 §3.4 #12) */
		expect(streams[0]?.received).toEqual([closed(1000, "done")])
		expect(run.observed, run.stderr).toEqual(framed([], []))
		const [server, drop] = run.trace?.calls ?? []
		expect([server && endOf(server), drop && endOf(drop)]).toEqual([
			{ closedBy: { code: 1000, reason: "done" }, error: undefined, handlers: ["close done"] },
			{ closedBy: undefined, error: "stream APIConnectionError", handlers: [`error ${drop?.error?.text}`] },
		])
	})

	// v0: cb06f34876
	it("echoes the server's close at once with its code and reason, the client never closing", async () => {
		const body = `import os
async with aclient() as c:
    w = await c.plain.socket()
    note(repr(await w.recv()))
    await asyncio.sleep(0.5)
${EXIT_NOW}`
		const { run, streams } = await consumed("echo", [ws([{ close: { code: 1001, reason: "bye" } }])], body)
		expect(streams[0]?.received).toEqual([closed(1001, "bye")])
		expect(seen(run), run.stderr).toEqual({ out: ["None"], ran: true })
	})

	/* N-WS2 and N-WS3: v0's close() fired no close handler and sent any reason length */
	// v0: cb06f34876
	it("fires close with the client's own code and reason, cut at 123 bytes on a character, a raising handler ignored", async () => {
		const body = `async with aclient() as c:
    w = await c.plain.socket()

    def boom(_: object) -> None:
        raise RuntimeError("boom")

    w.on("close", boom)
    w.on("close", lambda by: note([by.code, by.reason]))
    await w.close(1001, "a" * 122 + "é")
    await w.close()
    note(repr(await w.recv()))`
		const { run, streams } = await consumed("client_close", [ws([])], body)
		/* a close frame's payload is at most 125 bytes, the code's 2 among them: "é" would end at byte 124 */
		expect(streams[0]?.received).toEqual([closed(1001, "a".repeat(122))])
		expect(seen(run), run.stderr).toEqual({ out: [`[1001, "${"a".repeat(122)}"]`, "None"], ran: true })
	})
})

describe.skipIf(!PY)("one message cap, 16 MiB: over it is an error, never a clean close", SLOW, () => {
	/* V0BUG (survey 10): v0 had two WebSocket caps (_transport.py:45,162 and none in _ws.py:146-150); v1 has one, 16 MiB */
	it("reads a 64 KiB frame, and fires error once on a message one byte over 16 MiB, never a clean close", async () => {
		const big = "x".repeat(65_536)
		const replies = [ws([{ json: big }]), ws([{ text: "x".repeat(MESSAGE_CAP + 1) }, { json: "after" }])]
		const script: Script = { calls: [null, { ws: { on: true } }] }
		const { run } = await drive(replies, [rooms({ take: 1 }), rooms()], { script })
		expect(run.observed, run.stderr).toEqual(framed([big], []))
		const [over, text] = [run.trace?.calls[1], "the WebSocket ended: 1009 Message too big"]
		expect({ end: over && endOf(over), text: over?.error?.text }).toEqual({
			end: { closedBy: undefined, error: "stream APIConnectionError", handlers: [`error ${text}`] },
			text,
		})
	})
})

describe.skipIf(!PY)("what fails before or at the handshake, nothing read", SLOW, () => {
	it("refuses a `..` room before dialing: PathParamError via return, nothing sent", async () => {
		const { hops, run } = await drive([ws([])], [rooms({ params: { room: ".." } })], { script: {} })
		const error = run.trace?.calls[0]?.error
		expect(run.observed, run.stderr).toEqual([null])
		expect([hops.length, error?.type, error?.via]).toEqual([0, "PathParamError", "return"])
	})

	it("is the status's error for a refused handshake, its body read: ForbiddenError, HTTP 403: no", async () => {
		const { hops, run } = await drive([{ json: { message: "no" }, status: 403 }], [rooms()], { script: {} })
		const call = run.trace?.calls[0]
		expect(run.observed, run.stderr).toEqual([{ body: { message: "no" }, errorKey: null, kind: "error", status: 403 }])
		const upgrades = hops.map((hop) => `${hop.url} ${hop.headers.upgrade}`)
		const error = [call?.error?.type, call?.error?.text, call?.error?.via]
		expect([error, call?.stream, upgrades]).toEqual([
			["ForbiddenError", "HTTP 403: no", "return"],
			undefined,
			["/rooms/r websocket"],
		])
	})

	it("is APIConnectionError for a closed origin, never httpx2's own error", async () => {
		const origin = { url: "http://127.0.0.1:9" }
		const run = await driven().runCalls({ calls: [rooms()] }, origin, { client: "async", script: {} })
		const error = run.trace?.calls[0]?.error
		expect([run.observed, error?.type, error?.via], run.stderr).toEqual([[null], "APIConnectionError", "return"])
	})

	/* H18.10: an upgrade follows no redirect, even through a caller client that follows them */
	it("follows no redirect on the upgrade through a caller's following client: the 307 is the answer, one hop", async () => {
		const replies: Reply[] = [{ redirect: { origin: "alt", path: "/rooms/r" }, status: 307 }, ws([])]
		const { hops, run } = await drive(replies, [rooms()], { script: { config: { httpClient: true } } })
		const error = run.trace?.calls[0]?.error
		expect(hops.map((hop) => `${hop.origin} ${hop.url}`)).toEqual(["primary /rooms/r"])
		const answer = expect.objectContaining({ kind: "error", status: 307 })
		expect([run.observed, error?.type, error?.status], run.stderr).toEqual([[answer], "APIStatusError", 307])
	})

	/* G15: the open keeps the call's timeout; the committed handshake waited on httpx2's 5 s client default */
	it("bounds a slow handshake by the call's timeout: APITimeoutError via return, the grid's timeout", async () => {
		const started = Date.now()
		const slow: Reply = { ...ws([]), delayMs: 3000 }
		const { run } = await drive([slow], [rooms()], { script: {}, setup: { timeoutMs: 300 } })
		expect(Date.now() - started).toBeLessThan(2500)
		const error = run.trace?.calls[0]?.error
		const lapsed = [[{ kind: "timeout" }], "APITimeoutError", "return"]
		expect([run.observed, error?.type, error?.via], run.stderr).toEqual(lapsed)
	})

	it("lets an open socket idle past the timeout: no read bound once it opened", async () => {
		const body = `async with aclient(timeout=0.3) as c:
    w = await c.rooms.socket("r")
    note(await w.recv())
    await w.close()`
		const { run } = await consumed("idle", [ws([{ waitMs: 1000 }, { json: { late: true } }])], body)
		expect(seen(run), run.stderr).toEqual({ out: ['{"late":true}'], ran: true })
	})
})

describe.skipIf(!PY)("options['cancel']: it bounds the handshake and ends an open socket (Fd4)", SLOW, () => {
	/* the waits are 5 s against bounds of 2.5 s on the call's own time, which no interpreter start counts in: an
	 * ignored cancel always outlasts them; the cancels land a second in, after an AsyncSDK's first connect */
	it("cancels before dialing and a slow handshake while it waits: CanceledError via return, one upgrade sent", async () => {
		const slow: Reply = { ...ws([]), delayMs: 5000 }
		const script: Script = { calls: [{ cancel: "before" }, { cancel: { afterMs: 1000 } }] }
		const { hops, run } = await drive([slow], [rooms(), rooms()], { script })
		expect(run.trace?.calls[1]?.elapsedMs).toBeLessThan(2500)
		expect(run.observed, run.stderr).toEqual([null, null])
		const errors = run.trace?.calls.map((call) => `${call.error?.via} ${call.error?.type}`)
		expect({ errors, upgrades: hops.map((hop) => hop.headers.upgrade) }).toEqual({
			errors: ["return CanceledError", "return CanceledError"],
			upgrades: ["websocket"],
		})
	})

	it("ends an open socket quietly when the cancel fires after it opened: the frames so far, no error, a 1000 close", async () => {
		const held = ws([{ json: { n: 1 } }, { waitMs: 5000 }, { json: { n: 2 } }])
		const script: Script = { calls: [{ cancel: { afterMs: 1000 } }] }
		const { run, streams } = await drive([held], [rooms({ take: 2 })], { script })
		const call = run.trace?.calls[0]
		const quiet = { closedBy: undefined, error: undefined, handlers: undefined }
		expect([run.observed, call && endOf(call)], run.stderr).toEqual([framed([{ n: 1 }]), quiet])
		expect([(call?.elapsedMs ?? Infinity) < 2500, streams[0]?.received]).toEqual([true, [closed(1000)]])
	})
})

describe.skipIf(!PY)("a socket held in a task of its own: closed from another task, ended when dropped", SLOW, () => {
	it("closes from the main task a socket dialed in another, and sends a 1000 close when the socket is dropped", async () => {
		const tasks = await consumed(
			"tasks",
			[ws([{ json: { ok: 1 } }])],
			`async with aclient() as c:
    w = await asyncio.ensure_future(c.rooms.socket("r"))
    note(await w.recv())
    try:
        await w.close()
        note("close ok")
    except Exception as e:
        note(type(e).__name__)`,
		)
		const dropped = await consumed(
			"dropped",
			[ws([{ json: { ok: 1 } }])],
			`import gc
import os
async with aclient() as c:
    w = await c.rooms.socket("r")
    note(await w.recv())
    del w
    gc.collect()
    await asyncio.sleep(0.5)
${EXIT_NOW}`,
		)
		expect({ dropped: seen(dropped.run), tasks: seen(tasks.run) }, `${tasks.run.stderr}${dropped.run.stderr}`).toEqual({
			dropped: { out: ['{"ok":1}'], ran: true },
			tasks: { out: ['{"ok":1}', "close ok"], ran: true },
		})
		expect([tasks.streams[0]?.received, dropped.streams[0]?.received]).toEqual([[closed(1000)], [closed(1000)]])
	})
})
