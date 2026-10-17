/**
 * Realtime transports (contract 34 §6.6, Fd3; Rust's `realtime.transports.test.ts` analog): the public
 * `TransportAdapter` protocol (`name()`, `kind()`, `connect(url, opts)`), `TransportOpts`, `TransportKind` and
 * `ConnectionState`; an `AsyncSDK` realtime call's default chain (WebSocket, then SSE, then long-poll) as
 * `conn.adapters`, a custom chain of them in the caller's order, and the real answer each opened with in
 * `options["raw"]`; the SSE and long-poll adapters on their own, dialing through the call's exchange (hooks see
 * the operation's path and the URL sent), the long-poll wire as Go's and Rust's (one cursor pair, `last_event_id`
 * first; one message per answer; a 204 polling again; no poll ahead of the reader; 60 s per poll whatever the
 * client's timeout), a send POSTing the JSON with a 405 its error; and `ResumableConnection(url, adapters, opts)`
 * over a caller's in-process adapters: a skipped refusal, one custom adapter, a drop resumed through the next
 * adapter with the advanced cursor, clean ends reconnecting, a give-up raising the last failure once and then
 * `None`, a cancel-safe `recv`, and a concurrent `close()`. Consumers on `realtime`: `transports` (in process; its
 * server sees nothing) and one `adapters-<section>` per server-backed section, each on its own recording server.
 * Every section runs guarded: a raising one notes `raised <Type>: <text>`, and the program goes on.
 */
import { describe, expect, it } from "vitest"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume, once, type Run } from "./__fixtures__/consumer.ts"
import { withPython } from "./__fixtures__/python-env.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 }

/**
 * A caller's in-process adapter. `Conn` delivers its texts, then `then`: "hold" until closed (its `recv` then
 * answers `None`, as a closed transport does), "fail" (a `ConnectionResetError`) or "end" (`None`, a clean end);
 * `Fake` opens its conns in order after each one's `delay`, `None` or one past the end refusing with
 * `ConnectionRefusedError("refused")`, and records each connect's cursor as `<last_event_id>/<reconnect_token>`
 * and the connection's state then (`rc`, once set). `take` reads n values within 5 s each; `cursor` is the
 * connection's cursor, proven transport and state. `guarded` runs a section, noting what it raised.
 */
const DECLS = `class Conn:
    def __init__(self, texts, then="hold", delay=0.0):
        self.texts, self.then, self.delay = list(texts), then, delay
        self.sent, self.closed, self.gone = [], False, asyncio.Event()
    async def recv(self):
        if self.texts:
            return sdk.TransportMessage(self.texts.pop(0))
        if self.then == "fail":
            raise ConnectionResetError("reset")
        if self.then == "hold":
            await self.gone.wait()
        return None
    async def send(self, text):
        self.sent.append(text)
    async def close(self):
        self.closed = True
        self.gone.set()

class Fake:
    def __init__(self, kind, conns):
        self.k, self.conns, self.got, self.states, self.rc = kind, list(conns), [], [], None
    def name(self):
        return "fake"
    def kind(self):
        return self.k
    async def connect(self, url, opts):
        self.got.append(f"{opts.last_event_id or ''}/{opts.reconnect_token or ''}")
        self.states.append(str(self.rc.state) if self.rc else "")
        conn = self.conns.pop(0) if self.conns else None
        if conn is None:
            raise ConnectionRefusedError("refused")
        await asyncio.sleep(conn.delay)
        return conn

async def take(rc, n):
    out = []
    for _ in range(n):
        try:
            out.append(await asyncio.wait_for(rc.recv(), 5))
        except TimeoutError:
            out.append("stalled")
        except Exception as e:
            out.append(failed(e))
    return out

def cursor(rc):
    return f"{rc.opts.last_event_id or ''}/{rc.opts.reconnect_token or ''} {rc.proven_transport} {rc.state}"

def failed(e):
    return f"{type(e).__name__}: {e}"

hooked = []
def hook(ctx):
    hooked.append([ctx.url.removeprefix(BASE), ctx.path])

async def guarded(name, body):
    section(name)
    try:
        await body()
    except Exception as e:
        note(f"raised {failed(e)}")`

/** `text`, each line indented one level. */
const indent = (text: string) =>
	text
		.split("\n")
		.map((line) => (line === "" ? "" : `    ${line}`))
		.join("\n")

