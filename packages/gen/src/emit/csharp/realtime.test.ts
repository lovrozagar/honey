/**
 * A realtime operation in the C# SDK (contract 50 §5.6, Fd2, Fd3, Fd6, Fd7; Python's `realtime.test.ts` analog):
 * the method dials WebSocket, else SSE, else long-poll and returns `ResumableConnection<T>` connected (`JsonElement`
 * untyped), its token bounding the dial and the connection; a reconnect reopens the chain from the advanced cursor;
 * the backoff; the give-up once; every dial's params, auth, headers and request id, the SSE and long-poll dials through
 * the exchange, the WebSocket dial with no hook; decode; send; the emitted surface with its claimed `…2` params.
 * Driven on `realtime`, with consumer programs and csc; every timed call follows a warm one on its client.
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { CallScript, Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { compiledCSharp } from "./__fixtures__/compiled.ts"
import { checked, clientOf, program } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { drivenCSharpSdk } from "./__fixtures__/driven.ts"
import { csharpCallPlans, generateCSharpSdk } from "./sdk.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

/** `calls` run by the driver (the `realtime` SDK, which must build) under `script` and `setup` against `replies`. */
async function drive(replies: readonly Reply[], calls: readonly Call[], o: { script?: Script; setup?: Setup } = {}) {
	const sdk = drivenCSharpSdk("realtime")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: o.setup ?? {} }, { url: server.url }, { script: o.script ?? {} })
		return { base: server.url, bodies: [...server.bodies], hops: [...server.hops], run }
	})
}
type Drove = Awaited<ReturnType<typeof drive>>

const FEED = { operation: "feed.live", route: { method: "GET", path: "/feed" }, search: { channel: "c" } }
const live = (extra: Partial<Call> = {}): Call => ({ ...FEED, ...extra })
const RESUME: Call = { operation: "feed.resume", route: { method: "GET", path: "/resume" } }
/** a call's realtime fields; QUICK's short first backoff lands a reconnect within 5–10 ms */
const QUICK_ENTRY: CallScript = { realtime: { reconnectDelayMs: 10 } }
const budget = (realtime: CallScript["realtime"]): Script => ({ calls: [{ realtime }] })
const QUICK = budget({ reconnectDelayMs: 10 })
const refused: Reply = { json: { message: "no" }, status: 404 }
const unavailable: Reply = { status: 503, text: "" }
const bad: Reply = { json: { message: "bad" }, status: 400 }
const BAD_400 = { body: { message: "bad" }, errorKey: null, kind: "error", status: 400 }
type Step = string | { waitMs: number }
const sse = (steps: readonly Step[], end: "close" | "drop" | "hold"): Reply => ({ sse: { end, steps }, status: 200 })
/** event n of a resumable stream: SSE id n, payload n with reconnect token rt-n */
const ev = (n: number) => `id: ${n}\ndata: {"n":${n},"reconnect_token":"rt-${n}"}\n\n`
const frame = (n: number) => ({ n, reconnect_token: `rt-${n}` })
const framed = (...values: readonly unknown[]) => ({ frames: values, kind: "frames" })
const frames = (...values: readonly unknown[]) => [framed(...values)]
/** a long-poll answer: payload n, its cursor in `id` and `reconnect_token`; `Payload` declares no `id`, so a frame drops it */
const polled = (n: number, id: string): Reply => ({ json: { id, n, reconnect_token: `rt-${id}` }, status: 200 })
/** refused upgrade, refused event stream, then long-poll: two polls answered */
const POLLED: readonly Reply[] = [refused, unavailable, polled(1, "7"), polled(2, "8")]
const RECONNECTING: readonly Reply[] = [refused, sse([ev(1)], "drop"), refused, sse([ev(2)], "hold")]
/** The unbounded open a timed call follows on its client (per-call timeout 0): a refused upgrade, then SSE. */
const WARM = live({ take: 1, timeoutMs: 0 })
const WARMED: readonly Reply[] = [refused, sse([ev(0)], "hold")]
const WARM_SEEN = framed(frame(0))
/** a hop's resume wire: its URL, then its Last-Event-ID header (`-` without one) */
const wire = (hop: RecordedHop | undefined) => `${hop?.url} ${hop?.headers["last-event-id"] ?? "-"}`
const FEED_URL = "/feed?channel=c"
const CLASH_URL = "/realtime-clash/feed?channel=c&max_reconnect_attempts=3&reconnect_delay=4"
/** which dial a hop is: a WebSocket upgrade, an event stream, else a poll */
const dialOf = (hop: RecordedHop) =>
	hop.headers.upgrade ? "upgrade" : hop.headers.accept === "text/event-stream" ? "sse" : "poll"
