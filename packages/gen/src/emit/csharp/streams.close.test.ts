/**
 * How each C# stream surface ends (contract 50 §5.8). First Python's close legs, each under a read pending in
 * another task: `DisposeAsync` ends an SSE read quietly; `CloseAsync` ends a `ReceiveAsync` with null, one close
 * and no `Error`; a server's close frame is read as null and `ClosedBy`; `CloseAsync` ends a realtime enumeration
 * waiting in its backoff or on a poll at once, with no reconnect (Fd1, Fd3, §1 rules). Then the release legs (Go's
 * `sse.release.test.ts` pattern, §1 "Release checks"): one consumer program per exit path of an `EventStream`,
 * under a token nothing cancels unless the leg says so. Each program's next request is the text stream, whose
 * answer waits until stream 0's client left (gone.ts), so a connection let go only at the program's exit fails.
 * Each program reads by hand and never disposes what its leg does not name, so every verdict is the SDK's own
 * release, and keeps the stream reachable to the end (`GC.KeepAlive`), so a leaked socket's finalizer cannot fake
 * one. Every release leg names the mutant it turns red (§8.2), and the leak control proves the check is not hollow.
 * Last, a read pending on a caller's draining handler ends within 1 s of the method's token, on that token (R8).
 */
import { describe, expect, it } from "vitest"
import { gone } from "../shared/__fixtures__/gone.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume, seen } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import type { FixtureKey } from "./__fixtures__/documents.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
/** Every executed describe's bound: a cold gate builds the SDK first. */
const SLOW = { timeout: 600_000 }

type Step = string | { waitMs: number }
const sse = (steps: readonly Step[], end: "close" | "hold" = "close"): Reply => ({ sse: { end, steps }, status: 200 })
const tick = (n: number) => `data: {"n":${n}}\n\n`
/** A typed stream held open after its first event. */
const OPEN = sse([tick(1)], "hold")
/** A typed stream whose second event comes 5 s after its first: a cancel at 300 ms lands while the read waits. */
const HELD = sse([tick(1), { waitMs: 5000 }, tick(2)], "hold")
const closed = (code: number, reason = "") => ({ code, kind: "close", reason })

/** The consumer `name` over `key` against a server answering `replies`: its run and stream records. */
function consumed(key: FixtureKey, name: string, replies: readonly Reply[], body: string) {
	return served(replies, async (server) => {
		const run = await consume(key, name, { base: server.url, body })
		return { run, streams: [...server.streams] }
	})
}

/**
 * The local function `Settled(reader, ms)`: `reader` awaited at most `ms` ms, as its value (`null` for none), its
 * cancel (`canceled`), its error (`<type>: <message>`), or `stalled` when the bound came first.
 */
const SETTLED = `static async Task<string> Settled<T>(Task<T> reader, int ms)
{
    try
    {
        var value = await reader.WaitAsync(TimeSpan.FromMilliseconds(ms));
        return value?.ToString() ?? "null";
    }
    catch (TimeoutException)
    {
        return "stalled";
    }
    catch (OperationCanceledException)
    {
        return "canceled";
    }
    catch (Exception e)
    {
        return $"{e.GetType().Name}: {e.Message}";
    }
}`

/** The program's next request: the text stream opened on `c` and read to its end. */
const NEXT_OPEN = "var next = await c.Text.StreamAsync();"
const NEXT_READ = `await foreach (var ev in next)
{
    Note(ev.Data);
}`
const NEXT = `${NEXT_OPEN}\n${NEXT_READ}`

/**
 * The `sse` consumer `body` against `first` then the text stream held until stream 0's client left: the run, and
 * whether the server saw that client go before it answered.
 */
async function released(name: string, first: Reply, body: string) {
	const next = gone(sse(["data: z\n\n"]))
	const { run } = await consumed("sse", name, [first, next.reply], body)
	return { run, verdict: { ...seen(run), released: next.released() } }
}

/** A typed stream's read pending while the stream is disposed; the next open is the release point. */
const DISPOSED = `${SETTLED}
using var c = Client();
var s = await c.Ticks.StreamAsync();
var e = s.GetAsyncEnumerator();
await e.MoveNextAsync();
Note($"{e.Current.Data.N}");
var reader = e.MoveNextAsync().AsTask();
await Task.Delay(300);
await s.DisposeAsync();
Note(await Settled(reader, 2000));
${NEXT}
GC.KeepAlive(s);`

/** A socket's receive pending while it is closed from the program's main flow; its handlers noted. */
const SOCKET = `${SETTLED}
using var c = Client();
var w = await c.Rooms.SocketAsync("r");
w.Closed += by => Note($"close {(int)by.Status}");
w.Error += e => Note($"error {e.Message}");
var reader = w.ReceiveAsync();
await Task.Delay(300);
await w.CloseAsync();
Note(await Settled(reader, 2000));`