/** The consumer body running each of `sections` guarded, in order, after DECLS. */
function body(sections: Readonly<Record<string, string>>): string {
	const runs = Object.entries(sections).map(
		([name, text], i) =>
			`async def section_${i}():\n${indent(text)}\n\nawait guarded(${JSON.stringify(name)}, section_${i})`,
	)
	return [DECLS, ...runs].join("\n\n")
}

/** The in-process sections: none of them sends a request. */
const IN_PROCESS: Readonly<Record<string, string>> = {
	chain: `o = sdk.TransportOpts()
note([o.last_event_id, o.reconnect_token, o.protocols, o.max_reconnect_attempts, o.reconnect_delay_ms])
c = sdk.TransportOpts(reconnect_token="tok", last_event_id="42", max_reconnect_attempts=3, reconnect_delay_ms=500)
note([c.last_event_id, c.reconnect_token, c.protocols, c.max_reconnect_attempts, c.reconnect_delay_ms])
note(sorted(k.value for k in sdk.TransportKind))
note([isinstance(Fake(sdk.TransportKind.WS, []), sdk.TransportAdapter), isinstance(object(), sdk.TransportAdapter)])`,
	states: `note([s.value for s in sdk.ConnectionState])
bad = Fake(sdk.TransportKind.WS, [None])
good = Fake(sdk.TransportKind.SSE, [Conn(['{"seq":1}', '{"seq":2}'])])
rc = sdk.ResumableConnection(f"{BASE}/feed", [bad, good])
before = str(rc.state)
await rc.connect()
note([before, str(rc.state), str(rc.proven_transport), len(bad.got), len(good.got)])
note(await take(rc, 2))
await rc.close()
note([str(rc.state), await rc.recv()])`,
	custom: `one = Fake(sdk.TransportKind.WS, [Conn(['{"kind":"custom","seq":1}', '{"kind":"custom","seq":2}'])])
rc = sdk.ResumableConnection(f"{BASE}/feed", [one])
await rc.connect()
note(await take(rc, 2))
note([one.got, str(rc.proven_transport), str(rc.state)])
await rc.close()
note([str(rc.state)])`,
	resume: `ids = [f'{{"id":"{i}","reconnect_token":"rt-{i}"}}' for i in (1, 2, 3)]
flaky = Fake(sdk.TransportKind.WS, [Conn(ids[:2], "fail"), None])
stable = Fake(sdk.TransportKind.SSE, [Conn(ids[2:])])
opts = sdk.TransportOpts(last_event_id="0", reconnect_token="rt-0", reconnect_delay_ms=10)
rc = sdk.ResumableConnection("http://rt.test/feed", [flaky, stable], opts)
flaky.rc = stable.rc = rc
await rc.connect()
note(await take(rc, 3))
note([flaky.got, stable.got, cursor(rc)])
note([flaky.states[1:], stable.states])
await rc.close()`,
	plan: `conns = [Conn([str(n)], "end") for n in (1, 2, 3)]
plan = Fake(sdk.TransportKind.WS, [*conns, None, None])
opts = sdk.TransportOpts(max_reconnect_attempts=2, reconnect_delay_ms=1)
rc = sdk.ResumableConnection("http://rt.test/feed", [plan], opts)
await rc.connect()
note(await take(rc, 5))
note([len(plan.got), [c.closed for c in conns], str(rc.state)])
late = sdk.ResumableConnection("http://rt.test/feed", [Fake(sdk.TransportKind.WS, [Conn([], delay=10.0)])])
task = asyncio.ensure_future(late.connect())
await asyncio.sleep(0.01)
task.cancel()
try:
    await task
    note(["opened"])
except asyncio.CancelledError:
    note(["cancelled", late.state != sdk.ConnectionState.CONNECTED])`,
	session: `conn = Conn(['{"n":1}'])
rc = sdk.ResumableConnection("http://rt.test/feed", [Fake(sdk.TransportKind.WS, [conn])])
await rc.connect()
note([str(rc.state), str(rc.proven_transport)])
await rc.send({"hi": 1, "é": "ü"})
await rc.send("as is")
note(conn.sent)
note(await take(rc, 1))
await rc.close()
note([str(rc.state), await rc.recv(), conn.closed])
try:
    await rc.send({"hi": 2})
    note(["sent"])
except Exception as e:
    note([failed(e)])`,
	"give-up": `failing = Fake(sdk.TransportKind.WS, [Conn([], "fail")])
opts = sdk.TransportOpts(max_reconnect_attempts=3, reconnect_delay_ms=1)
rc = sdk.ResumableConnection("http://rt.test/feed", [failing], opts)
await rc.connect()
note(await take(rc, 3))
note([failing.got, str(rc.state), rc.proven_transport is None])
try:
    await rc.send(1)
    note(["sent"])
except Exception as e:
    note([failed(e)])`,
	"cancel-safe": `dying = Fake(sdk.TransportKind.WS, [Conn([], "fail"), Conn(['{"ok":true}'], delay=0.5), Conn(['{"ok":true}'], delay=0.5)])
rc = sdk.ResumableConnection("http://rt.test/feed", [dying], sdk.TransportOpts(reconnect_delay_ms=10))
await rc.connect()
try:
    await asyncio.wait_for(rc.recv(), 0.1)
    note(["delivered"])
except TimeoutError:
    note(["dropped", str(rc.state)])
note(await take(rc, 1))
note([str(rc.state), len(dying.got)])`,
	"close-race": `held = Fake(sdk.TransportKind.WS, [Conn([])])
rc = sdk.ResumableConnection("http://rt.test/feed", [held])
await rc.connect()
task = asyncio.ensure_future(rc.recv())
await asyncio.sleep(0.05)
await rc.close()
try:
    note([await asyncio.wait_for(task, 2), str(rc.state), len(held.got)])
except TimeoutError:
    note(["stalled", str(rc.state), len(held.got)])`,
}