const BARE = `${FEED_URL} -`
const AT_1 = "/feed?channel=c&last_event_id=1&reconnect_token=rt-1"
/** a connection's stream trace: its frames read, the cursor `Options` settled on ("id token"), the proven transport */
const settled = (yields: number, at: string, proven: string | null, errors: readonly unknown[] = []) => {
	const [lastEventId, reconnectToken] = at.split(" ")
	return { realtime: { cursor: { lastEventId, reconnectToken }, errors, proven }, yields }
}
const TOK: Setup = { auth: { kind: "bearer", token: "tok" } }
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const JSON_POST = { body: { contentType: "application/json", json: { hi: 1 } }, method: "POST", url: FEED_URL }
/** A stream's OCE as traced: the method's token ended it (Fd2), via the stream (contract 50 §4.3). */
const CANCELED = expect.objectContaining({ canceled: true, via: "stream" })
/** each hop's X-Request-Id; call `i`'s trace, and its error as `[type, status, via]` */
/** what a dial sent: whether its URL is the call's, then these headers */
const SENT = ["x-tenant", "authorization", "x-cfg"]
const sent = ({ headers, url }: RecordedHop) => [url.startsWith(FEED_URL), ...SENT.map((k) => headers[k])]
const TWICE: Script = { calls: [QUICK_ENTRY, QUICK_ENTRY] }
const ids = ({ hops }: Drove) => hops.map((hop) => hop.headers["x-request-id"])
const call = ({ run }: Drove, i = 0) => run.trace?.calls[i]
const failure = (drove: Drove, i = 0) => ((e) => e && [e.type, e.status, e.via])(call(drove, i)?.error)

/** A consumer's view of one read (an enumeration left at its first value): none, the value's JSON, or the error. */
const READ_1 = '{"n":1,"reconnect_token":"rt-1"}'
const READ = `static async Task<string> Read<T>(ResumableConnection<T> rc, CancellationToken token = default)
{ try { await foreach (var value in rc.WithCancellation(token)) { return $"ok {JsonSerializer.Serialize(value)}"; } return "none"; }
  catch (Exception e) when (e is not OperationCanceledException) { return $"err {e.GetType().Name}: {e.Message}"; } }`
const USINGS = ["System.IO", "System.Linq", "System.Text.Json.Serialization.Metadata", "System.Threading"]

/** A consumer with READ when it calls it (unused is CS8321) and `types` after it, against `replies`: notes, hop URLs. */
async function consumed(name: string, replies: readonly Reply[], body: string, types = "") {
	const sdk = compiledCSharp("realtime")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	const { client, namespace } = clientOf(sdk)
	const usings = USINGS.map((ns) => `using ${ns};\n`).join("")
	const source = `// consumer ${name}: a test program, never shipped\n${usings}${program(namespace, client, body.includes("Read(") ? `${READ}\n${body}` : body)}${types}`
	return served(replies, async (server) => {
		const ran = await sdk.exec(source, "", [server.url])
		const out = ran.status === 0 ? (JSON.parse(ran.stdout) as Record<string, string[]>) : undefined
		return { hops: server.hops.map((hop) => hop.url), out, stderr: ran.stderr }
	})
}

/** What csc holds of the realtime methods: each typed by its event schema, the folded resume params gone. */
const WRONG = 'ResumableConnection<JsonElement> wrong = await c.Feed.LiveAsync("c");'
const CLAIMED = 'await c.Feed.ResumeAsync(reconnectToken2: "x");'
const TYPES = [
	'using var c = Client(); ResumableConnection<Payload> x = await c.Feed.LiveAsync("c");',
	'ResumableConnection<JsonElement> r = await c.Feed.ResumeAsync(protocols2: "p", lastEventId: "5", reconnectToken: "rt");',
	WRONG,
	CLAIMED,
	'await c.Feed.LiveAsync("c", maxReconnectAttempts: 3, reconnectDelay: TimeSpan.FromSeconds(2), protocols: ["v1"]);',
	"(TransportOptions o, ConnectionState s, TransportKind? k) = (x.Options, x.State, x.ProvenTransport);",
	"await foreach (Payload p in x) { long? n = p.N; }",
]

/** csc's errors for TYPES against `realtime`, each as `<the statement> → <CS code>: <message>`. */
function findings(): string[] {
	const source = program("HoneySdk", "HoneySdkClient", TYPES.join("\n"))
	const lines = source.split("\n")
	return checked("realtime", source).map((line) => {
		const found = /^\((\d+),\d+\): error (CS\d+: .*)$/.exec(line)
		return found === null ? line : `${lines[Number(found[1]) - 1]?.trim()} → ${found[2]}`
	})
}

