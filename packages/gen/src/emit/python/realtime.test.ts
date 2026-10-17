/**
 * The realtime answer (contract 34 Fd3–Fd5, §1 rules; Rust's `realtime.test.ts` analog), async only (G2): the
 * await dialing WebSocket, else SSE, else long-poll, cancel bounding it (Fd4); reconnects from the start of the
 * chain resuming from the advanced cursor on every transport; the backoff; the give-up once, then None (Fd9);
 * every dial's params, auth, headers and request id, the stream dials through the shared exchange (Fd5); the
 * message kind; send; and the emitted surface. Driven on the `realtime` document, with consumer programs and mypy.
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { CallScript, Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { compiledPython } from "./__fixtures__/compiled.ts"
import { checked, consume, program } from "./__fixtures__/consumer.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { type DrivenPythonSdk, drivenPythonSdk } from "./__fixtures__/driven.ts"
import { withPython } from "./__fixtures__/python-env.ts"
import { generatePythonSdk, pythonCallPlans } from "./sdk.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 }

/** The `realtime` SDK with the driver aimed at it, which must import. */
function driven(): DrivenPythonSdk {
	const sdk = drivenPythonSdk("realtime")
	expect(sdk.imported, sdk.stderr).toBe(true)
	return sdk
}

/** `calls` run on `AsyncSDK` under `setup` and `script` against a server answering `replies`: the run, hops, bodies, streams and base. */
async function drive(replies: readonly Reply[], calls: readonly Call[], o: { script?: Script; setup?: Setup } = {}) {
	const sdk = driven()
	return served(replies, async (server) => {
		const cell = { calls, setup: o.setup ?? {} }
		const run = await sdk.runCalls(cell, { url: server.url }, { client: "async", script: o.script ?? {} })
		const { bodies, hops, streams, url } = server
		return { base: url, bodies: [...bodies], hops: [...hops], run, streams: [...streams] }
	})
}
type Drove = Awaited<ReturnType<typeof drive>>

const FEED = { operation: "feed.live", route: { method: "GET", path: "/feed" }, search: { channel: "c" } }
const live = (extra: Partial<Call> = {}): Call => ({ ...FEED, ...extra })
const RESUME = { operation: "feed.resume", route: { method: "GET", path: "/resume" } }
/** the realtime fields under a script; QUICK's short first backoff lands a reconnect within 5–10 ms */
const budget = (realtime: CallScript["realtime"]): Script => ({ calls: [{ realtime }] })
const QUICK = budget({ reconnectDelayMs: 10 })
const refused: Reply = { json: { message: "no" }, status: 404 }
const unavailable: Reply = { status: 503, text: "" }
const bad: Reply = { json: { message: "bad" }, status: 400 }
const sse = (steps: readonly (string | { waitMs: number })[], end: "close" | "drop" | "hold"): Reply => ({
	sse: { end, steps },
	status: 200,
})
/** event n of a resumable stream: SSE id n, payload n with reconnect token rt-n */
const ev = (n: number) => `id: ${n}\ndata: {"n":${n},"reconnect_token":"rt-${n}"}\n\n`
const frame = (n: number) => ({ n, reconnect_token: `rt-${n}` })
const frames = (...values: readonly unknown[]) => [{ frames: values, kind: "frames" }]
/** a long-poll answer: payload n, its cursor in `id` and `reconnect_token` */
const polled = (n: number, id: string): Reply => ({ json: { id, n, reconnect_token: `rt-${id}` }, status: 200 })
/** what a polled payload reads as: a TypedDict is not narrowed at runtime, so its `id` stays (Rust's serde drops it) */
const polledFrame = (n: number, id: string) => ({ id, n, reconnect_token: `rt-${id}` })
/** refused upgrade, refused event stream, then long-poll: two polls answered */
const POLLED: readonly Reply[] = [refused, unavailable, polled(1, "7"), polled(2, "8")]
const RECONNECTING: readonly Reply[] = [refused, sse([ev(1)], "drop"), refused, sse([ev(2)], "hold")]
/** a hop's resume wire: its URL, then its Last-Event-ID header (`-` without one) */
const wire = (hop: RecordedHop | undefined) => `${hop?.url} ${hop?.headers["last-event-id"] ?? "-"}`
const FEED_URL = "/feed?channel=c"
/** which dial a hop is: a WebSocket upgrade, an event stream, else a poll */
const dialOf = (hop: RecordedHop) =>
	hop.headers.upgrade ? "upgrade" : hop.headers.accept === "text/event-stream" ? "sse" : "poll"