/** Consumer `transports`, built and run once against a server it never dials: its run and the hops it saw. */
const transports = once(() =>
	served([], async (server) => {
		const run = await consume("realtime", "transports", { base: server.url, body: body(IN_PROCESS) })
		return { hops: server.hops.length, run }
	}),
)

const refused: Reply = { json: { message: "no" }, status: 404 }
const held = (steps: readonly string[]): Reply => ({ sse: { end: "hold", steps }, status: 200 })
const upgraded: Reply = { status: 101, ws: { steps: [] } }
const posted: Reply = { json: {}, status: 200 }
const unposted: Reply = { json: { message: "no" }, status: 405 }
const unavailable: Reply = { status: 503, text: "" }
const bad: Reply = { json: { message: "no" }, status: 400 }
/** A call refused over WebSocket and SSE opens over long-poll, which dials nothing: its adapters, two hops in. */
const SETUP = `async with await c.feed.live(channel="c") as setup:
    adapters = setup.adapters`
const SENDS = `for data in ({"hi": 1}, {"hi": 2}):
    try:
        await rc.send(data)
        note(["sent"])
    except Exception as e:
        note([failed(e), str(rc.state)])`

/** The server-backed sections: each one's replies, and its body, run against its own server. */
const ADAPTERS: Readonly<Record<string, { readonly body: string; readonly replies: readonly Reply[] }>> = {
	names: {
		body: `c = aclient(bearer_token="tok")
async with await c.feed.live(channel="c") as conn:
    note([[a.name(), a.kind().value, isinstance(a, sdk.TransportAdapter)] for a in conn.adapters])`,
		replies: [upgraded],
	},
	defaults: {
		body: `c = aclient(bearer_token="tok")
async with await c.feed.live(channel="c") as first:
    note(str(first.proven_transport))
    a = first.adapters
    async with sdk.ResumableConnection(first.url, [a[1], a[0], a[2]]) as custom:
        await custom.connect()
        note(str(custom.proven_transport))
for _ in range(2):
    async with await c.feed.live(channel="c") as conn:
        note(str(conn.proven_transport))`,
		replies: [upgraded, held([]), refused, held([]), refused, unavailable],
	},
	raw: {
		body: `c = aclient(bearer_token="tok", on_request=[hook])
host = BASE.split("://", 1)[1]
for _ in range(3):
    raw = sdk.RawResponse()
    async with await c.feed.live(channel="c", options={"raw": raw}) as conn:
        note([raw.status, raw.url.replace(host, "H")])
        note(str(conn.proven_transport))
note(hooked)`,
		replies: [upgraded, refused, held([]), refused, unavailable],
	},
	sse: {
		body: `c = aclient(bearer_token="tok", on_request=[hook])
${SETUP}
async with sdk.ResumableConnection(setup.url, [adapters[1]]) as rc:
    await rc.connect()
    note(await take(rc, 1))
${indent(SENDS)}
note(hooked)`,
		replies: [refused, refused, held(['data: {"n":1}\n\n']), posted, unposted],
	},
	longpoll: {
		body: `c = aclient(bearer_token="tok", timeout=0.2, on_request=[hook])
${SETUP}
async with sdk.ResumableConnection(setup.url, [adapters[2]], sdk.TransportOpts(max_reconnect_attempts=0)) as rc:
    await rc.connect()
    note(await take(rc, 2))
${indent(SENDS)}
    note(await take(rc, 1))
note(hooked)`,
		replies: [
			refused,
			refused,
			{ json: { id: "7", n: 2, reconnect_token: "rt-7" }, status: 200 },
			{ status: 204 },
			{ json: [{ n: 3 }, { n: 4 }], status: 200 },
			posted,
			unposted,
			{ delayMs: 1000, json: { n: 5 }, status: 200 },
		],
	},
	refused: {
		body: `c = aclient(bearer_token="tok")
${SETUP}
async with sdk.ResumableConnection(setup.url, [adapters[2]], sdk.TransportOpts(max_reconnect_attempts=0)) as rc:
    await rc.connect()
    note(await take(rc, 2))
try:
    await sdk.ResumableConnection(setup.url, [adapters[1]]).connect()
    note(["opened"])
except Exception as e:
    note([failed(e)])`,
		replies: [refused, refused, bad, bad],
	},
}

