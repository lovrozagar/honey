/**
 * Realtime transports (contract 50 §5.7, Fd3, Fd6; Python's `realtime.transports.test.ts` analog): `TransportOptions`,
 * `TransportKind`, `ConnectionState` and a realtime call's default adapters (`WsAdapter`, `SseAdapter`,
 * `LongPollAdapter`) in their chain, a custom order of them, and `RequestOptions.Raw` per transport; the SSE and
 * long-poll adapters alone through the call's exchange (the hooks, the advancing cursor, one message per answer, a
 * 204 polling again, a poll bounded at 60 s whatever the client's timeout, a POSTed send and its 405); and
 * `ResumableConnection<JsonElement>` over a caller's in-process C# adapters (`decls`): fallback, resume with the
 * advanced cursor, clean ends, give-up, a cancelled connect, a session, a cancel-safe enumeration, a close race.
 * Consumers on `realtime`: `realtime-transports` (in process; its server sees nothing) and one
 * `realtime-adapters-<section>` per server-backed section, each on its own server. Every section runs guarded: a
 * throwing one notes `raised <Type>: <text>`, and the program goes on.
 */
import { describe, expect, it } from "vitest"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume, type Run } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
/** Every executed describe's bound: a cold gate builds the SDK first. */
const SLOW = { timeout: 600_000 }

/**
 * Beside `Program`, a caller's in-process adapter. `Conn` delivers its texts, then `then`: "hold" until disposed (its
 * receive then answers null, as a closed transport does; `Waiting` set once it holds), "fail" (an `IOException`) or
 * "end" (null, a clean end). `Fake` opens its conns in order after each one's delay (its token honored), a null one
 * or one past the end refusing with `IOException("refused")`, and records each connect's cursor as
 * `<LastEventId>/<ReconnectToken>` and the connection's state then (`Rc`, once set); `Redialed` is set once a second
 * connect starts. `Rt.Take` reads n values within 5 s each, a fresh enumeration after an end (null) or a failure
 * (`<Type>: <message>`); `Rt.Cursor` is the cursor, proven transport and state.
 */