describe.skipIf(!DOTNET)("a realtime method: awaiting it returns ResumableConnection<T> connected (Fd6)", SLOW, () => {
	/* ported: python realtime.test.ts:116 (C# has one client; `reconnect_token2` is csc's CS1739) */
	it("returns the connection connected, typed by the event schema, Disconnected after DisposeAsync; the folded params gone", async () => {
		const body = `using var c = Client();
var rc = await c.Feed.LiveAsync("c");
Note($"{rc.State}"); await rc.DisposeAsync(); Note($"{rc.State}");`
		const { hops, out, stderr } = await consumed("opened", [refused, sse([ev(1)], "hold")], body)
		expect({ hops: hops.length, out: out?.main }, stderr).toEqual({ hops: 2, out: ["Connected", "Disconnected"] })
		expect(findings()).toEqual([
			`${WRONG} → CS0029: Cannot implicitly convert type 'HoneySdk.ResumableConnection<HoneySdk.Payload>' to 'HoneySdk.ResumableConnection<System.Text.Json.JsonElement>'`,
			`${CLAIMED} → CS1739: The best overload for 'ResumeAsync' does not have a parameter named 'reconnectToken2'`,
		])
	})

	/* ported: python realtime.test.ts:135 (300 ms against a dial held 2,700 ms past it, after a warm open) */
	it("dials before it returns: a cancel before the call dials nothing, one during the dial ends it", async () => {
		const script: Script = { calls: [{}, { cancel: "before" }, { cancel: { afterMs: 300 } }] }
		const calls = [WARM, live({ take: 1 }), live({ take: 1 })]
		const drove = await drive([...WARMED, { ...refused, delayMs: 3000 }], calls, { script })
		const seen = { hops: drove.hops.length, observed: drove.run.observed, upgrade: drove.hops[2]?.headers.upgrade }
		expect(seen, drove.run.stderr).toEqual({ hops: 3, observed: [WARM_SEEN, null, null], upgrade: "websocket" })
		const ends = [1, 2].map((i) => call(drove, i)).map((c) => [c?.error, c?.stream, (c?.elapsedMs ?? 1e9) < 2500])
		const returned = [expect.objectContaining({ canceled: true, via: "return" }), undefined, true]
		expect(ends).toEqual([returned, returned])
	})

	/* ported: python realtime.test.ts:151 (the OCE traced, Fd2; without the token's registration ev(2) lands at 5 s) */
	it("ends an open connection on a later cancel: the frames so far, the OCE traced, no reconnect", async () => {
		/* the cancel lands 1,000 ms in, after the first event, and 4,000 ms before the second (the timing rule);
		 * the driver files the read's OCE in realtime.errors too */
		const script: Script = { calls: [{}, { cancel: { afterMs: 1000 }, ...QUICK_ENTRY }] }
		const held = sse([ev(1), { waitMs: 5000 }, ev(2)], "hold")
		const drove = await drive([...WARMED, refused, held], [WARM, live({ take: 2 })], { script })
		const c = call(drove, 1)
		const seen = [c?.error, drove.hops.length, drove.run.observed, c?.stream]
		const want = [CANCELED, 4, [WARM_SEEN, framed(frame(1))], settled(1, "1 rt-1", "sse", [c?.error?.text])]
		expect(seen, drove.run.stderr).toEqual(want)
		expect([(c?.elapsedMs ?? 0) >= 990, (c?.elapsedMs ?? 1e9) < 4000], `${c?.elapsedMs}`).toEqual([true, true])
	})
})

describe.skipIf(!DOTNET)("the cursor advances past each delivered message; a reconnect reopens the chain", SLOW, () => {
	/* ported: python realtime.test.ts:164 (red under M9: deliver without the cursor advance resends the bare URL) */
	it("reconnects after a drop, the next upgrade and event stream carrying the last id and token", async () => {
		const replies = [refused, sse([ev(1), ev(2)], "drop"), refused, sse([ev(3)], "hold")]
		const drove = await drive(replies, [live({ take: 3 })], { script: QUICK })
		const resumed = "/feed?channel=c&last_event_id=2&reconnect_token=rt-2 -"
		expect([drove.run.observed, call(drove)?.stream, drove.hops.map(wire)], drove.run.stderr).toEqual([
			frames(frame(1), frame(2), frame(3)),
			settled(3, "3 rt-3", "sse"),
			[BARE, BARE, resumed, "/feed?channel=c&reconnect_token=rt-2 2"],
		])
	})

	/* ported: python realtime.test.ts:177 (the three cursors as three calls on one client) */
	it("opens with the caller's cursor on each transport's wire, and with none when it is unset or empty", async () => {
		const given = [{ lastEventId: "0", reconnectToken: "rt-0" }, {}, { lastEventId: "", reconnectToken: "" }]
		const replies = given.flatMap(() => [refused, sse([ev(1)], "hold")])
		const calls = given.map((cursor) => live({ ...cursor, take: 1 }))
		const drove = await drive(replies, calls)
		const wires = drove.hops.map(wire)
		const opened = ["/feed?channel=c&last_event_id=0&reconnect_token=rt-0 -", "/feed?channel=c&reconnect_token=rt-0 0"]
		expect([drove.run.observed, [0, 2, 4].map((i) => wires.slice(i, i + 2))], drove.run.stderr).toEqual([
			given.map(() => framed(frame(1))),
			[opened, [BARE, BARE], [BARE, BARE]],
		])
	})
})