/** The server's close frame come while no read waits, then the read and the socket's `ClosedBy`. */
const CLOSED_UNDER = `${SETTLED}
using var c = Client();
var w = await c.Rooms.SocketAsync("r");
await Task.Delay(300);
Note(await Settled(w.ReceiveAsync(), 2000));
Note($"{w.ClosedBy}");`

/** A caller's adapter counting its connects, whose one connection ends at once (Python's `Once` and `Ended`). */
const ONCE = `internal sealed class Ended : ITransportConnection
{
    public Task<TransportMessage?> ReceiveAsync(System.Threading.CancellationToken cancellationToken) =>
        Task.FromResult<TransportMessage?>(null);

    public Task SendAsync(string text, System.Threading.CancellationToken cancellationToken) => Task.CompletedTask;

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}

internal sealed class Once : ITransportAdapter
{
    public int Connects { get; private set; }

    public string Name => "once";

    public TransportKind Kind => TransportKind.Sse;

    public Task<ITransportConnection> ConnectAsync(string url, TransportOptions options, System.Threading.CancellationToken cancellationToken)
    {
        Connects++;
        return Task.FromResult<ITransportConnection>(new Ended());
    }
}`

/** A connection over ONCE with a 5 s delay: after its one connection ends, the reconnect backs off 2.5 to 5 s. */
const BACKOFF = `${SETTLED}
var once = new Once();
var options = new TransportOptions { ReconnectDelay = TimeSpan.FromSeconds(5) };
var rc = new ResumableConnection<Payload>("http://rt.test/feed", [once], HoneySdkJsonContext.Default.Payload, options);
await rc.ConnectAsync();
var e = rc.GetAsyncEnumerator();
var reader = e.MoveNextAsync().AsTask();
await Task.Delay(300);
await rc.CloseAsync();
Note(await Settled(reader, 2000));
Note($"{rc.State}");
Note($"{once.Connects}");`

/** A connection refused over WebSocket and SSE, open over long-poll, its first poll answered after 3 s. */
const POLLING = `${SETTLED}
using var c = Client();
var rc = await c.Feed.LiveAsync("c");
var e = rc.GetAsyncEnumerator();
var reader = e.MoveNextAsync().AsTask();
await Task.Delay(300);
await rc.CloseAsync();
Note(await Settled(reader, 2000));
Note($"{rc.State}");
Note($"{rc.ProvenTransport}");`

describe.skipIf(!DOTNET)("an EventStream and a TypedWebSocket closed under a pending read", SLOW, () => {
	/* ported: python streams.close.test.ts:98 (aclose() becomes DisposeAsync; the release point added) */
	it("ends a read pending on an EventStream quietly when DisposeAsync runs: false, no error, the connection let go", async () => {
		/* mutant: DisposeAsync ends the pending read but leaves the response to an enumerator dispose that never comes */
		const { run, verdict } = await released("disposed", OPEN, DISPOSED)
		expect(verdict, run.stderr).toEqual({ out: ["1", "False", "z"], ran: true, released: true })
	})

	/* ported: python streams.close.test.ts:108 */
	it("ends a ReceiveAsync pending on a TypedWebSocket with null when CloseAsync runs: one close, no Error", async () => {
		const { run, streams } = await consumed("ws", "socket", [{ status: 101, ws: { steps: [] } }], SOCKET)
		expect(seen(run), run.stderr).toEqual({ out: ["close 1000", "null"], ran: true })
		expect(streams[0]?.received).toEqual([closed(1000)])
	})

	/* ported: python streams.close.test.ts:113 (C# has no session to close under the socket: the frame waits unread) */
	it("reads a server's close frame that came while no read waited as null, and ClosedBy as its code and reason", async () => {
		const closing: Reply = { status: 101, ws: { steps: [{ close: { code: 4401, reason: "unauthorized" } }] } }
		const { run } = await consumed("ws", "closed-under", [closing], CLOSED_UNDER)
		expect(seen(run), run.stderr).toEqual({
			out: ["null", "WsClose { Status = 4401, Reason = unauthorized }"],
			ran: true,
		})
	})
})

describe.skipIf(!DOTNET)("a ResumableConnection closed under a pending enumeration", SLOW, () => {
	/* ported: python streams.close.test.ts:124 (the caller's adapter in decls; no server: nothing dials) */
	it("ends an enumeration waiting in the reconnect's backoff at once: false, Disconnected, no reconnect", async () => {
		const run = await consume("realtime", "backoff", { body: BACKOFF, decls: ONCE })
		expect(seen(run), run.stderr).toEqual({ out: ["False", "Disconnected", "1"], ran: true })
	})

	/* ported: python streams.close.test.ts:129 */
	it("ends an enumeration waiting on a poll in flight at once: false, Disconnected, proven LongPoll", async () => {
		const replies: Reply[] = [
			{ json: { message: "no" }, status: 404 },
			{ status: 503, text: "" },
			{ delayMs: 3000, json: { n: 1 }, status: 200 },
		]
		const { run } = await consumed("realtime", "polling", replies, POLLING)
		expect(seen(run), run.stderr).toEqual({ out: ["False", "Disconnected", "LongPoll"], ran: true })
	})
})