const BARE = `${FEED_URL} -`
const AT_1 = "/feed?channel=c&last_event_id=1&reconnect_token=rt-1"
/** a connection's stream trace: its frames read, the cursor `conn.opts` settled on ("id token"), the proven transport */
const settled = (yields: number, at: string, proven: string | null, errors: readonly string[] = []) => {
	const [lastEventId, reconnectToken] = at.split(" ")
	return { realtime: { cursor: { lastEventId, reconnectToken }, errors, proven }, yields }
}
const TOK: Setup = { auth: { kind: "bearer", token: "tok" } }
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const JSON_POST = { body: { contentType: "application/json", json: { hi: 1 } }, method: "POST", url: FEED_URL }
/** call 0's trace, and its error as `[type, status, via]` */
const call0 = ({ run }: Drove) => run.trace?.calls[0]
const failure = (drove: Drove) => ((e) => e && [e.type, e.status, e.via])(call0(drove)?.error)

/** A consumer's view of a `recv`: none, the value's JSON (`READ_1` for `frame(1)`), or the error's type and text. */
const READ_1 = '{"n": 1, "reconnect_token": "rt-1"}'
const READ = `async def read(rc):
    try:
        value = await rc.recv()
    except Exception as e:
        return f"err {type(e).__name__}: {e}"
    return "none" if value is None else f"ok {json.dumps(value, sort_keys=True)}"
`
/** A consumer program with READ against a server answering `replies`: its run and every hop's URL. */
const consumed = (name: string, replies: readonly Reply[], body: string) =>
	served(replies, async (server) => {
		const run = await consume("realtime", name, { base: server.url, body: `${READ}\n${body}` })
		return { hops: server.hops.map((hop) => hop.url), run }
	})

/** Each method's await typed by its event schema, a declared resume param folded into the stream fields. */
const SURFACE = `from typing import Any
import honey_sdk as sdk
async def main(a: sdk.AsyncSDK) -> None:
    rc: sdk.ResumableConnection[sdk.Payload] = await a.feed.live(channel="c")
    first: sdk.Payload | None = await rc.recv()
    r: sdk.ResumableConnection[Any] = await a.feed.resume(protocols2="p", last_event_id="5", reconnect_token="rt")
    sdk.SDK().feed
    await a.feed.resume(reconnect_token2="rt")
`