const DECLS = `internal sealed class Conn(IEnumerable<string> texts, string then = "hold", int delayMs = 0) : ITransportConnection
{
    private readonly Queue<string> _texts = new(texts);
    private readonly TaskCompletionSource _gone = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public List<string> Sent { get; } = [];
    public bool Closed { get; private set; }
    public int DelayMs => delayMs;
    public TaskCompletionSource Waiting { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public async Task<TransportMessage?> ReceiveAsync(System.Threading.CancellationToken token)
    {
        if (_texts.TryDequeue(out var text)) return new TransportMessage(text);
        if (then == "fail") throw new System.IO.IOException("reset");
        if (then == "hold") { Waiting.TrySetResult(); await _gone.Task.WaitAsync(token); }
        return null;
    }
    public Task SendAsync(string text, System.Threading.CancellationToken token) { Sent.Add(text); return Task.CompletedTask; }
    public ValueTask DisposeAsync() { Closed = true; _gone.TrySetResult(); return ValueTask.CompletedTask; }
}

internal sealed class Fake(TransportKind kind, IEnumerable<Conn?> conns) : ITransportAdapter
{
    private readonly Queue<Conn?> _conns = new(conns);
    public string Name => "fake";
    public TransportKind Kind => kind;
    public List<string> Got { get; } = [];
    public List<string> States { get; } = [];
    public ResumableConnection<JsonElement>? Rc { get; set; }
    public TaskCompletionSource Redialed { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public async Task<ITransportConnection> ConnectAsync(string url, TransportOptions options, System.Threading.CancellationToken token)
    {
        Got.Add($"{options.LastEventId}/{options.ReconnectToken}");
        States.Add(Rc?.State.ToString() ?? "");
        if (Got.Count > 1) Redialed.TrySetResult();
        var conn = (_conns.TryDequeue(out var next) ? next : null) ?? throw new System.IO.IOException("refused");
        await Task.Delay(conn.DelayMs, token);
        return conn;
    }
}

internal static class Rt
{
    public static readonly System.Text.Json.Serialization.Metadata.JsonTypeInfo<JsonElement> Element = HoneySdkJsonContext.Default.JsonElement;
    private static readonly System.Text.Json.Serialization.Metadata.JsonTypeInfo<System.Text.Json.Nodes.JsonNode> Node =
        (System.Text.Json.Serialization.Metadata.JsonTypeInfo<System.Text.Json.Nodes.JsonNode>)JsonSerializerOptions.Default.GetTypeInfo(typeof(System.Text.Json.Nodes.JsonNode));
    public static string J(params object?[] items) => JsonSerializer.Serialize(items);
    public static string Json(object? value) => JsonSerializer.Serialize(value);
    public static string Failed(Exception e) => $"{e.GetType().Name}: {e.Message}";
    public static string Proven<T>(ResumableConnection<T> c) => c.ProvenTransport?.ToString().ToLowerInvariant() ?? "none";
    public static string Cursor(ResumableConnection<JsonElement> c) => $"{c.Options.LastEventId}/{c.Options.ReconnectToken} {c.ProvenTransport} {c.State}";
    public static Task SendJson(ResumableConnection<JsonElement> rc, string json) => rc.SendAsync(System.Text.Json.Nodes.JsonNode.Parse(json)!, Node);
    public static object[] Named(ITransportAdapter a) => [a.Name, a.Kind.ToString(), a switch { WsAdapter => a.Kind == TransportKind.Ws, SseAdapter => a.Kind == TransportKind.Sse, LongPollAdapter => a.Kind == TransportKind.LongPoll, _ => false }];
    public static Func<RequestContext, System.Threading.CancellationToken, Task> Hook(List<string[]> into) =>
        (ctx, _) => { into.Add([ctx.Url.PathAndQuery, ctx.Url.AbsolutePath]); return Task.CompletedTask; };
    public static async Task<List<object?>> Take(ResumableConnection<JsonElement> rc, int n)
    {
        var taken = new List<object?>();
        var e = rc.GetAsyncEnumerator();
        while (taken.Count < n)
        {
            var next = e.MoveNextAsync().AsTask();
            if (await Task.WhenAny(next, Task.Delay(5000)) != next) { taken.Add("stalled"); return taken; }
            try { if (await next) { taken.Add(e.Current); continue; } taken.Add(null); }
            catch (Exception x) { taken.Add(Failed(x)); }
            await e.DisposeAsync(); e = rc.GetAsyncEnumerator();
        }
        await e.DisposeAsync();
        return taken;
    }
    public static async Task<string> Send(ResumableConnection<JsonElement> rc, int n)
    {
        try { await SendJson(rc, $$"""{"hi":{{n}}}"""); return J("sent"); }
        catch (Exception e) { return J(Failed(e), rc.State.ToString()); }
    }
}`

/** In `Main`, before the sections: each runs as its own section, a throw noted, and the program goes on. */
const GUARDED = `async Task Guarded(string name, Func<Task> run)
{
    Section(name);
    try { await run(); }
    catch (Exception e) { Note($"raised {Rt.Failed(e)}"); }
}`

/** `text`, each line indented one level. */
const indent = (text: string) =>
	text
		.split("\n")
		.map((line) => (line === "" ? "" : `    ${line}`))
		.join("\n")

/** The consumer body running each of `sections` guarded, in order. */
function body(sections: Readonly<Record<string, string>>): string {
	const runs = Object.entries(sections).map(
		([name, text]) => `await Guarded(${JSON.stringify(name)}, async () =>\n{\n${indent(text)}\n});`,
	)
	return [GUARDED, ...runs].join("\n\n")
}

/** A connection over the in-process adapters `adapters` at an address nothing serves, with `options`. */
const rc = (adapters: string, options = "") =>
	`var rc = new ResumableConnection<JsonElement>("http://rt.test/feed", [${adapters}], Rt.Element${options === "" ? "" : `, ${options}`});`
