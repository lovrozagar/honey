using System.Collections;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Honey.Driver;

/// <summary>
/// What a scripted run prints beside the observed (protocol.ts <c>Trace&lt;CsError&gt;</c>): each call's time, its
/// error read through the exception's members and a safe-mode <c>SdkResult</c>'s summary; every hook run with what
/// its context held; every <c>OnLog</c> entry; and the <c>OnAuthExpired</c> calls. Every member is read by
/// reflection: the driver holds no reference to any SDK.
/// </summary>
internal sealed class Recorder
{
    private readonly JsonArray calls = [];
    private readonly JsonArray hooks = [];
    private int expired;

    /// <summary>The call hooks run for.</summary>
    public int Current { get; set; }

    /// <summary>Every <c>OnLog</c> entry, in order.</summary>
    public JsonArray Log { get; } = [];

    /// <summary>Records the call that just ended after <paramref name="elapsedMs"/>.</summary>
    public void Called(long elapsedMs, Outcome outcome)
    {
        var entry = new JsonObject { ["elapsedMs"] = elapsedMs };
        if (outcome.Error is { } error)
        {
            entry["error"] = error;
        }
        if (outcome.Result is { } result)
        {
            entry["result"] = result;
        }
        if (outcome.Stream is { } stream)
        {
            entry["stream"] = stream;
        }
        calls.Add(entry);
    }

    /// <summary>Records one hook run for the current call.</summary>
    public void Hook(JsonObject entry)
    {
        entry["call"] = Current;
        hooks.Add(entry);
    }

    /// <summary><c>OnAuthExpired</c>: the n-th refresh answers <c>tokens[n-1]</c>, and throws past the end.</summary>
    public Func<CancellationToken, Task<string?>> Refresher(IReadOnlyList<string> tokens) => _ =>
    {
        expired++;
        return expired > tokens.Count
            ? Task.FromException<string?>(new InvalidOperationException("driver: no token left"))
            : Task.FromResult<string?>(tokens[expired - 1]);
    };

    /// <summary>The trace, every list present even when empty.</summary>
    public JsonObject Trace() =>
        new() { ["authExpired"] = expired, ["calls"] = calls, ["hooks"] = hooks, ["log"] = Log };

    /// <summary>What every hook run records of its context: the retry and stale fields.</summary>
    public static JsonObject Seen(string phase, int index, object ctx) => new()
    {
        ["index"] = index,
        ["invalidatedBy"] = new JsonArray([.. ((IEnumerable<string>)Sdk.Get(ctx, "InvalidatedBy")!).Select(s => JsonValue.Create(s))]),
        ["isRetry"] = (bool)Sdk.Get(ctx, "IsRetry")!,
        ["isStale"] = (bool)Sdk.Get(ctx, "IsStale")!,
        ["phase"] = phase,
        ["selector"] = (string?)Sdk.Get(ctx, "Selector"),
    };
}

/// <summary>The <paramref name="index"/>-th request hook: it records what it saw, sets its header, then throws.</summary>
internal sealed class RequestRecorder(int index, RequestHook entry, Recorder recorder)
{
    public Task RunAsync(object ctx, CancellationToken cancellationToken)
    {
        var url = Traces.UrlOf(Sdk.Get(ctx, "Url"));
        var seen = Recorder.Seen("request", index, ctx);
        seen["method"] = (string?)Sdk.Get(ctx, "Method");
        seen["path"] = new Uri(url).AbsolutePath;
        seen["url"] = url;
        recorder.Hook(seen);
        if (entry.SetHeader is [var name, var value])
        {
            ((IDictionary<string, string>)Sdk.Get(ctx, "Headers")!)[name] = value;
        }
        return entry.Fail is { } fail ? Task.FromException(new InvalidOperationException(fail)) : Task.CompletedTask;
    }
}

/// <summary>The <paramref name="index"/>-th response hook: it records what it saw, replaces the body, then throws.</summary>
internal sealed class ResponseRecorder(int index, ResponseHook entry, Recorder recorder)
{
    public Task RunAsync(object ctx, CancellationToken cancellationToken)
    {
        var seen = Recorder.Seen("response", index, ctx);
        seen["status"] = Convert.ToInt32(Sdk.Get(ctx, "Status"));
        recorder.Hook(seen);
        if (entry.Body is { } body)
        {
            Sdk.Set(ctx, "Body", Encoding.UTF8.GetBytes(body));
        }
        return entry.Fail is { } fail ? Task.FromException(new InvalidOperationException(fail)) : Task.CompletedTask;
    }
}

/// <summary><c>OnLog</c>: each entry recorded, with its duration under <c>logDurations</c> (a default trace stays exact).</summary>
internal sealed class LogRecorder(bool durations, Recorder recorder)
{
    public void Log(object entry)
    {
        var seen = new JsonObject
        {
            ["event"] = (string?)Sdk.Get(entry, "Event"),
            ["level"] = (string?)Sdk.Get(entry, "Level"),
            ["operation"] = (string?)Sdk.Get(entry, "Operation"),
        };
        if (Sdk.Get(entry, "Status") is { } status)
        {
            seen["status"] = Convert.ToInt32(status);
        }
        if (Sdk.Get(entry, "Error") is string error)
        {
            seen["error"] = error;
        }
        if (durations)
        {
            seen["durationMs"] = Convert.ToInt64(Sdk.Get(entry, "DurationMs"));
        }
        recorder.Log.Add(seen);
    }
}