const adapterRuns = new Map<string, () => Promise<{ hops: readonly RecordedHop[]; run: Run }>>()
/** Section `name` of ADAPTERS, run once against its own server answering its replies: its run and every hop. */
function adapterRun(name: string) {
	const { body: text, replies } = ADAPTERS[name] ?? { body: "", replies: [] }
	const run =
		adapterRuns.get(name) ??
		once(() =>
			served(replies, async (server) => {
				const ran = await consume("realtime", `adapters-${name}`, { base: server.url, body: body({ [name]: text }) })
				return { hops: [...server.hops], run: ran }
			}),
		)
	adapterRuns.set(name, run)
	return run()
}

/** A note as the test reads it: its JSON value, else the text. */
function read(line: string): unknown {
	try {
		return JSON.parse(line) as unknown
	} catch {
		return line
	}
}

/** Section `name` of `run`: whether the program ran to its end, and the section's notes. */
const notesOf = (run: Run, name: string) => ({ notes: run.out?.[name]?.map(read), ran: run.ran })

/** Section `name` of the `transports` run as `expect`'s two arguments: whether it ran with its notes, and its stderr. */
async function inProcess(name: string): Promise<readonly [unknown, string]> {
	const { run } = await transports()
	return [notesOf(run, name), run.stderr]
}

/** What a section must have answered: it ran to its end with `notes`. */
const ran = (notes: readonly unknown[]) => ({ notes, ran: true })

/** A hop as `METHOD url kind`: an upgrade, an event-stream open, a poll, or a POST's JSON body. */
function dial(hop: RecordedHop): string {
	if (hop.method === "POST") return `POST ${hop.url} ${hop.body.contentType} ${JSON.stringify(hop.body.json)}`
	const kind =
		hop.headers.upgrade === "websocket" ? "upgrade" : hop.headers.accept === "text/event-stream" ? "sse" : "poll"
	return `${hop.method} ${hop.url} ${kind}`
}

/** Section `name` of ADAPTERS as `expect`'s two arguments: whether it ran, its notes and its hops (as `dial` spells them), and its stderr. */
async function adapted(name: string): Promise<readonly [unknown, string]> {
	const { hops, run } = await adapterRun(name)
	return [{ ...notesOf(run, name), hops: hops.map(dial) }, run.stderr]
}

/** What a server-backed section must have answered: it ran to its end with `notes`, dialing `hops`. */
const dialed = (hops: readonly string[], notes: readonly unknown[]) => ({ hops, notes, ran: true })

/** What `on_request` saw for `hops`: each dial but the upgrades (no hook, Fd5), its URL as sent and the operation's path. */
const hookedOf = (hops: readonly string[]) =>
	hops.filter((hop) => !hop.endsWith(" upgrade")).map((hop) => [hop.split(" ")[1], "/feed"])