describe.skipIf(!PY)("a realtime method is AsyncSDK's, its await opening the connection (G2, Fd4)", SLOW, () => {
	// v0: 168848ab13
	it("returns the ResumableConnection already connected, typed by the event schema; SDK has none", async () => {
		const body = `a = aclient()
note([hasattr(a, "feed"), callable(getattr(a.feed, "live", None)), hasattr(client(), "feed")])
rc = await a.feed.live(channel="c")
note([type(rc).__name__, str(rc.state)])
await rc.close()
note(str(rc.state))`
		const { hops, run } = await consumed("opened", [refused, sse([ev(1)], "hold")], body)
		expect({ hops: hops.length, out: run.out?.main }, run.stderr).toEqual({
			hops: 2,
			out: ["[true, true, false]", '["ResumableConnection", "connected"]', "disconnected"],
		})
		/* the declared resume params fold into the stream fields: v0 emitted reconnect_token2 beside them */
		expect(checked("realtime", SURFACE)).toEqual([
			expect.stringMatching(/"SDK" has no attribute "feed"/),
			expect.stringMatching(/Unexpected keyword argument "reconnect_token2" for "resume"/),
		])
	})

	it("dials before it returns: a cancel before the call dials nothing, one during the dial ends it", async () => {
		const canceled = await drive([], [live({ take: 1 })], { script: { calls: [{ cancel: "before" }] } })
		const late = await drive([{ ...refused, delayMs: 2000 }], [live({ take: 1 })], {
			script: { calls: [{ cancel: { afterMs: 150 } }] },
		})
		const seen = [canceled, late].map((drove) => {
			const c = call0(drove)
			return [drove.run.observed, failure(drove), c?.stream, drove.hops.length, (c?.elapsedMs ?? 1e9) < 1000]
		})
		expect(seen, canceled.run.stderr + late.run.stderr).toEqual([
			[[null], ["CanceledError", undefined, "return"], undefined, 0, true],
			[[null], ["CanceledError", undefined, "return"], undefined, 1, true],
		])
		expect(late.hops[0]?.headers.upgrade).toBe("websocket")
	})

	it("ends an open connection quietly on a later cancel: the frames so far, no error, no reconnect", async () => {
		/* Fd4: the connection holds the call's cancel and races every read, a reconnect's included */
		const held = sse([ev(1), { waitMs: 2000 }, ev(2)], "hold")
		const drove = await drive([refused, held], [live({ take: 2 })], {
			script: { calls: [{ cancel: { afterMs: 300 }, realtime: { reconnectDelayMs: 10 } }] },
		})
		const seen = [failure(drove), drove.hops.length, drove.run.observed, call0(drove)?.stream]
		expect(seen, drove.run.stderr).toEqual([undefined, 2, frames(frame(1)), settled(1, "1 rt-1", "sse")])
		expect(call0(drove)?.elapsedMs).toBeLessThan(1500)
	})
})

describe.skipIf(!PY)("the cursor advances past each delivered message; a reconnect reopens the chain", SLOW, () => {
	it("reconnects after a drop, the next upgrade and event stream carrying the last id and token", async () => {
		/* V0BUG: v0 redialed with the frozen self._opts (_realtime.py:53,94), so the SSE id and token never
		 * advanced (survey 1). HEAD reopened the proven transport first and sent reconnect_token first */
		const replies = [refused, sse([ev(1), ev(2)], "drop"), refused, sse([ev(3)], "hold")]
		const drove = await drive(replies, [live({ take: 3 })], { script: QUICK })
		const resumed = "/feed?channel=c&last_event_id=2&reconnect_token=rt-2 -"
		expect([drove.run.observed, call0(drove)?.stream, drove.hops.map(wire)], drove.run.stderr).toEqual([
			frames(frame(1), frame(2), frame(3)),
			settled(3, "3 rt-3", "sse"),
			[BARE, BARE, resumed, "/feed?channel=c&reconnect_token=rt-2 2"],
		])
	})

	it("opens with the caller's cursor on each transport's wire, and with none when it is unset or empty", async () => {
		const runs = []
		for (const given of [{ lastEventId: "0", reconnectToken: "rt-0" }, {}, { lastEventId: "", reconnectToken: "" }])
			runs.push(await drive([refused, sse([ev(1)], "hold")], [live({ ...given, take: 1 })], { script: QUICK }))
		const opened = ["/feed?channel=c&last_event_id=0&reconnect_token=rt-0 -", "/feed?channel=c&reconnect_token=rt-0 0"]
		expect(
			runs.map(({ hops, run }) => [run.observed, hops.map(wire)]),
			runs.map(({ run }) => run.stderr).join("\n"),
		).toEqual([opened, [BARE, BARE], [BARE, BARE]].map((hops) => [frames(frame(1)), hops]))
	})
})