describe.skipIf(!DOTNET)("the long-poll fallback advances its own cursor and polls once per read", SLOW, () => {
	/* ported: python realtime.test.ts:190 (red under M10: a poll's cursor copied at connect; Payload drops the id) */
	it("falls back past a refused upgrade and event stream, each poll carrying the cursor before it", async () => {
		const drove = await drive(POLLED, [live({ take: 2 })], { script: QUICK })
		expect([drove.run.observed, call(drove)?.stream], drove.run.stderr).toEqual([
			frames({ n: 1, reconnect_token: "rt-7" }, { n: 2, reconnect_token: "rt-8" }),
			settled(2, "8 rt-8", "longpoll"),
		])
		/* the hop URL, not the cursor: a poll that never advances its own still reports the connection's */
		const bare = ["upgrade", "sse", "poll"].map((dial) => `GET ${dial} ${FEED_URL}`)
		const polls = [...bare, "GET poll /feed?channel=c&last_event_id=7&reconnect_token=rt-7"]
		expect(drove.hops.map((hop) => `${hop.method} ${dialOf(hop)} ${hop.url}`)).toEqual(polls)
	})

	/* ported: python realtime.test.ts:207 (feed.resume is untyped: JsonElement, Fd7) */
	it("delivers one message per answer, a JSON array as one, and polls no further ahead than the reader", async () => {
		const replies = [refused, unavailable, { json: [{ n: 1 }, { n: 2 }], status: 200 }, { json: { n: 3 }, status: 200 }]
		const { hops, run } = await drive(replies, [{ ...RESUME, take: 2 }], { script: QUICK })
		expect([run.observed, hops.map((hop) => hop.url)], run.stderr).toEqual([
			frames([{ n: 1 }, { n: 2 }], { n: 3 }),
			Array.from({ length: 4 }, () => "/resume"),
		])
	})
})

describe.skipIf(!DOTNET)("a reconnect backs off from an SSE retry, else the delay, else 1 s; a give-up", SLOW, () => {
	/* ported: python realtime.test.ts:218 (the four on one warmed client; the ceilings at 500 ms, see below) */
	it("waits at least half the base before the first reconnect: retry 2000, delay 10, the default; 0 none", async () => {
		/* the first backoff is jittered into the upper half of its base: 2000 → [1000, 2000], 10 → [5, 10], the
		 * default 1000 → [500, 1000], 0 → 0. Both ceilings sit at 500 ms, the realistic mutant's floor (the call's
		 * delay dropped, or 0 read as unset, sleeps the default's ≥ 500 ms): the widest bound that still catches it */
		const hinted = [refused, sse([`retry: 2000\n${ev(1)}`], "drop"), refused, sse([ev(2)], "hold")]
		const replies = [...WARMED, ...hinted, ...RECONNECTING, ...RECONNECTING, ...RECONNECTING]
		const calls = [WARM, ...Array.from({ length: 4 }, () => live({ take: 2 }))]
		const script: Script = { calls: [{}, QUICK_ENTRY, QUICK_ENTRY, {}, { realtime: { reconnectDelayMs: 0 } }] }
		const drove = await drive(replies, calls, { script })
		const both = framed(frame(1), frame(2))
		expect([drove.run.observed, drove.hops.length], drove.run.stderr).toEqual([[WARM_SEEN, both, both, both, both], 18])
		const ms = [1, 2, 3, 4].map((i) => call(drove, i)?.elapsedMs ?? Number.NaN)
		const timing = { hinted: ms[0]! >= 1000, quick: ms[1]! < 500, unset: ms[2]! >= 500, zero: ms[3]! < 500 }
		expect(timing, ms.join(" ")).toEqual({ hinted: true, quick: true, unset: true, zero: true })
		expect(Math.max(ms[0]!, ms[2]!)).toBeLessThan(5000)
	})

	/* ported: python realtime.test.ts:240 */
	it("reconnects after a clean end, keeps the cursor on every attempt, and gives up after the max", async () => {
		/* each attempt runs the whole chain: upgrade, event stream, then a poll answered 500 */
		const down: Reply = { json: { message: "down" }, status: 500 }
		const replies = [refused, sse([ev(1)], "close"), refused, refused, down, refused, refused, down]
		const script = budget({ maxReconnectAttempts: 2, reconnectDelayMs: 1 })
		const drove = await drive(replies, [live({ take: 2 })], { script })
		const attempt = [`${AT_1} -`, "/feed?channel=c&reconnect_token=rt-1 1", `${AT_1} -`]
		expect([failure(drove), drove.run.observed, call(drove)?.stream, drove.hops.map(wire)], drove.run.stderr).toEqual([
			["InternalServerException", 500, "stream"],
			frames(frame(1)),
			settled(1, "1 rt-1", null, ["HTTP 500: down"]),
			[BARE, BARE, ...attempt, ...attempt],
		])
	})
})