/// <summary>
/// A call's error and a safe-mode result as the trace records them (protocol.ts <c>CsError</c>): <c>via</c> is
/// <c>"return"</c> for the method's throw, <c>"result"</c> for a safe-mode error, <c>"stream"</c> for one a stream threw.
/// </summary>
internal static class Traces
{
    /* the envelope's text members, in protocol.ts order after `status` */
    private static readonly string[] EnvelopeTexts = ["ErrorKey", "StatusKey", "Message"];

    /// <summary>
    /// <paramref name="error"/> as the trace records it; an <c>ApiStatusException</c> adds its status, key, key
    /// constant and detail, and its envelope when <paramref name="envelope"/>.
    /// </summary>
    public static JsonObject ErrorOf(Sdk sdk, Exception error, string via, bool envelope)
    {
        var type = error.GetType();
        var honey = sdk.Type("HoneyException");
        var chain = new JsonArray();
        for (var at = type; at is not null; at = at.BaseType)
        {
            chain.Add(at.Name);
            if (at == honey || !honey.IsInstanceOfType(error))
            {
                break;
            }
        }
        var display = error.ToString().Split('\n').TakeWhile(line => !line.StartsWith("   at ", StringComparison.Ordinal));
        var seen = new JsonObject
        {
            ["type"] = type.Name,
            ["chain"] = chain,
            ["text"] = error.Message,
            ["display"] = string.Join("\n", display),
            ["via"] = via,
            ["inner"] = error.InnerException?.GetType().Name,
            ["canceled"] = error is OperationCanceledException,
        };
        if (sdk.Is(error, "ApiStatusException"))
        {
            StatusOf(seen, sdk, error, envelope);
        }
        return seen;
    }

    /// <summary>An <c>ApiStatusException</c>'s members into <paramref name="seen"/>.</summary>
    private static void StatusOf(JsonObject seen, Sdk sdk, Exception error, bool envelope)
    {
        var key = (string?)Sdk.Get(error, "Key");
        /* ErrorKey is emitted only when the API declares a key (Fc3) */
        var constant = sdk.Find("ErrorKey")?.GetFields(BindingFlags.Public | BindingFlags.Static)
            .FirstOrDefault(field => field.IsLiteral && (string?)field.GetRawConstantValue() == key);
        seen["status"] = Convert.ToInt32(Sdk.Get(error, "Status"));
        seen["key"] = key;
        seen["keyMember"] = key is null ? null : constant?.Name;
        seen["message"] = (string?)Sdk.Get(error, "Detail");
        if (envelope)
        {
            seen["envelope"] = EnvelopeOf(Sdk.Get(error, "Envelope")!);
        }
    }

    /// <summary>An <c>ErrorEnvelope</c>'s members that are set (<c>fields</c> when not empty), and its extra keys sorted.</summary>
    private static JsonObject EnvelopeOf(object envelope)
    {
        var seen = new JsonObject();
        if (Sdk.Get(envelope, "Status") is { } status)
        {
            seen["status"] = Convert.ToInt32(status);
        }
        foreach (var member in EnvelopeTexts)
        {
            if (Sdk.Get(envelope, member) is string value)
            {
                seen[JsonNamingPolicy.SnakeCaseLower.ConvertName(member)] = value;
            }
        }
        var fields = new JsonObject();
        foreach (var pair in (IEnumerable)Sdk.Get(envelope, "Fields")!)
        {
            var list = (IEnumerable)Sdk.Get(pair, "Value")!;
            fields[(string)Sdk.Get(pair, "Key")!] = new JsonArray([.. list.Cast<object>().Select(FieldOf)]);
        }
        if (fields.Count > 0)
        {
            seen["fields"] = fields;
        }
        var extra = ((IReadOnlyDictionary<string, JsonElement>)Sdk.Get(envelope, "Extra")!).Keys.Order(StringComparer.Ordinal);
        seen["extraKeys"] = new JsonArray([.. extra.Select(name => JsonValue.Create(name))]);
        return seen;
    }

    private static JsonNode FieldOf(object field) => new JsonObject
    {
        ["error_key"] = (string?)Sdk.Get(field, "ErrorKey"),
        ["message"] = (string?)Sdk.Get(field, "Message"),
        ["path"] = (string?)Sdk.Get(field, "Path"),
    };

    /// <summary>A safe-mode <c>SdkResult</c>: whether it holds data, whether it is a 2xx, whether its response carries its status, and its status.</summary>
    public static JsonObject ResultOf(object result)
    {
        var status = Convert.ToInt32(Sdk.Get(result, "Status"));
        var data = result.GetType().IsGenericType && Sdk.Get(result, "Data") is not null;
        return new JsonObject
        {
            ["data"] = data,
            ["ok"] = (bool)Sdk.Get(result, "IsSuccess")!,
            ["response"] = Convert.ToInt32(Sdk.Get(Sdk.Get(result, "Response")!, "Status")) == status,
            ["status"] = status,
        };
    }

    /// <summary>A context's URL as sent: a <c>Uri</c>'s escaped form, or the string as it is.</summary>
    public static string UrlOf(object? url) => url switch
    {
        Uri uri => uri.AbsoluteUri,
        string text => text,
        _ => throw new DriverException($"a hook context's Url is {url?.GetType().Name ?? "null"}, not a Uri or a string"),
    };
}