describe.skipIf(!PY)("the long-poll fallback advances its own cursor and polls once per read", SLOW, () => {
	it("falls back past a refused upgrade and event stream, each poll carrying the cursor before it", async () => {
		/* V0BUG: v0's LongpollAdapter.connect rebuilt each conn's cursor from the frozen opts
		 * (_transport.py:347-353; survey 2). The cursor goes last_event_id first, as Go and Rust send it */
		const drove = await drive(POLLED, [live({ take: 2 })], { script: QUICK })
		expect([drove.run.observed, call0(drove)?.stream], drove.run.stderr).toEqual([
			frames(polledFrame(1, "7"), polledFrame(2, "8")),
			settled(2, "8 rt-8", "longpoll"),
		])
		/* the hop URL, not the cursor: a conn that never advances its own still reports the connection's */
		expect(drove.hops.map((hop) => `${hop.method} ${dialOf(hop)} ${hop.url}`)).toEqual([
			`GET upgrade ${FEED_URL}`,
			`GET sse ${FEED_URL}`,
			`GET poll ${FEED_URL}`,
			"GET poll /feed?channel=c&last_event_id=7&reconnect_token=rt-7",
		])
	})

	it("delivers one message per answer, a JSON array as one, and polls no further ahead than the reader", async () => {
		const replies = [refused, unavailable, { json: [{ n: 1 }, { n: 2 }], status: 200 }, { json: { n: 3 }, status: 200 }]
		const { hops, run } = await drive(replies, [{ ...RESUME, take: 2 }], { script: QUICK })
		expect([run.observed, hops.map((hop) => hop.url)], run.stderr).toEqual([
			frames([{ n: 1 }, { n: 2 }], { n: 3 }),
			Array.from({ length: 4 }, () => "/resume"),
		])
	})
})

describe.skipIf(!PY)("a reconnect backs off from an SSE retry, else the delay (0 honored), else 1000 ms", SLOW, () => {
	it("waits at least half the base before the first reconnect: retry 2000, delay 10, the default; 0 none", async () => {
		/* the first backoff is jittered into the upper half of its base: 2000 → [1000, 2000], 10 → [5, 10], the
		 * default 1000 → [500, 1000], 0 → 0. HEAD's `reconnect_delay_ms or 1000` turned 0 into the default */
		const hinted = [refused, sse([`retry: 2000\n${ev(1)}`], "drop"), refused, sse([ev(2)], "hold")]
		const runs = [
			await drive(hinted, [live({ take: 2 })], { script: QUICK }),
			await drive(RECONNECTING, [live({ take: 2 })], { script: QUICK }),
			await drive(RECONNECTING, [live({ take: 2 })]),
			await drive(RECONNECTING, [live({ take: 2 })], { script: budget({ reconnectDelayMs: 0 }) }),
		]
		const ms = runs.map((drove) => call0(drove)?.elapsedMs ?? Number.NaN)
		expect(
			runs.map(({ hops, run }) => [run.observed, hops.length]),
			runs.map(({ run }) => run.stderr).join("\n"),
		).toEqual(Array.from({ length: 4 }, () => [frames(frame(1), frame(2)), 4]))
		const timing = { hinted: ms[0]! >= 1000, quick: ms[1]! < 1000, unset: ms[2]! >= 500, zero: ms[3]! < 400 }
		expect(timing, ms.join(" ")).toEqual({ hinted: true, quick: true, unset: true, zero: true })
		expect(Math.max(ms[0]!, ms[2]!)).toBeLessThan(5000)
	})
})