/** A caller's adapter (Fd6): each connect takes the plan's next item, one message per connection; a null fails. */
const ADAPTERS = `
internal sealed class Conn(int item) : ITransportConnection
{
    private int? _item = item;
    public bool Disposed { get; private set; }
    public Task<TransportMessage?> ReceiveAsync(CancellationToken cancellationToken) => Task.FromResult(Take());
    private TransportMessage? Take() { var message = _item is { } n ? new TransportMessage($"{n}") : null; _item = null; return message; }
    public Task SendAsync(string text, CancellationToken cancellationToken) => Task.CompletedTask;
    public ValueTask DisposeAsync() { Disposed = true; return ValueTask.CompletedTask; }
}
internal class Fake(Queue<int?> plan) : ITransportAdapter
{
    public List<Conn> Conns { get; } = [];
    public int Left => plan.Count;
    public string Name => "fake";
    public TransportKind Kind => TransportKind.Sse;
    public virtual Task<ITransportConnection> ConnectAsync(string url, TransportOptions options, CancellationToken cancellationToken)
    { if (!plan.TryDequeue(out var step) || step is not { } item) throw new IOException("down"); Conns.Add(new Conn(item)); return Task.FromResult<ITransportConnection>(Conns[^1]); }
}
internal sealed class Slow() : Fake(new Queue<int?>())
{
    public override async Task<ITransportConnection> ConnectAsync(string url, TransportOptions options, CancellationToken cancellationToken)
    { await Task.Delay(10_000, cancellationToken); throw new IOException("slow"); }
}
`

describe.skipIf(!DOTNET)("a connection's states; a caller's adapter under the same loop (Fd3, Fd6)", SLOW, () => {
	/* ported: python realtime.test.ts:256 (red under M12: a cancelled enumeration ends the connection, Fd3) */
	it("is Connected, Reconnecting or Disconnected; a budget of 0 never reconnects and raises once", async () => {
		/* a long-poll connect does not dial, so the 400 is the first read's. A read bounded by its own token at
		 * 1,000 ms mid-reconnect leaves the connection reconnecting: the upgrade is held 2,000 ms past the bound */
		const body = `Section("no-reconnect"); var rc = await Client().Feed.LiveAsync("c", maxReconnectAttempts: 0, reconnectDelay: TimeSpan.FromMilliseconds(1));
Note($"{rc.State}"); Note(await Read(rc)); Note($"{rc.State} {await Read(rc)} {await Read(rc)}");
Section("reconnecting"); var again = await Client().Feed.LiveAsync("c", reconnectDelay: TimeSpan.FromMilliseconds(1));
Note($"{again.State} {await Read(again)}");
using var bound = new CancellationTokenSource(1000);
try { Note(await Read(again, bound.Token)); } catch (OperationCanceledException) { Note($"timed out {again.State}"); }
await again.CloseAsync(); Note($"{again.State} {await Read(again)}");`
		const replies = [refused, refused, bad, refused, sse([ev(1)], "drop"), { ...refused, delayMs: 3000 }]
		const { hops, out, stderr } = await consumed("states", replies, body)
		expect({ hops, out }, stderr).toEqual({
			hops: [...Array.from({ length: 5 }, () => FEED_URL), AT_1],
			out: {
				"no-reconnect": ["Connected", "err BadRequestException: HTTP 400: bad", "Disconnected none none"],
				reconnecting: [`Connected ok ${READ_1}`, "timed out Reconnecting", "Disconnected none"],
			},
		})
	})

	/* ported: python realtime.test.ts:287 (the cancel is the connect's token at 300 ms, not a task's) */
	it("over a caller's adapter: clean ends reconnect, the attempts reset, dead connections dispose, a cancel propagates", async () => {
		/* without the reset, the third connection's end exhausts the budget before the failing connects run:
		 * "the connection ended" in place of the adapter's own error */
		const body = `Section("give-up"); var info = (JsonTypeInfo<JsonElement>)JsonSerializerOptions.Default.GetTypeInfo(typeof(JsonElement));
var a = new Fake(new Queue<int?>([1, 2, 3, null, null]));
var options = new TransportOptions { MaxReconnectAttempts = 2, ReconnectDelay = TimeSpan.FromMilliseconds(1) };
var rc = new ResumableConnection<JsonElement>("http://t/rt", [a], info, options);
await rc.ConnectAsync(); for (var i = 0; i < 5; i++) Note(await Read(rc));
Note($"{rc.State} {a.Conns.Count} {a.Conns.All(conn => conn.Disposed)} {a.Left}");
Section("cancel"); var fallback = new Fake(new Queue<int?>([1]));
var slow = new ResumableConnection<JsonElement>("http://t/rt", [new Slow(), fallback], info);
using var bound = new CancellationTokenSource(300);
try { await slow.ConnectAsync(bound.Token); Note("connected"); }
catch (OperationCanceledException) { Note($"canceled {slow.State != ConnectionState.Connected} {fallback.Conns.Count}"); }`
		const { hops, out, stderr } = await consumed("adapter", [], body, ADAPTERS)
		expect({ hops, out }, stderr).toEqual({
			hops: [],
			out: {
				cancel: ["canceled True 0"],
				"give-up": ["ok 1", "ok 2", "ok 3", "err IOException: down", "none", "Disconnected 3 True 0"],
			},
		})
	})
})