const BARE = "/feed?channel=c"
const CURSOR = `${BARE}&last_event_id=7&reconnect_token=rt-7`
const [UPGRADE, SSE, POLL] = [`GET ${BARE} upgrade`, `GET ${BARE} sse`, `GET ${BARE} poll`]
const POSTS = [1, 2].map((n) => `POST ${BARE} application/json {"hi":${n}}`)

describe.skipIf(!PY)("the TransportAdapter protocol and an AsyncSDK call's default chain", SLOW, () => {
	/* ruling: v0's TransportOpts.headers drops; headers come from ClientConfig, options and the declared params */
	// v0: 3f000b7eea
	it("ships TransportOpts with its defaults, TransportKind's three kinds, and a call's ws, sse and longpoll adapters, each a TransportAdapter", async () => {
		const opts = [
			[null, null, [], 5, 1000],
			["42", "tok", [], 3, 500],
		]
		expect(...(await inProcess("chain"))).toEqual(ran([...opts, ["longpoll", "sse", "ws"], [true, false]]))
		const adapters = ["ws", "sse", "longpoll"].map((kind) => [kind, kind, true])
		expect(...(await adapted("names"))).toEqual(dialed([UPGRADE], [adapters]))
	})

	/* the long-poll open sends nothing: its first poll waits for the first recv */
	it("opens a call over WebSocket, else SSE, else long-poll, and a custom chain of its adapters in the caller's order", async () => {
		const hops = [UPGRADE, SSE, UPGRADE, SSE, UPGRADE, SSE]
		expect(...(await adapted("defaults"))).toEqual(dialed(hops, ["ws", "sse", "sse", "longpoll"]))
	})

	/* Rust's opened (contract 34 §1): the answer the connection last opened with, never the endpoint's; the dial
	 * hooks run on the SSE dials only (Fd5), each seeing the operation's path and the URL it sent */
	it("fills options['raw'] with the real dialed answer: 101 and ws:// for WebSocket, 200 and http:// for SSE and long-poll", async () => {
		const hops = [UPGRADE, UPGRADE, SSE, UPGRADE, SSE]
		const opened = [
			[[101, `ws://H${BARE}`], "ws"],
			[[200, `http://H${BARE}`], "sse"],
			[[200, `http://H${BARE}`], "longpoll"],
		]
		expect(...(await adapted("raw"))).toEqual(dialed(hops, [...opened.flat(), hookedOf(hops)]))
	})
})

describe.skipIf(!PY)("a call's SSE and long-poll adapters on their own, sending by POSTing the JSON", SLOW, () => {
	it("receives over the SSE adapter through the call's exchange, a send POSTed with the client's auth and a 405 its error", async () => {
		const hops = [UPGRADE, SSE, SSE, ...POSTS]
		const sends = [["sent"], ["APIStatusError: HTTP 405: no", "connected"]]
		expect(...(await adapted("sse"))).toEqual(dialed(hops, [[{ n: 1 }], ...sends, hookedOf(hops)]))
		const auth = (await adapterRun("sse")).hops.map((hop) => [hop.headers.authorization, hop.headers["last-event-id"]])
		expect(auth).toEqual(hops.map(() => ["Bearer tok", undefined]))
	})

	/* Go's and Rust's wire (contract 34 §1): the conn polls with the connection's own advancing cursor, never a
	 * copy taken at connect (v0's reset cursor, _transport.py:347-353, survey 2); each poll is bounded at 60 s, so a
	 * 200 ms client timeout does not fail a poll the server answers after 1000 ms. Exactly one poll per message (a
	 * 204 polls again), none ahead of the reader */
	it("polls over the long-poll adapter with its advancing cursor, one message per answer, a 204 polling again, a poll bounded by 60 s", async () => {
		const polled = `GET ${CURSOR} poll`
		const hops = [UPGRADE, SSE, POLL, polled, polled, ...POSTS, polled]
		const messages = [{ id: "7", n: 2, reconnect_token: "rt-7" }, [{ n: 3 }, { n: 4 }]]
		const sends = [["sent"], ["APIStatusError: HTTP 405: no", "connected"]]
		expect(...(await adapted("longpoll"))).toEqual(dialed(hops, [messages, ...sends, [{ n: 5 }], hookedOf(hops)]))
		const auth = (await adapterRun("longpoll")).hops.map((hop) => hop.headers.authorization)
		expect(auth).toEqual(hops.map(() => "Bearer tok"))
	})

	it("surfaces a long-poll 400 from recv once, then None, and an SSE 400 from connect", async () => {
		const refusal = "BadRequestError: HTTP 400: no"
		expect(...(await adapted("refused"))).toEqual(dialed([UPGRADE, SSE, POLL, SSE], [[refusal, null], [refusal]]))
	})
})