describe.skipIf(!PY)("a realtime connection gives up with the real error once, then None (Fd9)", SLOW, () => {
	it("reconnects after a clean end, keeps the cursor on every attempt, and gives up after the max", async () => {
		/* each attempt runs the whole chain: upgrade, event stream, then a poll answered 500 */
		const down: Reply = { json: { message: "down" }, status: 500 }
		const replies = [refused, sse([ev(1)], "close"), refused, refused, down, refused, refused, down]
		const drove = await drive(replies, [live({ take: 2 })], {
			script: budget({ maxReconnectAttempts: 2, reconnectDelayMs: 1 }),
		})
		const attempt = [`${AT_1} -`, "/feed?channel=c&reconnect_token=rt-1 1", `${AT_1} -`]
		expect([failure(drove), drove.run.observed, call0(drove)?.stream, drove.hops.map(wire)], drove.run.stderr).toEqual([
			["InternalServerError", 500, "stream"],
			frames(frame(1)),
			settled(1, "1 rt-1", null, ["HTTP 500: down"]),
			[BARE, BARE, ...attempt, ...attempt],
		])
	})

	it("is connected, reconnecting or disconnected; a budget of 0 never reconnects and raises once", async () => {
		/* Fd9: no connecting state, and 0 means no reconnect. A long-poll connect does not dial, so the 400 is
		 * the first recv's. A recv timed out mid-reconnect leaves it reconnecting: the upgrade is held past it */
		const body = `section("no-reconnect")
rc = await aclient().feed.live(channel="c", max_reconnect_attempts=0, reconnect_delay_ms=1)
note(str(rc.state))
note(await read(rc))
note(f"{rc.state} {await read(rc)} {await read(rc)}")
section("reconnecting")
rc = await aclient().feed.live(channel="c", reconnect_delay_ms=1)
note(f"{rc.state} {await read(rc)}")
try:
    await asyncio.wait_for(rc.recv(), 0.5)
except TimeoutError:
    note(f"timed out {rc.state}")
await rc.close()
note(f"{rc.state} {await read(rc)}")`
		const replies = [refused, refused, bad, refused, sse([ev(1)], "drop"), { ...refused, delayMs: 3000 }]
		const { hops, run } = await consumed("states", replies, body)
		expect({ hops, out: run.out }, run.stderr).toEqual({
			hops: [...Array.from({ length: 5 }, () => FEED_URL), AT_1],
			out: {
				"no-reconnect": ["connected", "err BadRequestError: HTTP 400: bad", "disconnected none none"],
				reconnecting: [`connected ok ${READ_1}`, "timed out reconnecting", "disconnected none"],
			},
		})
	})
})

describe.skipIf(!PY)("a caller's adapter under the same loop: reset, give-up once, cancel (Fd3)", SLOW, () => {
	// v0: 31aba57f46
	it("over a caller's adapter: clean ends reconnect, the attempts reset, dead conns close, a cancel propagates", async () => {
		/* runtime_check.py:125-180 on Fd3's public shape. Without the reset, the third conn's end exhausts the
		 * budget before the failing connects run: "the connection ended" in place of the adapter's own error */
		const body = `class Conn:
    def __init__(self, items): self.items, self.closed = list(items), False
    async def recv(self): return sdk.TransportMessage(json.dumps(self.items.pop(0))) if self.items else None
    async def send(self, text): pass
    async def close(self): self.closed = True
class Adapter:
    def __init__(self, plan): self.plan, self.conns = list(plan), []
    def name(self): return "fake"
    def kind(self): return sdk.TransportKind.SSE
    async def connect(self, url, opts):
        if (step := self.plan.pop(0) if self.plan else "fail") == "fail": raise ConnectionError("down")
        self.conns.append(Conn(step))
        return self.conns[-1]
class Slow(Adapter):
    async def connect(self, url, opts): await asyncio.sleep(10)
section("give-up")
a = Adapter([[1], [2], [3], "fail", "fail"])
rc = sdk.ResumableConnection("http://t/rt", [a], sdk.TransportOpts(max_reconnect_attempts=2, reconnect_delay_ms=1))
await rc.connect()
note([await read(rc) for _ in range(5)])
note([str(rc.state), len(a.conns), all(c.closed for c in a.conns), a.plan])
section("cancel")
rc = sdk.ResumableConnection("http://t/rt", [Slow([]), fallback := Adapter([[1]])], sdk.TransportOpts())
task = asyncio.ensure_future(rc.connect())
await asyncio.sleep(0.01)
task.cancel()
try:
    await task
except asyncio.CancelledError:
    note([rc.state != sdk.ConnectionState.CONNECTED, len(fallback.conns)])`
		const run = await consume("realtime", "adapter", { body: `${READ}\n${body}` })
		expect(run.out, run.stderr).toEqual({
			cancel: ["[true, 0]"],
			"give-up": ['["ok 1", "ok 2", "ok 3", "err ConnectionError: down", "none"]', '["disconnected", 3, true, []]'],
		})
	})
})

