using System.Net.WebSockets;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Honey.Driver;

/// <summary>A stream call: the SDK, its plan, the grid call, its script entry and how it is observed.</summary>
internal sealed record StreamCall(Sdk Sdk, Plan Plan, Call Call, CallScript? Entry, Lens Lens);

/// <summary>
/// A stream call's reads (contract 50 §4.3; Python's stream.py, Rust's stream.rs, socket.rs and live.rs): awaiting
/// the method opens the stream, and the open and every read run under one watchdog, so a stream that has not ended
/// after <see cref="StallAfter"/> fails the run instead of hanging it. An error at the open is the grid's
/// <c>error</c> or <c>timeout</c> (else null), traced via <c>"return"</c> (Observe.cs). Once open, the call
/// observes what the stream delivered: SSE <c>events</c>, WebSocket and realtime <c>frames</c>. An error a read or
/// a send threw is traced via <c>"stream"</c> and ends the reads; a cancel (the method's token, the grid's
/// <c>cancel</c>: no token reaches a read) is the stream's quiet end, its OCE traced with <c>canceled: true</c>.
/// Unscripted, any other stream error fails the run. The driver never disposes what it observed: after
/// <c>take</c> it leaves the enumeration (the SDK's own <c>break</c> path), and after an error it does nothing, so
/// a release check tests the SDK; a WebSocket or realtime connection is then closed by <c>CloseAsync</c>, the API
/// under test, its failure recorded as <c>closeError</c>.
/// </summary>
internal static class Streams
{
    private static readonly TimeSpan StallAfter = TimeSpan.FromSeconds(10);
    private const string Ungraded = "the call ended in an error the grid has no outcome for: ";

    /// <summary><paramref name="at"/>'s stream opened by <paramref name="open"/>, then read by its kind, under the watchdog.</summary>
    public static async Task<Outcome> ObserveAsync(StreamCall at, Func<Task<object>> open)
    {
        var work = OpenedAsync(at, open);
        try
        {
            return await work.WaitAsync(StallAfter);
        }
        catch (TimeoutException) when (!work.IsCompleted)
        {
            throw new DriverException($"stream stalled: no end within {StallAfter.TotalSeconds}s");
        }
    }

    private static async Task<Outcome> OpenedAsync(StreamCall at, Func<Task<object>> open)
    {
        object stream;
        try
        {
            stream = await open();
        }
        catch (Exception e) when (e is not DriverException)
        {
            return Observe.Thrown(at.Sdk, e, at.Lens);
        }
        return at.Plan.Stream switch
        {
            "sse" => await EventsAsync(at, stream),
            "ws" => await FramesAsync(at, stream, at.Entry?.Ws ?? new WsScript()),
            _ => await LiveAsync(at, stream),
        };
    }

    /// <summary>
    /// What an open stream delivered: its failure traced via <c>"stream"</c>; unscripted, a failure other than a
    /// cancel fails the run.
    /// </summary>
    private static Outcome Streamed(StreamCall at, JsonObject seen, Exception? failure, JsonObject trace)
    {
        if (failure is null)
        {
            return new Outcome(seen, Stream: trace);
        }
        if (at.Lens.Scripted)
        {
            return new Outcome(seen, Traces.ErrorOf(at.Sdk, failure, "stream", at.Lens.Envelope), Stream: trace);
        }
        return failure is OperationCanceledException
            ? new Outcome(seen, Stream: trace)
            : throw new DriverException($"{Ungraded}{failure.GetType().Name}: {failure.Message}");
    }