/** R1: one event, then `break` (the enumerator's dispose, the stream never disposed); the next open on `c` timed. */
const BROKEN = `using var c = Client();
var s = await c.Ticks.StreamAsync();
await foreach (var ev in s)
{
    Note($"{ev.Data.N}");
    break;
}
var clock = System.Diagnostics.Stopwatch.StartNew();
${NEXT_OPEN}
var answered = clock.ElapsedMilliseconds;
${NEXT_READ}
Section("ms");
Note($"{answered}");
GC.KeepAlive(s);`

/** R2: the stream opened and left by `await using`, never read. */
const UNREAD = `using var c = Client();
await using (var s = await c.Ticks.StreamAsync())
{
    Note("opened");
}
${NEXT}`

/** R3: the method's token canceled at 300 ms under a pending read; nothing disposed; 3 s for the read to end. */
const CANCELED = `${SETTLED}
using var c = Client();
using var cts = new System.Threading.CancellationTokenSource();
var s = await c.Ticks.StreamAsync(cancellationToken: cts.Token);
var e = s.GetAsyncEnumerator();
await e.MoveNextAsync();
Note($"{e.Current.Data.N}");
var reader = e.MoveNextAsync().AsTask();
cts.CancelAfter(300);
Note(await Settled(reader, 3000));
${NEXT}
GC.KeepAlive(s);`

/** R4: a typed stream whose first event does not decode, read by hand and never disposed. */
const UNDECODED = `using var c = Client();
var s = await c.Ticks.StreamAsync();
var e = s.GetAsyncEnumerator();
try
{
    while (await e.MoveNextAsync())
    {
        Note($"{e.Current.Data.N}");
    }
}
catch (HoneyException error)
{
    Note(error.GetType().Name);
}
${NEXT}
GC.KeepAlive(s);`

/** R5: an `OnResponse` hook that throws on the 2xx open, so no stream is ever returned; the next open on a plain client. */
const HOOKED = `Func<ResponseContext, System.Threading.CancellationToken, Task> bad = (ctx, ct) => throw new InvalidOperationException("bad");
using var hooked = Client(new ClientConfig { OnResponse = [bad] });
try
{
    await hooked.Ticks.StreamAsync();
    Note("opened");
}
catch (HoneyException error)
{
    Note($"{error.GetType().Name}: {error.Message}");
}
using var c = Client();
${NEXT}`

/**
 * R6: the read's own token (the one `WithCancellation` hands `GetAsyncEnumerator`) canceled at 300 ms under a
 * pending read; the enumerator taken by hand so no `await foreach` disposes it.
 */
const READ_CANCELED = `${SETTLED}
using var c = Client();
var s = await c.Ticks.StreamAsync();
using var cts = new System.Threading.CancellationTokenSource();
var e = s.GetAsyncEnumerator(cts.Token);
await e.MoveNextAsync();
Note($"{e.Current.Data.N}");
var reader = e.MoveNextAsync().AsTask();
cts.CancelAfter(300);
Note(await Settled(reader, 3000));
${NEXT}
GC.KeepAlive(s);`

/**
 * R8: on a caller's `SocketsHttpHandler`, which drains an unfinished body for up to 2 s on a dispose (Q-d10: 2,304
 * ms), the method's token canceled 300 ms into a pending read; the second of two rounds timed (the first warms the
 * cancel path), from the cancel to the read's end, and whether its OCE carries the method's token.
 */
const DRAINING = `using var c = Client(new ClientConfig { Handler = new System.Net.Http.SocketsHttpHandler() });
for (var round = 0; round < 2; round++)
{
    using var cts = new System.Threading.CancellationTokenSource();
    var s = await c.Ticks.StreamAsync(cancellationToken: cts.Token);
    var e = s.GetAsyncEnumerator();
    await e.MoveNextAsync();
    var reader = e.MoveNextAsync().AsTask();
    await Task.Delay(300);
    var clock = System.Diagnostics.Stopwatch.StartNew();
    cts.Cancel();
    var ended = "ended";
    try
    {
        await reader;
    }
    catch (OperationCanceledException error)
    {
        ended = $"canceled {error.CancellationToken == cts.Token}";
    }
    if (round == 1)
    {
        Note(ended);
        Section("ms");
        Note($"{clock.ElapsedMilliseconds}");
    }
    GC.KeepAlive(s);
}`