describe.skipIf(!DOTNET)("every dial carries the call's params, auth, headers and its own request id", SLOW, () => {
	/* ported: python realtime.test.ts:330 (both chains as two calls on one client) */
	it("sends the bearer, the config headers and the call's params on every upgrade, stream, poll and reconnect", async () => {
		const setup: Setup = { ...TOK, headers: { "X-Cfg": "1" } }
		const tenant = live({ headers: { "x-tenant": "acme" }, take: 2 })
		const { hops, run } = await drive([...RECONNECTING, ...POLLED], [tenant, tenant], { script: TWICE, setup })
		const read = run.observed?.map((o) => (o as { frames?: unknown[] } | null)?.frames?.length)
		const want = [[2, 2], Array.from({ length: 8 }, () => [true, "acme", "Bearer tok", "1"])]
		expect([read, hops.map(sent)], run.stderr).toEqual(want)
	})

	/* ported: python realtime.test.ts:349 */
	it("gives each dial a fresh X-Request-Id, the config's kept on each; a refused chain raises the typed status", async () => {
		const twice = [live({ take: 2 }), live({ take: 2 })]
		const script: Script = { calls: [QUICK_ENTRY, QUICK_ENTRY, { realtime: { maxReconnectAttempts: 0 } }] }
		const chains = [...RECONNECTING, ...POLLED]
		const fresh = await drive([...chains, refused, unavailable, bad], [...twice, live({ take: 1 })], { script })
		const fixed = await drive(chains, twice, { script: TWICE, setup: { headers: { "X-Request-Id": "fixed" } } })
		expect([new Set(ids(fresh)).size, ids(fresh), ids(fixed)], fresh.run.stderr + fixed.run.stderr).toEqual([
			11,
			Array.from({ length: 11 }, () => expect.stringMatching(UUID4)),
			Array.from({ length: 8 }, () => "fixed"),
		])
		const refusal = [failure(fresh, 2), call(fresh, 2)?.stream?.realtime?.errors, fresh.run.observed?.[2]]
		expect(refusal).toEqual([["BadRequestException", 400, "stream"], ["HTTP 400: bad"], BAD_400])
	})
})