    /// <summary>
    /// An <c>EventStream&lt;T&gt;</c> read until <c>take</c> events (absent: until its end). A thrown error counts as a
    /// yield and ends the reads. The trace holds the yields, each event's <c>Retry</c> in ms (null when unset) and
    /// the typed headers the open filled.
    /// </summary>
    private static async Task<Outcome> EventsAsync(StreamCall at, object stream)
    {
        var reader = Reader.Of(stream);
        var data = reader.Element.GetProperty("Data")?.PropertyType
            ?? throw new DriverException($"{reader.Element.Name} has no Data");
        var (events, retry) = (new JsonArray(), new JsonArray());
        var failure = await ReadAsync(reader, at.Call.Take, item =>
        {
            retry.Add(Sdk.Get(item, "Retry") is TimeSpan wait ? JsonValue.Create((long)wait.TotalMilliseconds) : null);
            events.Add(EventOf(at.Sdk, item, data));
        });
        var trace = new JsonObject { ["yields"] = events.Count + (failure is null ? 0 : 1) };
        if (retry.Count > 0)
        {
            trace["retry"] = retry;
        }
        if (at.Lens.Holder is { } holder && at.Plan.ResponseHeaders is { } declared
            && Observe.HeadersOf(holder, declared) is { Count: > 0 } headers)
        {
            trace["headers"] = headers;
        }
        return Streamed(at, new JsonObject { ["events"] = events, ["kind"] = "events" }, failure, trace);
    }

    /// <summary>An event as the grid observes it: its data through the SDK's context (a string as it is), its event name and id only when set.</summary>
    private static JsonObject EventOf(Sdk sdk, object item, Type data)
    {
        var value = Sdk.Get(item, "Data");
        var seen = new JsonObject
        {
            ["data"] = value is string text ? JsonValue.Create(text) : JsonSerializer.SerializeToNode(value, sdk.Info(data)),
        };
        if (Sdk.Get(item, "Event") is string { Length: > 0 } name)
        {
            seen["event"] = name;
        }
        if (Sdk.Get(item, "Id") is string { Length: > 0 } id)
        {
            seen["id"] = id;
        }
        return seen;
    }

    /// <summary>
    /// <paramref name="reader"/>'s items, each to <paramref name="each"/>, until <paramref name="take"/> (absent: the
    /// end), then the enumeration left as <c>await foreach</c> leaves it; the error that ended the reads, the
    /// enumerator then left as it is.
    /// </summary>
    private static async Task<Exception?> ReadAsync(Reader reader, int? take, Action<object> each)
    {
        for (var read = 0; take is null || read < take; read++)
        {
            bool more;
            try
            {
                more = await reader.MoveNextAsync();
            }
            catch (Exception e) when (e is not DriverException)
            {
                return e;
            }
            if (!more)
            {
                break;
            }
            each(reader.Current ?? throw new DriverException("the stream yielded null"));
        }
        await reader.DisposeAsync();
        return null;
    }

    /// <summary>
    /// A <c>TypedWebSocket</c>: a recording handler per event under <c>ws.on</c>; the grid's <c>send</c> as text,
    /// then the script's, which a failure ends but not the reads (what the server sent first still waits to be
    /// read); <c>take</c> frames (absent: until the socket ends); then <c>ClosedBy</c>, and <c>CloseAsync</c> with
    /// the script's code and reason (1000 and none by default). The trace holds the frames read, the server's close,
    /// the close's failure and every handler run, those the driver's own close fires included.
    /// </summary>
    private static async Task<Outcome> FramesAsync(StreamCall at, object ws, WsScript script)
    {
        var handlers = new Handlers();
        if (script.On == true)
        {
            handlers.Attach(ws);
        }
        var messages = (at.Call.Send ?? []).Select(text => new WsSend(Text: text)).Concat(script.Send ?? []);
        var unsent = await SentAsync(ws, messages, Calls.Send);
        var read = new JsonArray();
        var unread = await ReceivedAsync(ws, at.Call.Take, read);
        var trace = new JsonObject { ["yields"] = read.Count };
        if (Sdk.Get(ws, "ClosedBy") is { } closed)
        {
            trace["closedBy"] = new JsonObject
            {
                ["code"] = Convert.ToInt32(Sdk.Get(closed, "Status")),
                ["reason"] = (string?)Sdk.Get(closed, "Reason"),
            };
        }
        var close = script.Close ?? new WsCode(1000, "");
        Type[] signature = [typeof(WebSocketCloseStatus), typeof(string), typeof(CancellationToken)];
        await Calls.Closed(ws, trace, signature, [(WebSocketCloseStatus)close.Code, close.Reason, CancellationToken.None]);
        if (handlers.Runs() is { Count: > 0 } runs)
        {
            trace["handlers"] = runs;
        }
        return Streamed(at, new JsonObject { ["frames"] = read, ["kind"] = "frames" }, unsent ?? unread, trace);
    }