/** R7: the leak: one event read, then the stream kept open and reachable past the next open. */
const KEPT = `using var c = Client();
var s = await c.Ticks.StreamAsync();
var e = s.GetAsyncEnumerator();
await e.MoveNextAsync();
Note($"{e.Current.Data.N}");
${NEXT}
GC.KeepAlive(e);
GC.KeepAlive(s);`

describe.skipIf(!DOTNET)("an EventStream's connection let go by each of its ends, the SDK's own release", SLOW, () => {
	/* ported: go sse.release.test.ts:57 (Fd1, Q-d12, Q-d12b) */
	it("R1: lets it go at once when await foreach breaks, the next answer within 1 s of the break", async () => {
		/*
		 * M1 (the enumerator's dispose leaves the response) → released false. The BCL's default drain (the SDK's
		 * handler without MaxResponseDrainSize = 0) keeps the connection 2 s (Q-d12: 2,005 ms) → the bound fails.
		 */
		const { run, verdict } = await released("broken", OPEN, BROKEN)
		expect(verdict, run.stderr).toEqual({ out: ["1", "z"], ran: true, released: true })
		expect(Number(run.out?.ms?.[0]), run.stderr).toBeLessThan(1000)
	})

	/* Fd1: await using alone */
	it("R2: lets it go when await using leaves a stream never read", async () => {
		/* mutant: EventStream.DisposeAsync lets the response go only through an enumerator, and none was taken */
		const { run, verdict } = await released("unread", OPEN, UNREAD)
		expect(verdict, run.stderr).toEqual({ out: ["opened", "z"], ran: true, released: true })
	})

	/* Fd2 (334187f: the program cancels the method's token and disposes nothing, so no driver can mask it) */
	it("R3: lets it go when the method's token is canceled after the open, the stream never disposed", async () => {
		/* M2 (no registration on the method's token) → the read waits for the next event: "stalled", released false */
		const { run, verdict } = await released("canceled", HELD, CANCELED)
		expect(verdict, run.stderr).toEqual({ out: ["1", "canceled", "z"], ran: true, released: true })
	})

	/* Fd1: an error ends the stream */
	it("R4: lets it go when an event does not decode, the enumerator never disposed", async () => {
		/* mutant: the decode error is raised but leaves the response to a dispose the program never makes */
		const { run, verdict } = await released("undecoded", sse(["data: nope\n\n"], "hold"), UNDECODED)
		expect(verdict, run.stderr).toEqual({ out: ["DecodeException", "z"], ran: true, released: true })
	})

	/* ported: go sse.release.test.ts:71 (§1 rules "Open") */
	it("R5: lets the 2xx open go when an OnResponse hook throws, no stream ever returned", async () => {
		/* M3 (OpenAsync's catch leaves the response) → released false */
		const { run, verdict } = await released("hooked", OPEN, HOOKED)
		expect(verdict, run.stderr).toEqual({ out: ["HookException: hook: bad", "z"], ran: true, released: true })
	})

	/* Fd2, Fd3: the read's own token */
	it("R6: lets it go when the read's own token is canceled under a pending read, nothing disposed", async () => {
		/* mutant: the enumeration's token is not linked into the body read (Q-d9) → "stalled", released false */
		const { run, verdict } = await released("read-canceled", HELD, READ_CANCELED)
		expect(verdict, run.stderr).toEqual({ out: ["1", "canceled", "z"], ran: true, released: true })
	})

	/* gone.test.ts's own control, for C# (Q-d12 sse-leak) */
	it("R7: sees no release from a program that keeps the stream open: the check is not hollow", async () => {
		/* the control's mutant is the check itself: a gone() blind to a held C# connection reads true here */
		const { run, verdict } = await released("kept", OPEN, KEPT)
		expect(verdict, run.stderr).toEqual({ out: ["1", "z"], ran: true, released: false })
	})
})

describe.skipIf(!DOTNET)(
	"an EventStream's pending read ended by the method's token, whatever the handler drains",
	SLOW,
	() => {
		/* the implementer's leg (bit 15 2b, the reviewer's Fd2 ruling, branch A): the end source's cancel, not a dispose */
		it("R8: ends a read pending on a caller's draining handler within 1 s of the method's token, its OCE on that token", async () => {
			/* mutant: the release disposes the response without cancelling the pending read → the 2 s drain (2,000 ms) */
			const { run } = await consumed("sse", "draining", [HELD, HELD], DRAINING)
			expect(seen(run).out?.slice(0, 1), run.stderr).toEqual(["canceled True"])
			expect(Number(run.out?.ms?.[0]), run.stderr).toBeLessThan(1000)
		})
	},
)