describe.skipIf(!DOTNET)("the SSE and long-poll dials ride the exchange; the WebSocket dial runs no hook", SLOW, () => {
	/* ported: python realtime.test.ts:371 */
	it("carries a refresh to the next upgrade, the hooks seeing the cursor sent and the operation's path", async () => {
		/* stream dials get the hooks and log; an SSE 401 refreshes once, restarting the chain (bit 19 e); ws neither */
		const expired: Reply = { json: { message: "expired" }, status: 401 }
		const replies = [refused, sse([ev(1)], "drop"), refused, expired, refused, sse([ev(2)], "drop"), refused]
		replies.push(sse([ev(3)], "hold"))
		const script: Script = { ...QUICK, log: true, onAuthExpired: { tokens: ["new"] } }
		const setup: Setup = { auth: { kind: "bearer", token: "old" } }
		const { base, hops, run } = await drive(replies, [live({ take: 3 })], { script, setup })
		const hooks = run.trace?.hooks ?? []
		const at = (url: string | undefined) => (url?.startsWith(base) ? url.slice(base.length) : url)
		const [first, second] = [`${FEED_URL}&reconnect_token=rt-1`, `${FEED_URL}&reconnect_token=rt-2`]
		const exchanged = ["request_start", "response_received 200"]
		const seen = {
			answered: hooks.filter((h) => h.phase === "response").map((h) => `${h.status} ${h.isRetry}`),
			authExpired: run.trace?.authExpired,
			hooked: hooks.filter((h) => h.phase === "request").map((h) => `${at(h.url)} ${h.path} ${h.isRetry}`),
			log: run.trace?.log.map((e) => [e.event, e.status].filter((v) => v !== undefined).join(" ")),
			observed: run.observed,
		}
		expect(seen, run.stderr).toEqual({
			answered: ["200 false", "401 false", "200 false", "200 false"],
			authExpired: 1,
			hooked: [`${FEED_URL} /feed false`, `${first} /feed false`, `${first} /feed false`, `${second} /feed false`],
			log: [...exchanged, "request_start", "response_received 401", "error 401", ...exchanged, ...exchanged],
			observed: frames(frame(1), frame(2), frame(3)),
		})
		const dials = hops.map((hop) => `${hop.headers.upgrade ?? "sse"} ${hop.headers.authorization?.slice(7)}`)
		const restarted = "websocket old, sse old, websocket new, sse new"
		expect(dials.join(", ")).toBe(`websocket old, sse old, ${restarted}, websocket new, sse new`)
	})

	/* ported: python realtime.test.ts:405 */
	it("follows a same-origin redirect on the event-stream dial, and caps a poll's answer at maxResponseBytes", async () => {
		const moved: Reply = { redirect: { origin: "primary", path: "/moved?channel=c" }, status: 307 }
		const followed = await drive([refused, moved, sse([ev(1)], "hold")], [live({ take: 1 })], { script: QUICK })
		expect([followed.run.observed, followed.hops.map((hop) => hop.url)], followed.run.stderr).toEqual([
			frames(frame(1)),
			[FEED_URL, FEED_URL, "/moved?channel=c"],
		])
		const big: Reply = { json: { n: 1, pad: "x".repeat(100) }, status: 200 }
		const script: Script = { ...budget({ maxReconnectAttempts: 0 }), config: { maxResponseBytes: 64 } }
		const capped = await drive([refused, unavailable, big], [live({ take: 1 })], { script })
		const seen = [capped.run.observed, failure(capped), call(capped)?.stream?.realtime?.errors]
		const want = [frames(), ["ApiConnectionException", undefined, "stream"], ["the answer exceeds 64 bytes"]]
		expect(seen, capped.run.stderr).toEqual(want)
	})
})

describe.skipIf(!DOTNET)("a message that does not decode keeps the connection; send POSTs; …2 is sent", SLOW, () => {
	/* ported: python realtime.test.ts:425 (STJ refuses another JSON kind itself: `5` into Payload) */
	it("throws DecodeException for a message that does not decode, the cursor advanced and the connection kept", async () => {
		const body = `await using var rc = await Client().Feed.LiveAsync("c", reconnectDelay: TimeSpan.FromMilliseconds(1));
Note(await Read(rc)); Note(await Read(rc)); Note($"{rc.State}"); Note(rc.Options.LastEventId);`
		const { hops, out, stderr } = await consumed("kind", [refused, sse(["id: 1\ndata: 5\n\n", ev(2)], "hold")], body)
		const decode = expect.stringMatching(/^err DecodeException: a message does not decode: /)
		const want = [2, [decode, 'ok {"n":2,"reconnect_token":"rt-2"}', "Connected", "2"]]
		expect([hops.length, out?.main], stderr).toEqual(want)
	})

	/* ported: python realtime.test.ts:438 */
	it("POSTs on a long-poll connection with the call's params, the bearer and compact JSON, then polls", async () => {
		const replies = [refused, unavailable, { json: {}, status: 200 }, polled(1, "7")]
		const sending = live({ headers: { "x-tenant": "acme" }, send: ['{"hi":1}'], take: 1 })
		const drove = await drive(replies, [sending], { script: QUICK, setup: TOK })
		const seen = [failure(drove), drove.run.observed]
		expect(seen, drove.run.stderr).toEqual([undefined, frames({ n: 1, reconnect_token: "rt-7" })])
		expect(drove.hops.slice(2)).toMatchObject([
			{ ...JSON_POST, headers: { authorization: "Bearer tok", "x-tenant": "acme" } },
			{ method: "GET", url: FEED_URL },
		])
		expect(drove.bodies[2]?.toString()).toBe('{"hi":1}')
	})

	/* ported: python realtime.test.ts:451 (a 405 has no class of its own: UnexpectedStatusException, Fb14) */
	it("POSTs on an SSE connection; a POST answered 405 throws its status exception, no frames", async () => {
		const replies = [refused, sse([ev(1)], "hold"), { json: { message: "no" }, status: 405 }]
		const drove = await drive(replies, [live({ send: ['{"hi":1}'], take: 1 })], { script: QUICK, setup: TOK })
		const e = call(drove)?.error
		expect(drove.hops[2], drove.run.stderr).toMatchObject({ ...JSON_POST, headers: { authorization: "Bearer tok" } })
		const seen = [drove.run.observed, e?.type, e?.chain.includes("ApiStatusException"), e?.status, e?.via]
		expect(seen).toEqual([frames(), "UnexpectedStatusException", true, 405, "stream"])
	})

	/* ported: python realtime.test.ts:477 (C#'s clash.feed in the realtime document, contract 50 §4.1) */
	it("sends a claimed …2 param by its wire name beside a budget of 0", async () => {
		const body = `var rc = await Client().Clash.FeedAsync("c", maxReconnectAttempts2: 3, reconnectDelay2: 4, maxReconnectAttempts: 0);
Note(await Read(rc)); Note(await Read(rc));`
		const { hops, out, stderr } = await consumed("clash", [refused, refused, bad], body)
		const want = [
			[CLASH_URL, CLASH_URL, CLASH_URL],
			["err BadRequestException: HTTP 400: bad", "none"],
		]
		expect([hops, out?.main], stderr).toEqual(want)
	})
})