describe.skipIf(!PY)("every dial carries the call's params, auth, headers and its own request id", SLOW, () => {
	// v0: 491f9f971d
	it("sends the bearer, the config headers and the call's params on every upgrade, stream, poll and reconnect", async () => {
		const setup: Setup = { ...TOK, headers: { "X-Cfg": "1" } }
		const runs = []
		for (const replies of [RECONNECTING, POLLED]) {
			const call = live({ headers: { "x-tenant": "acme" }, take: 2 })
			const { hops, run } = await drive(replies, [call], { script: QUICK, setup })
			const sent = hops.map(({ headers: h, url }) => [
				url.startsWith(FEED_URL),
				h["x-tenant"],
				h.authorization,
				h["x-cfg"],
			])
			runs.push([(run.observed?.[0] as { frames?: unknown[] } | null)?.frames?.length, sent])
		}
		const want = [2, Array.from({ length: 4 }, () => [true, "acme", "Bearer tok", "1"])]
		expect(runs).toEqual([want, want])
	})

	// v0: 2dcd20ea6e
	it("gives each dial a fresh X-Request-Id, the config's kept on each; a refused chain raises the typed status", async () => {
		/* V0BUG: v0 set x-request-id on its SSE dial alone (_transport.py:221-265), and its SseAdapter raised a
		 * raw httpx.HTTPStatusError under a hard-coded 30 s timeout (survey 7) */
		const runs = []
		for (const replies of [RECONNECTING, POLLED])
			for (const setup of [{}, { headers: { "X-Request-Id": "fixed" } }]) {
				const { hops } = await drive(replies, [live({ take: 2 })], { script: QUICK, setup })
				const ids = hops.map((hop) => hop.headers["x-request-id"])
				runs.push([new Set(ids).size, ids])
			}
		const fresh = [4, Array.from({ length: 4 }, () => expect.stringMatching(UUID4))]
		const kept = [1, Array.from({ length: 4 }, () => "fixed")]
		expect(runs).toEqual([fresh, kept, fresh, kept])
		const drove = await drive([refused, unavailable, bad], [live({ take: 1 })], {
			script: budget({ maxReconnectAttempts: 0 }),
		})
		const seen = [failure(drove), call0(drove)?.stream?.realtime?.errors, drove.hops.length]
		expect(seen, drove.run.stderr).toEqual([["BadRequestError", 400, "stream"], ["HTTP 400: bad"], 3])
	})
})