    /// <summary>Each of <paramref name="messages"/> sent by <paramref name="send"/>, in order; the first send error, which ends them.</summary>
    private static async Task<Exception?> SentAsync<T>(object target, IEnumerable<T> messages, Func<object, T, Task> send)
    {
        try
        {
            foreach (var message in messages)
            {
                await send(target, message);
            }
            return null;
        }
        catch (Exception e) when (e is not DriverException)
        {
            return e;
        }
    }

    /// <summary>Frames read into <paramref name="read"/> until <paramref name="take"/> (absent: until null); the error that ended them.</summary>
    private static async Task<Exception?> ReceivedAsync(object ws, int? take, JsonArray read)
    {
        try
        {
            while (take is null || read.Count < take)
            {
                var message = await Invoke.ResultAsync(ws, Calls.Method(ws, "ReceiveAsync", [typeof(CancellationToken)]), [CancellationToken.None]);
                if (message is null)
                {
                    break;
                }
                read.Add(Observe.BodyOf((byte[])Sdk.Get(message, "Data")!));
            }
            return null;
        }
        catch (Exception e) when (e is not DriverException)
        {
            return e;
        }
    }

    /// <summary>
    /// A <c>ResumableConnection&lt;T&gt;</c>: each grid <c>send</c> as its JSON value through the SDK's JSON overload,
    /// else as text, until the first error; then <c>take</c> values read by enumeration (Protocol.cs refuses a
    /// realtime call without one), a read error also kept in <c>realtime.errors</c>; a connection that ends first
    /// ends them quietly. Then <c>CloseAsync</c>, and the trace: the frames, the cursor <c>Options</c> settled on
    /// (null as ""), the proven transport and the read errors.
    /// </summary>
    private static async Task<Outcome> LiveAsync(StreamCall at, object conn)
    {
        var failure = await SentAsync(conn, at.Call.Send ?? [], (target, text) => Calls.TryParse(text, out var node)
            ? Calls.SendJson(target, node)
            : Calls.Run(target, "SendAsync", [typeof(string), typeof(CancellationToken)], [text, CancellationToken.None]));
        var (read, errors) = (new JsonArray(), new JsonArray());
        if (failure is null)
        {
            var reader = Reader.Of(conn);
            failure = await ReadAsync(reader, at.Call.Take, item => read.Add(JsonSerializer.SerializeToNode(item, at.Sdk.Info(reader.Element))));
            if (failure is not null)
            {
                errors.Add(failure.Message);
            }
        }
        var trace = new JsonObject { ["yields"] = read.Count };
        await Calls.Closed(conn, trace, [], []);
        var options = Sdk.Get(conn, "Options")!;
        trace["realtime"] = new JsonObject
        {
            ["cursor"] = new JsonObject
            {
                ["lastEventId"] = (string?)Sdk.Get(options, "LastEventId") ?? "",
                ["reconnectToken"] = (string?)Sdk.Get(options, "ReconnectToken") ?? "",
            },
            ["errors"] = errors,
            ["proven"] = Sdk.Get(conn, "ProvenTransport")?.ToString()?.ToLowerInvariant(),
        };
        /* a connection whose first read failed, refused before any frame, ends in its open's error: the grid's error or timeout */
        if (read.Count == 0 && errors.Count > 0 && Observe.Graded(at.Sdk, failure!, at.Lens.Raw) is { } refused)
        {
            var traced = at.Lens.Scripted ? Traces.ErrorOf(at.Sdk, failure!, "stream", at.Lens.Envelope) : null;
            return new Outcome(refused, traced, Stream: trace);
        }
        return Streamed(at, new JsonObject { ["frames"] = read, ["kind"] = "frames" }, failure, trace);
    }
}