const delay = (ms: number, more = "") =>
	`new TransportOptions { ${more}ReconnectDelay = TimeSpan.FromMilliseconds(${ms}) }`

/** The in-process sections: none of them sends a request. */
const IN_PROCESS: Readonly<Record<string, string>> = {
	states: `Note(Rt.Json(Enum.GetNames<ConnectionState>()));
var bad = new Fake(TransportKind.Ws, [null]);
var good = new Fake(TransportKind.Sse, [new Conn(["""{"seq":1}""", """{"seq":2}"""])]);
${rc("bad, good")}
var before = rc.State.ToString();
await rc.ConnectAsync();
Note(Rt.J(before, rc.State.ToString(), rc.ProvenTransport.ToString(), bad.Got.Count, good.Got.Count));
Note(Rt.Json(await Rt.Take(rc, 2)));
await rc.CloseAsync();
Note(Rt.J(rc.State.ToString(), (await Rt.Take(rc, 1))[0]));`,
	custom: `var one = new Fake(TransportKind.Ws, [new Conn(["""{"kind":"custom","seq":1}""", """{"kind":"custom","seq":2}"""])]);
var rc = new ResumableConnection<JsonElement>(_base + "/feed", [one], Rt.Element);
await rc.ConnectAsync();
Note(Rt.Json(await Rt.Take(rc, 2)));
Note(Rt.J(one.Got, rc.ProvenTransport.ToString(), rc.State.ToString()));
await rc.CloseAsync();
Note(Rt.J(rc.State.ToString()));`,
	resume: `string Id(int i) => $$"""{"id":"{{i}}","reconnect_token":"rt-{{i}}"}""";
var flaky = new Fake(TransportKind.Ws, [new Conn([Id(1), Id(2)], "fail"), null]);
var stable = new Fake(TransportKind.Sse, [new Conn([Id(3)])]);
${rc("flaky, stable", delay(10, 'LastEventId = "0", ReconnectToken = "rt-0", '))}
flaky.Rc = stable.Rc = rc;
await rc.ConnectAsync();
Note(Rt.Json(await Rt.Take(rc, 3)));
Note(Rt.J(flaky.Got, stable.Got, Rt.Cursor(rc)));
Note(Rt.J(flaky.States.GetRange(1, flaky.States.Count - 1), stable.States));
await rc.CloseAsync();`,
	plan: `var conns = new Conn[] { new(["1"], "end"), new(["2"], "end"), new(["3"], "end") };
var plan = new Fake(TransportKind.Ws, [.. conns, null, null]);
${rc("plan", delay(1, "MaxReconnectAttempts = 2, "))}
await rc.ConnectAsync();
Note(Rt.Json(await Rt.Take(rc, 5)));
Note(Rt.J(plan.Got.Count, Array.ConvertAll(conns, conn => conn.Closed), rc.State.ToString()));
var late = new ResumableConnection<JsonElement>("http://rt.test/feed", [new Fake(TransportKind.Ws, [new Conn([], delayMs: 10_000)])], Rt.Element);
using var cts = new System.Threading.CancellationTokenSource(300);
try { await late.ConnectAsync(cts.Token); Note(Rt.J("opened")); }
catch (OperationCanceledException) { Note(Rt.J("canceled", late.State != ConnectionState.Connected)); }`,
	session: `var conn = new Conn(["""{"n":1}"""]);
${rc("new Fake(TransportKind.Ws, [conn])")}
await rc.ConnectAsync();
Note(Rt.J(rc.State.ToString(), rc.ProvenTransport.ToString()));
await Rt.SendJson(rc, """{"hi":1,"é":"ü"}""");
await rc.SendAsync("as is");
Note(Rt.Json(conn.Sent));
Note(Rt.Json(await Rt.Take(rc, 1)));
await rc.CloseAsync();
Note(Rt.J(rc.State.ToString(), (await Rt.Take(rc, 1))[0], conn.Closed));
Note(await Rt.Send(rc, 2));`,
	"give-up": `var failing = new Fake(TransportKind.Ws, [new Conn([], "fail")]);
${rc("failing", delay(1, "MaxReconnectAttempts = 3, "))}
await rc.ConnectAsync();
Note(Rt.Json(await Rt.Take(rc, 3)));
Note(Rt.J(failing.Got, rc.State.ToString(), rc.ProvenTransport is null));
Note(await Rt.Send(rc, 1));`,
	"cancel-safe": `var dying = new Fake(TransportKind.Ws, [new Conn([], "fail"), new Conn(["""{"ok":true}"""], delayMs: 10_000), new Conn(["""{"ok":true}"""])]);
${rc("dying", delay(10))}
await rc.ConnectAsync();
using var cts = new System.Threading.CancellationTokenSource();
var reading = Task.Run(async () => { await foreach (var m in rc.WithCancellation(cts.Token)) return "delivered"; return "ended"; });
await dying.Redialed.Task.WaitAsync(TimeSpan.FromSeconds(5));
cts.Cancel();
try { Note(Rt.J(await reading.WaitAsync(TimeSpan.FromSeconds(5)))); }
catch (OperationCanceledException) { Note(Rt.J("canceled", rc.State.ToString())); }
Note(Rt.Json(await Rt.Take(rc, 1)));
Note(Rt.J(rc.State.ToString(), dying.Got.Count));
await rc.CloseAsync();`,
	"close-race": `var held = new Conn([]);
var fake = new Fake(TransportKind.Ws, [held]);
${rc("fake")}
await rc.ConnectAsync();
var e = rc.GetAsyncEnumerator();
var next = Task.Run(async () => await e.MoveNextAsync());
await held.Waiting.Task.WaitAsync(TimeSpan.FromSeconds(5));
await rc.CloseAsync();
Note(Rt.J(await next.WaitAsync(TimeSpan.FromSeconds(2)), rc.State.ToString(), fake.Got.Count));`,
}