describe.skipIf(!PY)("the SSE and long-poll dials ride the shared exchange; the WebSocket dial no hook", SLOW, () => {
	it("carries a refresh to the next upgrade, the hooks seeing the cursor sent and the operation's path (Fd5)", async () => {
		/* each stream dial gets the hooks, the log and the 401 refresh; the WebSocket dial reads the current
		 * token and runs no hook and no log. HEAD's dials bypassed the exchange: no refresh, no log, no
		 * on_response, and hooks that saw the URL without its cursor (on the WebSocket dial too) */
		const expired: Reply = { json: { message: "expired" }, status: 401 }
		const replies = [refused, sse([ev(1)], "drop"), refused, expired, sse([ev(2)], "drop"), refused]
		replies.push(sse([ev(3)], "hold"))
		const script: Script = { ...QUICK, log: true, onAuthExpired: { tokens: ["new"] } }
		const setup: Setup = { auth: { kind: "bearer", token: "old" } }
		const { base, hops, run } = await drive(replies, [live({ take: 3 })], { script, setup })
		const hooks = run.trace?.hooks ?? []
		const at = (url: string | undefined) => (url?.startsWith(base) ? url.slice(base.length) : url)
		const [first, second] = [`${FEED_URL}&reconnect_token=rt-1`, `${FEED_URL}&reconnect_token=rt-2`]
		const exchanged = ["request_start", "response_received 200"]
		expect(
			{
				answered: hooks.filter((h) => h.phase === "response").map((h) => `${h.status} ${h.isRetry}`),
				authExpired: run.trace?.authExpired,
				hooked: hooks.filter((h) => h.phase === "request").map((h) => `${at(h.url)} ${h.path} ${h.isRetry}`),
				log: run.trace?.log.map((e) => [e.event, e.status].filter((v) => v !== undefined).join(" ")),
				observed: run.observed,
			},
			run.stderr,
		).toEqual({
			answered: ["200 false", "401 false", "200 true", "200 false"],
			authExpired: 1,
			hooked: [`${FEED_URL} /feed false`, `${first} /feed false`, `${first} /feed true`, `${second} /feed false`],
			log: [...exchanged, ...exchanged, ...exchanged],
			observed: frames(frame(1), frame(2), frame(3)),
		})
		const dials = hops.map((hop) => `${hop.headers.upgrade ?? "sse"} ${hop.headers.authorization?.slice(7)}`)
		expect(dials.join(", ")).toBe("websocket old, sse old, websocket old, sse old, sse new, websocket new, sse new")
	})

	it("follows a same-origin redirect on the event-stream dial, and caps a poll's answer at max_response_bytes", async () => {
		const moved: Reply = { redirect: { origin: "primary", path: "/moved?channel=c" }, status: 307 }
		const followed = await drive([refused, moved, sse([ev(1)], "hold")], [live({ take: 1 })], { script: QUICK })
		expect([followed.run.observed, followed.hops.map((hop) => hop.url)], followed.run.stderr).toEqual([
			frames(frame(1)),
			[FEED_URL, FEED_URL, "/moved?channel=c"],
		])
		const big: Reply = { json: { n: 1, pad: "x".repeat(100) }, status: 200 }
		const script: Script = { ...budget({ maxReconnectAttempts: 0 }), config: { maxResponseBytes: 64 } }
		const capped = await drive([refused, unavailable, big], [live({ take: 1 })], { script })
		const seen = [capped.run.observed, failure(capped), call0(capped)?.stream?.realtime?.errors]
		expect(seen, capped.run.stderr).toEqual([
			frames(),
			["APIConnectionError", undefined, "stream"],
			["the answer exceeds 64 bytes"],
		])
	})
})

