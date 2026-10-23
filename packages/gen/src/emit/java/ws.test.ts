/**
 * A WebSocket operation in the Java SDK, driven (bit 16 phase d2a, K1–K9; C#'s `ws.test.ts` driven legs, contract 50
 * §5.4): the method opens a `TypedWebSocket` over the JDK's upgrade, dialing the escaped path with the call's headers,
 * a fresh X-Request-Id and no hook or log; `reconnectToken` (one pair after the declared query, none when empty) and
 * `protocols`; sends in order; how a read ends (the server's close echoed at once, a drop, the 16 MiB cap closing
 * 1009); what fails before the dial; a restricted header refused by name; the reading thread's interrupt on the
 * handshake and on an open socket (Temurin 17 and 21). Consumer and type legs: `ws.api.test.ts`; the handshake's
 * refusals and raw: `ws.raw.test.ts`; the keepalive, the send gate and the ends in process: `ws.socket.test.ts`.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { JavaError, Script, Trace } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/* a Java socket caps a message at 16 MiB (K5) */
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
/** A stream's cancel as traced: the reader's interrupt ended it (K9), via the stream. */
const CANCELED = expect.objectContaining({ canceled: true, via: "stream" })
/** The warm call a timed call follows on its client, unbounded (per-call timeout 0). */
const WARM = rooms({ take: 0, timeoutMs: 0 })
/** The JDKs an interrupt leg runs on (condition b, as d1). */
const JDKS = [17, 21] as const