const refused: Reply = { json: { message: "no" }, status: 404 }
const held = (steps: readonly string[]): Reply => ({ sse: { end: "hold", steps }, status: 200 })
const upgraded: Reply = { status: 101, ws: { steps: [] } }
const posted: Reply = { json: {}, status: 200 }
const unposted: Reply = { json: { message: "no" }, status: 405 }
const unavailable: Reply = { status: 503, text: "" }
const bad: Reply = { json: { message: "no" }, status: 400 }
/** A call refused over WebSocket and SSE opens over long-poll, which dials nothing: its URL and adapters, two hops in. */
const SETUP = `string url;
IReadOnlyList<ITransportAdapter> adapters;
await using (var setup = await c.Feed.LiveAsync("c")) (url, adapters) = (setup.Url, setup.Adapters);`
/** A client with `config` and a request hook recording each dial as `[URL sent, its path]` into `hooked`. */
const hooked = (config = "") => `var hooked = new List<string[]>();
using var c = Client(new ClientConfig { BearerToken = "tok", ${config}OnRequest = [Rt.Hook(hooked)] });`
/** A connection over the setup's adapter `i` with `options`, connected, then `text` on it. */
const alone = (i: number, options: string, text: string) =>
	`await using (var rc = new ResumableConnection<JsonElement>(url, [adapters[${i}]], Rt.Element${options}))
{
    await rc.ConnectAsync();
${text}
}`
/** Take `n`, then send `{"hi":1}` and `{"hi":2}`, each noted. */
const readSend = (n: number) => `    Note(Rt.Json(await Rt.Take(rc, ${n})));
    Note(await Rt.Send(rc, 1));
    Note(await Rt.Send(rc, 2));`
/** The long-poll answers: a message with a cursor, an array as one message, and one held past the client's timeout. */
const [POLLED, PAIR, LATE]: readonly Reply[] = [
	{ json: { id: "7", n: 2, reconnect_token: "rt-7" }, status: 200 },
	{ json: [{ n: 3 }, { n: 4 }], status: 200 },
	{ delayMs: 2500, json: { n: 5 }, status: 200 },
]
const NO_RETRY = ", new TransportOptions { MaxReconnectAttempts = 0 }"