describe.skipIf(!PY)("a message's kind checked against the event schema; send POSTs compact JSON", SLOW, () => {
	it("raises DecodeError for a message of another JSON kind, the cursor advanced and the connection kept", async () => {
		/* Fd5, as Rust's deliver: the attempts reset and the cursor moves before the kind is checked */
		const body = `rc = await aclient().feed.live(channel="c", reconnect_delay_ms=1)
note([await read(rc), await read(rc), str(rc.state), rc.opts.last_event_id])
await rc.close()`
		const { hops, run } = await consumed("kind", [refused, sse([`id: 1\ndata: 5\n\n`, ev(2)], "hold")], body)
		const read2 = 'ok {\\"n\\": 2, \\"reconnect_token\\": \\"rt-2\\"}'
		expect({ hops: hops.length, out: run.out?.main }, run.stderr).toEqual({
			hops: 2,
			out: [`["err DecodeError: a message is not a JSON object", "${read2}", "connected", "2"]`],
		})
	})

	it("POSTs on a long-poll connection with the call's params, the bearer and compact JSON, then polls", async () => {
		const replies = [refused, unavailable, { json: {}, status: 200 }, polled(1, "7")]
		const call = live({ headers: { "x-tenant": "acme" }, send: ['{"hi":1}'], take: 1 })
		const drove = await drive(replies, [call], { script: QUICK, setup: TOK })
		expect([failure(drove), drove.run.observed], drove.run.stderr).toEqual([undefined, frames(polledFrame(1, "7"))])
		expect(drove.hops.slice(2)).toMatchObject([
			{ ...JSON_POST, headers: { authorization: "Bearer tok", "x-tenant": "acme" } },
			{ method: "GET", url: FEED_URL },
		])
		/* compact, like a request body: HEAD sent `{"hi": 1}` */
		expect(drove.bodies[2]?.toString()).toBe('{"hi":1}')
	})

	it("POSTs on an SSE connection; a POST answered 405 raises its status error, no frames", async () => {
		const replies = [refused, sse([ev(1)], "hold"), { json: { message: "no" }, status: 405 }]
		const drove = await drive(replies, [live({ send: ['{"hi":1}'], take: 1 })], { script: QUICK, setup: TOK })
		const e = call0(drove)?.error
		expect(drove.hops[2], drove.run.stderr).toMatchObject({ ...JSON_POST, headers: { authorization: "Bearer tok" } })
		const seen = [drove.run.observed, e?.chain.includes("APIStatusError"), e?.status, e?.via]
		expect(seen).toEqual([frames(), true, 405, "stream"])
	})
})

describe("the emitted realtime surface: the stream fields reserved, the event's kind on the Operation", () => {
	it("claims a declared max_reconnect_attempts or reconnect_delay_ms as …2, and pins a typed event's kind", () => {
		/* Rust and Go claim `…2`; HEAD emitted the name twice, a duplicate argument (a SyntaxError). Fd5: the
		 * typed event's JSON kind rides its Operation, an untyped one's none */
		const client = generatePythonSdk(FIXTURES.realtime.document()).files["src/honey_sdk/client.py"] ?? ""
		const flat = client.replace(/\s+/g, "").replaceAll(",)", ")")
		const claimed = { max_reconnect_attempts: "max_reconnect_attempts2", reconnect_delay_ms: "reconnect_delay_ms2" }
		const typed = 'Operation[Payload]=Operation("GET","/feed",answer="none",shape="object",stream="realtime")'
		const untyped = 'Operation[Any]=Operation("GET","/resume",answer="none",stream="realtime")'
		const clash = pythonCallPlans(FIXTURES.fixtures.document())["realtime-clash.feed.live"]?.query
		const seen = [clash, flat.includes(typed), flat.includes(untyped)]
		expect(seen).toEqual([{ channel: "channel", ...claimed }, true, true])
	})
})

describe.skipIf(!PY)("the emitted realtime package with a claimed field compiles and sends it", SLOW, () => {
	it("imports under the gate, and sends the …2 params by their wire names beside a budget of 0", async () => {
		/* documents.ts's Python-only `realtime-clash` path in the merged `fixtures` registry document (G17) */
		const sdk = compiledPython("fixtures")
		expect(sdk.imported, sdk.stderr).toBe(true)
		const body = `${READ}
rc = await aclient().realtime_clash.feed.live(channel="c", max_reconnect_attempts2=3, reconnect_delay_ms2=4, max_reconnect_attempts=0)
note([await read(rc), await read(rc)])`
		const { hops, ran } = await served([refused, refused, bad], async (server) => {
			const done = await sdk.exec(program(sdk.package, "clash", body), JSON.stringify({ base: server.url }))
			return { hops: server.hops.map((hop) => hop.url), ran: done }
		})
		expect([hops, ran.status === 0 ? JSON.parse(ran.stdout) : undefined], ran.stderr).toEqual([
			Array.from({ length: 3 }, () => "/realtime-clash/feed?channel=c&max_reconnect_attempts=3&reconnect_delay_ms=4"),
			{ main: ['["err BadRequestError: HTTP 400: bad", "none"]'] },
		])
	})
})