/** The `ws` SDK with the driver aimed at it, which must build. */
function driven(): DrivenJavaSdk {
	const sdk = drivenJavaSdk("ws")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

type Options = { readonly jdk?: 17 | 21; readonly script?: Script; readonly setup?: Setup }

/** `calls` run by the `ws` driver against a server answering `replies`: the run, hops and streams. */
async function drive(replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	const sdk = driven()
	return served(replies, async (server) => {
		const cell = { calls, setup: options.setup ?? {} }
		const run = await sdk.runCalls(cell, { url: server.url }, { jdk: options.jdk, script: options.script })
		return { hops: [...server.hops], run, streams: [...server.streams] }
	})
}

/** How a call's read ended: its own error (via, type), the close frame it ended on, each handler run as `event data`. */
const endOf = ({ error, stream }: Trace<JavaError>["calls"][number]) => ({
	closedBy: stream?.closedBy,
	error: error && `${error.via} ${error.type}`,
	handlers: stream?.handlers?.map((h) => `${h.event} ${h.data}`),
})

describe.skipIf(!JAVA)("a WebSocket method: a TypedWebSocket over the JDK's upgrade", SLOW, () => {
	/* new: C# ws.test.ts:150 */
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
})

describe.skipIf(!JAVA)("the WebSocket dial: the call's headers, a request id, no hook or log (K3)", SLOW, () => {
	/* new: C# ws.test.ts:177 */
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

	/* new: C# ws.test.ts:189 */
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

	/* new: W1 ruling (c2 Qc6 parity): the JDK's raw IllegalArgumentException never escapes; nothing is dialed */
	it.each(["Connection", "Host", "Sec-WebSocket-Key"])(
		"refuses a %s header by name as ConfigException, before any dial",
		async (name) => {
			const { hops, run } = await drive([ws([])], [rooms({ headers: { [name]: "x" } })], { script: {} })
			const error = run.trace?.calls[0]?.error
			expect({ chain: error?.chain, hops: hops.length, inner: error?.inner, text: error?.text }, run.stderr).toEqual({
				chain: ["ConfigException", "HoneyException"],
				hops: 0,
				inner: null,
				text: `the ${name} header is restricted and cannot be sent`,
			})
		},
	)
})

describe.skipIf(!JAVA)("reconnectToken: one pair after the declared query, none when empty (K2)", SLOW, () => {
	/* new: C# ws.test.ts:209 */
	it("dials with since and the token, sends hello, reads the echo, and closes 1000", async () => {
		const call = rooms({ reconnectToken: "rt-1", search: { since: 3 }, take: 1 })
		const script: Script = { calls: [{ ws: { send: [{ text: "hello" }] } }] }
		const { hops, run, streams } = await drive([ws([{ receive: 1 }, { text: "echo:hello" }])], [call], { script })
		expect(hops.map((hop) => hop.url)).toEqual(["/rooms/r?since=3&reconnect_token=rt-1"])
		expect(run.observed, run.stderr).toEqual(framed(["echo:hello"]))
		expect(streams[0]?.received).toEqual([{ kind: "text", text: "hello" }, closed(1000)])
	})

	/* new: C# ws.test.ts:219 */
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

describe.skipIf(!JAVA)("protocols: the subprotocols offered in order", SLOW, () => {
	/* new: C# ws.test.ts:241 */
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
})

describe.skipIf(!JAVA)("sends: text as text, bytes as binary, a value as JSON text, in order", SLOW, () => {
	/* new: C# ws.test.ts:270 (Jackson writes raw UTF-8, as Python and Rust do; C#'s STJ escapes) */
	it("sends the grid's text, then JSON, text and binary, in order, and reads text and binary", async () => {
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
})

describe.skipIf(!JAVA)("how a read ends: the server's close echoed at once, a drop, the cap", SLOW, () => {
	/* new: C# ws.test.ts:319 (W12: the JDK reads a drop as close 1006; the SDK reads it as the error) */
	it("ends on the server's close as closedBy, the echo sent, Closed once; on a drop, Error once", async () => {
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

	/* new: C# ws.test.ts:362 (W13: the JDK has no cap; the SDK's closes 1008, W20) */
	it("reads a 64 KiB frame, and fires Error once on a message one byte over 16 MiB, closing 1008", async () => {
		const big = "x".repeat(65_536)
		const replies = [ws([{ json: big }]), ws([{ text: "x".repeat(MESSAGE_CAP + 1) }, { json: "after" }])]
		const script: Script = { calls: [null, { ws: { on: true } }] }
		const { run, streams } = await drive(replies, [rooms({ take: 1 }), rooms()], { script })
		expect(run.observed, run.stderr).toEqual(framed([big], []))
		const [over, text] = [run.trace?.calls[1], "the WebSocket ended: 1008 Message too big"]
		expect({ end: over && endOf(over), text: over?.error?.text }).toEqual({
			end: { closedBy: undefined, error: "stream ApiConnectionException", handlers: [`error ${text}`] },
			text,
		})
		/* W20: the JDK lets a client send no 1009, so the SDK closes 1008, Policy Violation (C# sends 1009) */
		expect(streams[1]?.received).toEqual([closed(1008, "Message too big")])
	})
})

describe.skipIf(!JAVA)("what fails before the dial, and the reader's interrupt (K9)", SLOW, () => {
	/* new: C# ws.test.ts:380 */
	it("refuses a `..` room before dialing: PathParamException via return, nothing sent", async () => {
		const { hops, run } = await drive([ws([])], [rooms({ params: { room: ".." } })], { script: {} })
		const error = run.trace?.calls[0]?.error
		expect(run.observed, run.stderr).toEqual([null])
		expect([hops.length, error?.type, error?.via]).toEqual([0, "PathParamException", "return"])
	})

	/* new: C# ws.test.ts:403 (a 300 ms interrupt against a 5 s handshake, after a warm call) */
	it.each(JDKS)(
		"cancels before dialing and a slow handshake while it waits: canceled via return, one upgrade sent (JDK %i)",
		async (jdk) => {
			const slow: Reply = { ...ws([]), delayMs: 5000 }
			const script: Script = { calls: [null, { cancel: "before" }, { cancel: { afterMs: 300 } }] }
			const { hops, run } = await drive([ws([]), slow], [WARM, rooms(), rooms()], { jdk, script })
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
		},
	)

	/* new: C# ws.test.ts:421, :439 (the interrupt 1,000 ms in, the second frame 5,000 ms later) */
	it.each(JDKS)(
		"ends an open socket when its reader is interrupted: the frames so far, the cancel, the SDK's 1000 close (JDK %i)",
		async (jdk) => {
			const held = ws([{ json: { n: 1 } }, { waitMs: 5000 }, { json: { n: 2 } }])
			const own = { cancel: { afterMs: 1000 }, ws: { close: { code: 4000, reason: "driver" } } }
			const script = { calls: [null, own] }
			const { run, streams } = await drive([ws([]), held], [WARM, rooms({ take: 2 })], { jdk, script })
			const call = run.trace?.calls[1]
			expect({ error: call?.error, observed: run.observed }, run.stderr).toEqual({
				error: CANCELED,
				observed: framed([], [{ n: 1 }]),
			})
			/* a `4000 driver` frame is the driver's own close: an interrupt that closed nothing sends that, never 1000 */
			expect(streams[1]?.received).toEqual([closed(1000)])
			expect(call?.elapsedMs).toBeLessThan(4000)
		},
	)
})