describe.skipIf(!PY)("ResumableConnection over a caller's in-process adapters: the open and the resume", SLOW, () => {
	/* ruling Fd9: v0's fourth state, connecting, drops */
	// v0: ef01c9a891
	it("skips a refusing adapter: Disconnected, then Connected over the next one, proven SSE, two messages, then Disconnected", async () => {
		const opened = [
			["connected", "reconnecting", "disconnected"],
			["disconnected", "connected", "sse", 1, 1],
		]
		expect(...(await inProcess("states"))).toEqual(ran([...opened, [{ seq: 1 }, { seq: 2 }], ["disconnected", null]]))
	})

	// v0: 6b8d533ca8
	it("dials only the caller's one adapter: one connect, proven WebSocket, and the server behind the URL sees no request", async () => {
		const custom = [1, 2].map((seq) => ({ kind: "custom", seq }))
		expect(...(await inProcess("custom"))).toEqual(ran([custom, [["/"], "ws", "connected"], ["disconnected"]]))
		expect((await transports()).hops).toBe(0)
	})

	/* V0BUG (survey 1): v0 redialed with the frozen self._opts (_realtime.py:53,94), so the reconnect resumed from
	 * the caller's cursor; v0's harness counted the calls and never read the cursor a dial was handed */
	// v0: ccea4ca492
	it("reconnects after a mid-stream drop through the next adapter while Reconnecting, each dial handed the advanced cursor", async () => {
		const ids = [1, 2, 3].map((id) => ({ id: `${id}`, reconnect_token: `rt-${id}` }))
		const handed = [["0/rt-0", "2/rt-2"], ["2/rt-2"], "3/rt-3 sse connected"]
		expect(...(await inProcess("resume"))).toEqual(ran([ids, handed, [["reconnecting"], ["reconnecting"]]]))
	})

	/* v0's runtime_check 2c: each clean end reconnects and a delivery resets the attempts; v0's give-up after a
	 * clean end returned silently (N-GU); v1 raises the last failure once, then answers None */
	// v0: 31aba57f46
	it("reconnects after each clean end, then gives up with the real failure once, closing every dead conn; a cancelled connect propagates", async () => {
		const taken = [1, 2, 3, "ConnectionRefusedError: refused", null]
		expect(...(await inProcess("plan"))).toEqual(
			ran([taken, [5, [true, true, true], "disconnected"], ["cancelled", true]]),
		)
	})
})

describe.skipIf(!PY)("ResumableConnection over a caller's in-process adapters: a session and its end", SLOW, () => {
	it("drives one session: a send as compact JSON or text as is, a recv, a close to Disconnected, then None and a refused send", async () => {
		const sent = ['{"hi":1,"é":"ü"}', "as is"]
		const closed = [["disconnected", null, true], ["APIConnectionError: the connection is not open"]]
		expect(...(await inProcess("session"))).toEqual(ran([["connected", "ws"], sent, [{ n: 1 }], ...closed]))
	})

	it("gives up after max_reconnect_attempts: the last failure once, then None, Disconnected with no proven transport", async () => {
		const taken = ["ConnectionRefusedError: refused", null, null]
		const after = [[["/", "/", "/", "/"], "disconnected", true], ["APIConnectionError: the connection is not open"]]
		expect(...(await inProcess("give-up"))).toEqual(ran([taken, ...after]))
	})

	/* a 100 ms timeout cancels recv inside the reconnect's 500 ms dial; the next recv reconnects and delivers */
	it("keeps recv cancel-safe: a recv cancelled mid-reconnect leaves it Reconnecting, and the next recv delivers", async () => {
		expect(...(await inProcess("cancel-safe"))).toEqual(
			ran([["dropped", "reconnecting"], [{ ok: true }], ["connected", 3]]),
		)
	})

	/* v0's close did not end a blocked recv (N-CL) */
	it("ends a recv blocked in another task with None when close() runs: Disconnected, and no reconnect", async () => {
		expect(...(await inProcess("close-race"))).toEqual(ran([[null, "disconnected", 1]]))
	})
})