/** The server-backed sections: each one's replies, and its body, run against its own server. */
const ADAPTERS: Readonly<Record<string, { readonly body: string; readonly replies: readonly Reply[] }>> = {
	names: {
		body: `var o = new TransportOptions();
Note(Rt.J(o.LastEventId, o.ReconnectToken, o.Protocols, o.MaxReconnectAttempts, o.ReconnectDelay.ToString()));
var t = new TransportOptions { LastEventId = "42", ReconnectToken = "tok", Protocols = ["v1"], MaxReconnectAttempts = 3, ReconnectDelay = TimeSpan.FromMilliseconds(500) };
Note(Rt.J(t.LastEventId, t.ReconnectToken, t.Protocols, t.MaxReconnectAttempts, t.ReconnectDelay.ToString()));
Note(Rt.Json(Enum.GetNames<TransportKind>()));
using var c = Client(new ClientConfig { BearerToken = "tok" });
await using var conn = await c.Feed.LiveAsync("c");
var named = new List<object[]>();
foreach (var a in conn.Adapters) named.Add(Rt.Named(a));
Note(Rt.Json(named));`,
		replies: [upgraded],
	},
	defaults: {
		body: `using var c = Client(new ClientConfig { BearerToken = "tok" });
await using (var first = await c.Feed.LiveAsync("c"))
{
    Note(Rt.Proven(first));
    var a = first.Adapters;
    await using var custom = new ResumableConnection<JsonElement>(first.Url, [a[1], a[0], a[2]], Rt.Element);
    await custom.ConnectAsync();
    Note(Rt.Proven(custom));
}
for (var i = 0; i < 2; i++) { await using var conn = await c.Feed.LiveAsync("c"); Note(Rt.Proven(conn)); }`,
		replies: [upgraded, held([]), refused, held([]), refused, unavailable],
	},
	raw: {
		body: `${hooked()}
var host = new Uri(_base).Authority;
for (var i = 0; i < 3; i++)
{
    var raw = new RawResponse();
    await using var conn = await c.Feed.LiveAsync("c", options: new RequestOptions { Raw = raw });
    Note(Rt.J(raw.Status, raw.Url?.ToString().Replace(host, "H")));
    Note(Rt.Proven(conn));
}
Note(Rt.Json(hooked));`,
		replies: [upgraded, refused, held([]), refused, unavailable],
	},
	sse: {
		body: `${hooked()}\n${SETUP}\n${alone(1, "", readSend(1))}\nNote(Rt.Json(hooked));`,
		replies: [refused, refused, held(['data: {"n":1}\n\n']), posted, unposted],
	},
	/* the warm call first: unbounded (per-call timeout 0), so no bounded dial or send is the client's first request */
	longpoll: {
		body: `${hooked("Timeout = TimeSpan.FromMilliseconds(300), ")}
await using (await c.Feed.LiveAsync("c", options: new RequestOptions { Timeout = TimeSpan.Zero })) { }
${SETUP}
${alone(2, NO_RETRY, `${readSend(2)}\n    Note(Rt.Json(await Rt.Take(rc, 1)));`)}
Note(Rt.Json(hooked));`,
		replies: [refused, refused, refused, refused, POLLED, { status: 204 }, PAIR, posted, unposted, LATE],
	},
	refused: {
		body: `using var c = Client(new ClientConfig { BearerToken = "tok" });
${SETUP}
${alone(2, NO_RETRY, "    Note(Rt.Json(await Rt.Take(rc, 2)));")}
try { await new ResumableConnection<JsonElement>(url, [adapters[1]], Rt.Element).ConnectAsync(); Note(Rt.J("opened")); }
catch (Exception e) { Note(Rt.J(Rt.Failed(e))); }`,
		replies: [refused, refused, bad, bad],
	},
}