/** The realtime `<returns>` line (contract 50 §2): one per realtime method. */
const RETURNS =
	"    /// <returns>The connection over WebSocket, else SSE, else long-poll: it reconnects after a drop and resumes after the last message it delivered; the token, CloseAsync or DisposeAsync ends it.</returns>"
const OPTS = "TransportOptions.Of(lastEventId, reconnectToken, protocols, maxReconnectAttempts, reconnectDelay)"
const FIELDS =
	"string? lastEventId = null, string? reconnectToken = null, IReadOnlyList<string>? protocols = null, int? maxReconnectAttempts = null, TimeSpan? reconnectDelay = null, RequestOptions? options = null, CancellationToken cancellationToken = default) =>"
const CTX = "HoneySdkJsonContext.Default"
/** contract 50 §2.1's realtime lines, and `clash.feed`'s by the same rules (its clashing queries claimed `…2`) */
const EMITTED = [
	'    private static readonly Operation _live = new("GET", "/feed", [], Idempotent: false);',
	'    private static readonly Operation _resume = new("GET", "/resume", [], Idempotent: false);',
	'    private static readonly Operation _feed = new("GET", "/realtime-clash/feed", [], Idempotent: false);',
	`    public Task<ResumableConnection<Payload>> LiveAsync(string channel, string? xTenant = null, ${FIELDS}`,
	`        _t.RealtimeAsync(_live, new([], [Arg.Of("channel", channel, ${CTX}.String)], [Arg.Of("x-tenant", xTenant, ${CTX}.String)], null, null, options), ${OPTS}, ${CTX}.Payload, cancellationToken);`,
	`    public Task<ResumableConnection<JsonElement>> ResumeAsync(string? protocols2 = null, ${FIELDS}`,
	`        _t.RealtimeAsync(_resume, new([], [Arg.Of("protocols", protocols2, ${CTX}.String)], [], null, null, options), ${OPTS}, ${CTX}.JsonElement, cancellationToken);`,
	`    public Task<ResumableConnection<Payload>> FeedAsync(string channel, long? maxReconnectAttempts2 = null, long? reconnectDelay2 = null, ${FIELDS}`,
	`        _t.RealtimeAsync(_feed, new([], [Arg.Of("channel", channel, ${CTX}.String), Arg.Of("max_reconnect_attempts", maxReconnectAttempts2, ${CTX}.NullableInt64), Arg.Of("reconnect_delay", reconnectDelay2, ${CTX}.NullableInt64)], [], null, null, options), ${OPTS}, ${CTX}.Payload, cancellationToken);`,
]
const CLAIMS = {
	channel: "channel",
	max_reconnect_attempts: "maxReconnectAttempts2",
	reconnect_delay: "reconnectDelay2",
}

describe("the emitted realtime surface: the stream fields reserved, a clashing declared param claimed …2", () => {
	/* ported: python realtime.test.ts:462 (C# carries no event kind on the Operation: STJ checks it) */
	it("emits §2.1's methods and fields byte for byte, and claims max_reconnect_attempts and reconnect_delay as …2", () => {
		const lines = (generateCSharpSdk(FIXTURES.realtime.document()).files["Client.cs"] ?? "").split("\n")
		const query = csharpCallPlans(FIXTURES.realtime.document())["clash.feed"]?.query
		const [missing, returns] = [EMITTED.filter((line) => !lines.includes(line)), lines.filter((l) => l === RETURNS)]
		expect({ missing, query, returns: returns.length }).toEqual({ missing: [], query: CLAIMS, returns: 3 })
	})
})
