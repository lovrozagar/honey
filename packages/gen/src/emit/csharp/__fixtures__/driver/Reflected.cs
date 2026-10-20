using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;

namespace Honey.Driver;

/// <summary>
/// An SDK stream's <c>IAsyncEnumerable&lt;T&gt;</c> read by reflection, whatever <c>T</c> is (a value type such as
/// <c>JsonElement</c> included, which no covariant cast reaches): its enumerator, taken with no token, and the
/// element type.
/// </summary>
internal sealed class Reader(object enumerator, Type face)
{
    /// <summary>The enumeration's element type: <c>SseEvent&lt;T&gt;</c>, or a realtime connection's <c>T</c>.</summary>
    public Type Element => face.GetGenericArguments()[0];

    /// <summary><paramref name="enumerable"/>'s enumerator, by its <c>IAsyncEnumerable&lt;T&gt;</c> interface.</summary>
    public static Reader Of(object enumerable)
    {
        var source = enumerable.GetType().GetInterfaces()
            .FirstOrDefault(type => type.IsGenericType && type.GetGenericTypeDefinition() == typeof(IAsyncEnumerable<>))
            ?? throw new DriverException($"{enumerable.GetType().Name} is no IAsyncEnumerable<T>");
        var enumerator = source.GetMethod("GetAsyncEnumerator")!
            .Invoke(enumerable, BindingFlags.DoNotWrapExceptions, null, [CancellationToken.None], null)!;
        return new Reader(enumerator, typeof(IAsyncEnumerator<>).MakeGenericType(source.GetGenericArguments()[0]));
    }

    public ValueTask<bool> MoveNextAsync() =>
        (ValueTask<bool>)face.GetMethod("MoveNextAsync")!.Invoke(enumerator, BindingFlags.DoNotWrapExceptions, null, [], null)!;

    public object? Current => face.GetProperty("Current")!.GetValue(enumerator);

    public ValueTask DisposeAsync() => ((IAsyncDisposable)enumerator).DisposeAsync();
}

/// <summary>
/// The recording handlers <c>ws.on</c> attaches to a <c>TypedWebSocket</c>'s <c>Message</c>, <c>Closed</c> and
/// <c>Error</c> events, each bound to the SDK's own delegate type by reflection (a delegate binds its parameter
/// contravariantly): every run in firing order, with a message's data as UTF-8 (U+FFFD for an invalid sequence), a
/// close's reason, or an error's message.
/// </summary>
internal sealed class Handlers
{
    private readonly List<(string Event, string Data)> runs = [];

    /// <summary>Attaches one recorder per event to <paramref name="ws"/>.</summary>
    public void Attach(object ws)
    {
        foreach (var name in new[] { nameof(Message), nameof(Closed), nameof(Error) })
        {
            var info = ws.GetType().GetEvent(name) ?? throw new DriverException($"{ws.GetType().Name} has no event {name}");
            info.AddEventHandler(ws, Delegate.CreateDelegate(info.EventHandlerType!, this, typeof(Handlers).GetMethod(name)!));
        }
    }

    public void Message(object message) => Add("message", Encoding.UTF8.GetString((byte[])Sdk.Get(message, "Data")!));

    public void Closed(object close) => Add("close", (string?)Sdk.Get(close, "Reason") ?? "");

    public void Error(object error) => Add("error", ((Exception)error).Message);

    /// <summary>The runs so far, as the trace's <c>handlers</c>.</summary>
    public JsonArray Runs()
    {
        lock (runs)
        {
            return new JsonArray([.. runs.Select(run => new JsonObject { ["data"] = run.Data, ["event"] = run.Event })]);
        }
    }

    /* an event fires on whichever thread ended the read or the close */
    private void Add(string name, string data)
    {
        lock (runs)
        {
            runs.Add((name, data));
        }
    }
}

/// <summary>
/// What a stream call runs on what it opened, by reflection over the SDK's own types: a send by its kind, a close
/// whose failure the trace records, and any public method, awaited with the SDK's own exception unwrapped.
/// </summary>
internal static class Calls
{
    /// <summary>A scripted message by its kind: text, that many bytes <c>i &amp; 0xff</c>, or a JSON value through the SDK's JSON overload.</summary>
    public static Task Send(object ws, WsSend message) => message switch
    {
        { Text: { } text } => Run(ws, "SendAsync", [typeof(string), typeof(CancellationToken)], [text, CancellationToken.None]),
        { Bytes: { } size } => Run(ws, "SendAsync", [typeof(byte[]), typeof(CancellationToken)],
            [Enumerable.Range(0, size).Select(i => (byte)(i & 0xff)).ToArray(), CancellationToken.None]),
        _ => SendJson(ws, message.Json),
    };

    /// <summary>
    /// <paramref name="value"/> through the target's <c>SendAsync&lt;T&gt;(T, JsonTypeInfo&lt;T&gt;, CancellationToken)</c>
    /// as a <c>JsonNode</c>: the driver is not AOT, so the BCL's reflection metadata serves it.
    /// </summary>
    public static async Task SendJson(object target, JsonNode? value)
    {
        var generic = target.GetType().GetMethods().SingleOrDefault(m => m.Name == "SendAsync" && m.IsGenericMethodDefinition)
            ?? throw new DriverException($"{target.GetType().Name} has no generic SendAsync");
        var info = (JsonTypeInfo<JsonNode>)JsonSerializerOptions.Default.GetTypeInfo(typeof(JsonNode));
        await Invoke.ResultAsync(target, generic.MakeGenericMethod(typeof(JsonNode)), [value, info, CancellationToken.None]);
    }

    /// <summary>Whether <paramref name="text"/> is JSON, and its value (a JSON null included).</summary>
    public static bool TryParse(string text, out JsonNode? value)
    {
        try
        {
            value = JsonNode.Parse(text);
            return true;
        }
        catch (JsonException)
        {
            value = null;
            return false;
        }
    }

    /// <summary><c>CloseAsync</c> on <paramref name="target"/> with <paramref name="args"/>; its failure into the trace as <c>closeError</c>.</summary>
    public static async Task Closed(object target, JsonObject trace, Type[] signature, object?[] args)
    {
        try
        {
            await Run(target, "CloseAsync", signature, args);
        }
        catch (Exception e) when (e is not DriverException)
        {
            trace["closeError"] = e.Message;
        }
    }

    /// <summary><paramref name="target"/>'s public method <paramref name="name"/> taking <paramref name="signature"/>.</summary>
    public static MethodInfo Method(object target, string name, Type[] signature) =>
        target.GetType().GetMethod(name, signature)
            ?? throw new DriverException($"{target.GetType().Name} has no {name}({string.Join(", ", signature.Select(t => t.Name))})");

    public static Task Run(object target, string name, Type[] signature, object?[] args) =>
        Invoke.ResultAsync(target, Method(target, name, signature), args);
}