const runs = new Map<string, Promise<{ readonly hops: readonly RecordedHop[]; readonly run: Run }>>()
/** Consumer `name` running `sections` against its own server answering `replies`, once: its run and every hop. */
function servedRun(name: string, sections: Readonly<Record<string, string>>, replies: readonly Reply[]) {
	const run =
		runs.get(name) ??
		served(replies, async (server) => {
			const ran = await consume("realtime", name, { base: server.url, body: body(sections), decls: DECLS })
			return { hops: [...server.hops], run: ran }
		})
	runs.set(name, run)
	return run
}
/** The `realtime-transports` run, every in-process section in one program against a server it never dials. */
const transports = () => servedRun("realtime-transports", IN_PROCESS, [])
/** Section `name` of ADAPTERS in its own program. */
function adapterRun(name: string) {
	const section = ADAPTERS[name]
	if (section === undefined) throw new Error(`ADAPTERS has no section ${name}`)
	return servedRun(`realtime-adapters-${name}`, { [name]: section.body }, section.replies)
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

/** In-process section `name` as `expect`'s two arguments: whether it ran with its notes, and its stderr. */
async function inProcess(name: string): Promise<readonly [unknown, string]> {
	const { run } = await transports()
	return [notesOf(run, name), run.stderr]
}

/** What a section must have answered: it ran to its end with `notes`. */
const ran = (notes: readonly unknown[]) => ({ notes, ran: true })

/** A hop as `METHOD url kind`: an upgrade, an event-stream open, a poll, or a POST's content type and JSON body. */
function dial(hop: RecordedHop): string {
	if (hop.method === "POST") return `POST ${hop.url} ${hop.body.contentType} ${JSON.stringify(hop.body.json)}`
	const kind =
		hop.headers.upgrade === "websocket" ? "upgrade" : hop.headers.accept === "text/event-stream" ? "sse" : "poll"
	return `${hop.method} ${hop.url} ${kind}`
}

/** Section `name` of ADAPTERS as `expect`'s two arguments: whether it ran, its notes and its hops (`dial`), and its stderr. */
async function adapted(name: string): Promise<readonly [unknown, string]> {
	const { hops, run } = await adapterRun(name)
	return [{ ...notesOf(run, name), hops: hops.map(dial) }, run.stderr]
}

/** What a server-backed section must have answered: it ran to its end with `notes`, dialing `hops`. */
const dialed = (hops: readonly string[], notes: readonly unknown[]) => ({ hops, notes, ran: true })

/** What `OnRequest` saw for `hops`: each dial but the upgrades (no hook on a WS dial), its URL as sent and its path. */
const hookedOf = (hops: readonly string[]) =>
	hops.filter((hop) => !hop.endsWith(" upgrade")).map((hop) => [hop.split(" ")[1], "/feed"])

const BARE = "/feed?channel=c"
const CURSOR = `${BARE}&last_event_id=7&reconnect_token=rt-7`
const [UPGRADE, SSE, POLL] = [`GET ${BARE} upgrade`, `GET ${BARE} sse`, `GET ${BARE} poll`]
const POSTS = [1, 2].map((n) => `POST ${BARE} application/json {"hi":${n}}`)
const SENDS = [["sent"], ["UnexpectedStatusException: HTTP 405: no", "Connected"]]
const CLOSED = ["ApiConnectionException: the connection is not open", "Disconnected"]

describe.skipIf(!DOTNET)("the ITransportAdapter interface and a realtime call's default chain", SLOW, () => {
	/* ported: python realtime.transports.test.ts:380 (TransportOptions' defaults, the kinds, the call's adapters) */
	it("ships TransportOptions with its defaults, TransportKind's three kinds, and a call's ws, sse and longpoll adapters of their public types", async () => {
		const opts = [
			[null, null, [], 5, "00:00:01"],
			["42", "tok", ["v1"], 3, "00:00:00.5000000"],
		]
		const kinds = ["Ws", "Sse", "LongPoll"]
		const adapters = kinds.map((kind) => [kind.toLowerCase(), kind, true])
		expect(...(await adapted("names"))).toEqual(dialed([UPGRADE], [...opts, kinds, adapters]))
	})

	/* ported: python realtime.transports.test.ts:391 (the long-poll open sends nothing: its first poll waits for the first read) */
	it("opens a call over WebSocket, else SSE, else long-poll, and a custom chain of its adapters in the caller's order", async () => {
		const hops = [UPGRADE, SSE, UPGRADE, SSE, UPGRADE, SSE]
		expect(...(await adapted("defaults"))).toEqual(dialed(hops, ["ws", "sse", "sse", "longpoll"]))
	})

	/* ported: python realtime.transports.test.ts:398 (Raw holds the answer the connection last opened with, never the
	 * endpoint's; the request hooks run on the SSE dials only) */
	it("fills RequestOptions.Raw with the real dialed answer: 101 and ws:// for WebSocket, 200 and http:// for SSE and long-poll", async () => {
		const hops = [UPGRADE, UPGRADE, SSE, UPGRADE, SSE]
		const opened = [[101, `ws://H${BARE}`], "ws", [200, `http://H${BARE}`], "sse", [200, `http://H${BARE}`], "longpoll"]
		expect(...(await adapted("raw"))).toEqual(dialed(hops, [...opened, hookedOf(hops)]))
	})
})

describe.skipIf(!DOTNET)("a call's SSE and long-poll adapters on their own, sending by POSTing the JSON", SLOW, () => {
	/* ported: python realtime.transports.test.ts:410 */
	it("receives over the SSE adapter through the call's exchange, a send POSTed with the client's auth and a 405 its error", async () => {
		const hops = [UPGRADE, SSE, SSE, ...POSTS]
		expect(...(await adapted("sse"))).toEqual(dialed(hops, [[{ n: 1 }], ...SENDS, hookedOf(hops)]))
		const auth = (await adapterRun("sse")).hops.map((hop) => [hop.headers.authorization, hop.headers["last-event-id"]])
		expect(auth).toEqual(hops.map(() => ["Bearer tok", undefined]))
	})

	/* ported: python realtime.transports.test.ts:422. Each poll uses the connection's own advancing cursor, never a
	 * copy taken at connect (M10), and is bounded at 60 s, so a 300 ms client timeout does not fail a poll answered at
	 * 2,500 ms (M11: a poll under the client's timeout gives up instead). One poll per message (a 204 polls again),
	 * none ahead of the reader. The first two hops are the warm call's */
	it("polls over the long-poll adapter with its advancing cursor, one message per answer, a 204 polling again, a poll bounded by 60 s", async () => {
		const polled = `GET ${CURSOR} poll`
		const hops = [UPGRADE, SSE, UPGRADE, SSE, POLL, polled, polled, ...POSTS, polled]
		const messages = [{ id: "7", n: 2, reconnect_token: "rt-7" }, [{ n: 3 }, { n: 4 }]]
		expect(...(await adapted("longpoll"))).toEqual(dialed(hops, [messages, ...SENDS, [{ n: 5 }], hookedOf(hops)]))
		const auth = (await adapterRun("longpoll")).hops.map((hop) => hop.headers.authorization)
		expect(auth).toEqual(hops.map(() => "Bearer tok"))
	})

	/* ported: python realtime.transports.test.ts:432 */
	it("surfaces a long-poll 400 from the enumeration once, then its end, and an SSE 400 from ConnectAsync", async () => {
		const refusal = "BadRequestException: HTTP 400: no"
		expect(...(await adapted("refused"))).toEqual(dialed([UPGRADE, SSE, POLL, SSE], [[refusal, null], [refusal]]))
	})
})

describe.skipIf(!DOTNET)("ResumableConnection over in-process adapters: the open and the resume", SLOW, () => {
	/* ported: python realtime.transports.test.ts:441 */
	it("skips a refusing adapter: Disconnected, then Connected over the next one, proven SSE, two messages, then Disconnected", async () => {
		const states = ["Connected", "Reconnecting", "Disconnected"]
		const opened = ["Disconnected", "Connected", "Sse", 1, 1]
		const taken = [{ seq: 1 }, { seq: 2 }]
		expect(...(await inProcess("states"))).toEqual(ran([states, opened, taken, ["Disconnected", null]]))
	})

	/* ported: python realtime.transports.test.ts:450 */
	it("dials only the caller's one adapter: one connect, proven WebSocket, and the server behind the URL sees no request", async () => {
		const custom = [1, 2].map((seq) => ({ kind: "custom", seq }))
		expect(...(await inProcess("custom"))).toEqual(ran([custom, [["/"], "Ws", "Connected"], ["Disconnected"]]))
		expect((await transports()).hops).toEqual([])
	})

	/* ported: python realtime.transports.test.ts:459. Each connect records the cursor it was handed before the
	 * delivery that advances it, so M9 (deliver without the cursor advance) hands the reconnect "0/rt-0" again */
	it("reconnects after a mid-stream drop through the next adapter while Reconnecting, each dial handed the advanced cursor", async () => {
		const ids = [1, 2, 3].map((id) => ({ id: `${id}`, reconnect_token: `rt-${id}` }))
		const handed = [["0/rt-0", "2/rt-2"], ["2/rt-2"], "3/rt-3 Sse Connected"]
		expect(...(await inProcess("resume"))).toEqual(ran([ids, handed, [["Reconnecting"], ["Reconnecting"]]]))
	})

	/* ported: python realtime.transports.test.ts:468 (each clean end reconnects and a delivery resets the attempts; the
	 * give-up raises the last failure once, then the enumeration ends; a connect cancelled through its token throws) */
	it("reconnects after each clean end, then gives up with the real failure once, closing every dead conn; a cancelled connect throws", async () => {
		const taken = [1, 2, 3, "IOException: refused", null]
		const after = [5, [true, true, true], "Disconnected"]
		expect(...(await inProcess("plan"))).toEqual(ran([taken, after, ["canceled", true]]))
	})
})

describe.skipIf(!DOTNET)("ResumableConnection over in-process adapters: a session and its end", SLOW, () => {
	/* ported: python realtime.transports.test.ts:477. §7's flag: STJ's default encoder escapes non-ASCII, where
	 * Python sends raw UTF-8 */
	it("drives one session: a send as compact JSON or text as is, a read, a close to Disconnected, then its end and a refused send", async () => {
		const sent = ['{"hi":1,"\\u00E9":"\\u00FC"}', "as is"]
		const notes = [["Connected", "Ws"], sent, [{ n: 1 }], ["Disconnected", null, true], CLOSED]
		expect(...(await inProcess("session"))).toEqual(ran(notes))
	})

	/* ported: python realtime.transports.test.ts:483 */
	it("gives up after MaxReconnectAttempts: the last failure once, then its end, Disconnected with no proven transport", async () => {
		const taken = ["IOException: refused", null, null]
		const after = [["/", "/", "/", "/"], "Disconnected", true]
		expect(...(await inProcess("give-up"))).toEqual(ran([taken, after, CLOSED]))
	})

	/* ported: python realtime.transports.test.ts:490. The enumeration's token is cancelled once the reconnect's second
	 * connect starts (a 10 s dial), and the state is read before the next enumeration could set it: M12 (a cancelled
	 * enumeration ends the connection) reads Disconnected, then the connection's end */
	it("keeps an enumeration cancel-safe: one cancelled mid-reconnect leaves it Reconnecting, and the next delivers", async () => {
		const notes = [["canceled", "Reconnecting"], [{ ok: true }], ["Connected", 3]]
		expect(...(await inProcess("cancel-safe"))).toEqual(ran(notes))
	})

	/* ported: python realtime.transports.test.ts:497 (the close comes once the read waits in the conn) */
	it("ends a MoveNextAsync pending in another task with false when CloseAsync runs: Disconnected, and no reconnect", async () => {
		expect(...(await inProcess("close-race"))).toEqual(ran([[false, "Disconnected", 1]]))
	})
})
