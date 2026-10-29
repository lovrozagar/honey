using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Honey.Driver;

/// <summary>What a method returned: its declared return type, the task's result (null without one), and the filled raw response.</summary>
internal sealed record Answer(Type Declared, object? Result, object Raw);

/// <summary>
/// How one call is observed: whether it asks for the raw response, whether a script traces it, whether the trace
/// takes an <c>ApiStatusException</c>'s envelope, and the <c>&lt;Op&gt;Headers</c> holder the call passed (null for none).
/// </summary>
internal sealed record Lens(bool Raw, bool Scripted, bool Envelope, object? Holder = null);

/// <summary>
/// What a call observed (null when the grid has no outcome for it), its traced error, a safe-mode result's summary,
/// and a stream call's trace (protocol.ts <c>StreamTrace</c>).
/// </summary>
internal sealed record Outcome(JsonNode? Observed, JsonObject? Error = null, JsonObject? Result = null, JsonObject? Stream = null);

/// <summary>
/// A call's outcome as the grid observes it, and as a script traces it. A result is <c>data</c>, written back
/// through the SDK's context, with the raw response's status and the typed response headers the holder got; a
/// binary answer is <c>bytes</c>, its size and SHA-256; <c>raw</c> when the call asks for it. An operation with no
/// typed answer observes its raw body (JSON, else text, else null). A <c>client.Safe</c> call's <c>Result</c> (bit 21
/// i5) is read strictly: an answer it throws, a Result whose response is not the call's own, an Ok on no 2xx and an
/// Err whose response is not its error's each fail the run; its Ok observes its value as a normal call's answer,
/// its Err its error. An <c>ApiStatusException</c> is <c>error</c> with its status, its <c>Key</c> and its body (JSON,
/// else its text); an <c>ApiTimeoutException</c> is <c>timeout</c>. Unscripted, an <c>ApiConnectionException</c> is
/// <c>transport</c> (no answer, f2) and a <c>DecodeException</c> is <c>decode</c> with the filled raw response's
/// status (bit 21 i0); any other exception ends the run, named by its type. Under a script, a call's error is traced too (<c>via: "return"</c>, or <c>"result"</c> for a
/// safe call's <c>Result</c> Err, with the result's summary), and one the grid has no outcome for (a cancel, a
/// hook's, a decode, a connection or a config error) observes null. A stream call's reads are Stream.cs's.
/// </summary>
internal static class Observe
{
    /// <summary>A normal method's answer as observed: its task's result as data.</summary>
    public static Outcome Returned(Sdk sdk, Answer answer, Plan plan, Lens lens)
    {
        if (sdk.Find("Result") is { } result && result.IsInstanceOfType(answer.Result))
        {
            throw new DriverException($"the normal call answered a Result: {answer.Declared}");
        }
        var type = answer.Declared.IsGenericType ? answer.Declared.GetGenericArguments()[0] : null;
        return new Outcome(Answered(sdk, answer with { Declared = type ?? typeof(void) }, plan, lens));
    }

    /// <summary>A safe call's Result, read strictly (Settle): its Ok as a normal call's answer, its Err as its error.</summary>
    public static Outcome Safe(Sdk sdk, object? result, object raw, Plan plan, Lens lens)
    {
        var settled = Settle(sdk, result, raw, lens);
        if (settled.Err is { } err)
        {
            return err;
        }
        var generic = result!.GetType().IsGenericType;
        var declared = generic ? result.GetType().GetGenericArguments()[0] : typeof(void);
        var answer = new Answer(declared, settled.Value, raw);
        return new Outcome(Answered(sdk, answer, plan, lens), null, settled.Summary);
    }

    /// <summary>
    /// A safe call's <paramref name="result"/>, its response held to <paramref name="raw"/> (the box the call passed):
    /// its Ok's value (null for an operation with none), or the Outcome its Err observes; anything else fails the
    /// run, as does an Ok on no 2xx and an Err whose response is not its error's.
    /// </summary>
    public static (object? Value, Outcome? Err, JsonObject? Summary) Settle(Sdk sdk, object? result, object raw, Lens lens)
    {
        if (result is null || !sdk.Is(result, "Result"))
        {
            throw new DriverException($"the safe call answered no Result: {result?.GetType().Name ?? "null"}");
        }
        var response = Sdk.Get(result, "Response") ?? throw new DriverException("a Result without its response");
        var status = Convert.ToInt32(Sdk.Get(response, "Status"));
        if (!ReferenceEquals(response, raw))
        {
            throw new DriverException($"a Result whose response ({status}) is not the call's answer");
        }
        var summary = lens.Scripted ? Traces.ResultOf(sdk, result) : null;
        if ((bool)Sdk.Get(result, "IsOk")!)
        {
            if (status is < 200 or >= 300)
            {
                throw new DriverException($"a Result Ok whose response ({status}) is no 2xx");
            }
            return (result.GetType().IsGenericType ? Sdk.Get(result, "Value") : null, null, summary);
        }
        var error = (Exception)Sdk.Get(result, "Error")!;
        var held = sdk.Is(error, "ApiStatusException") ? Convert.ToInt32(Sdk.Get(error, "Status")) == status
            : sdk.Is(error, "DecodeException") && status is >= 200 and < 300;
        if (!held)
        {
            throw new DriverException($"a Result Err whose response ({status}) is not its error's: {error.GetType().Name}: {error.Message}");
        }
        var traced = lens.Scripted ? Traces.ErrorOf(sdk, error, "result", lens.Envelope) : null;
        var seen = sdk.Is(error, "DecodeException") ? Undecodable(response) : StatusOf(sdk, error, lens.Raw);
        return (null, new Outcome(seen, traced, summary), summary);
    }

    /// <summary>
    /// A safe call that threw <paramref name="error"/>: an answer (an error status, a decode) fails the run, since a
    /// safe call returns it; anything else is no answer, observed as a normal call's (f2).
    /// </summary>
    public static Outcome ThrownSafe(Sdk sdk, Exception error, Lens lens) =>
        sdk.Is(error, "SdkException")
            ? throw new DriverException($"the safe call threw an API answer, not a Result: {error.GetType().Name}: {error.Message}")
            : Thrown(sdk, error, lens);

    /// <summary>
    /// A call that threw <paramref name="error"/>: traced under a script; unscripted, a status error, a timeout, no
    /// answer or an undecodable answer (its status read from <paramref name="raw"/>, the response the SDK filled before
    /// decoding) as the grid observes it, else a DriverException naming what the grid has no outcome for.
    /// </summary>
    public static Outcome Thrown(Sdk sdk, Exception error, Lens lens, object? raw = null)
    {
        var seen = Graded(sdk, error, lens.Raw);
        if (lens.Scripted)
        {
            return new Outcome(seen, Traces.ErrorOf(sdk, error, "return", lens.Envelope));
        }
        seen ??= NoAnswer(sdk, error) is { } failed ? new JsonObject { ["kind"] = failed }
            : sdk.Is(error, "DecodeException") && raw is not null ? Undecodable(raw)
            : null;
        return seen is null
            ? throw new DriverException($"the call threw {error.GetType().Name}, which the grid has no outcome for: {error.Message}")
            : new Outcome(seen);
    }

    /// <summary>A status error or a timeout as the grid observes it, else null.</summary>
    public static JsonNode? Graded(Sdk sdk, Exception error, bool raw) =>
        sdk.Is(error, "ApiStatusException") ? StatusOf(sdk, error, raw)
        : sdk.Is(error, "ApiTimeoutException") ? new JsonObject { ["kind"] = "timeout" }
        : null;

    /// <summary>What failed with no answer as the grid observes it (f2): <c>timeout</c>, <c>transport</c>, else null.</summary>
    public static string? NoAnswer(Sdk sdk, Exception error) =>
        sdk.Is(error, "ApiTimeoutException") ? "timeout"
        : sdk.Is(error, "ApiConnectionException") ? "transport"
        : null;

    /// <summary>A 2xx whose body did not decode: <c>decode</c> with the status the raw response holds, which a 2xx fills.</summary>
    private static JsonObject Undecodable(object raw)
    {
        var status = Convert.ToInt32(Sdk.Get(raw, "Status"));
        return status is >= 200 and < 300
            ? new JsonObject { ["kind"] = "decode", ["status"] = status }
            : throw new DriverException($"a DecodeException with a raw response of status {status}, not a 2xx");
    }

    /// <summary>
    /// An <c>ApiStatusException</c> as the grid observes it: its raw response, or its status, its <c>Key</c> and its
    /// body.
    /// </summary>
    private static JsonNode StatusOf(Sdk sdk, Exception error, bool raw)
    {
        var status = Convert.ToInt32(Sdk.Get(error, "Status"));
        var body = (byte[])Sdk.Get(error, "Body")!;
        if (raw)
        {
            return RawOf(status, Sdk.Get(error, "Headers"), body);
        }
        var key = (string?)Sdk.Get(error, "Key");
        var seen = new JsonObject { ["errorKey"] = key, ["kind"] = "error", ["status"] = status };
        if (body.Length > 0)
        {
            seen["body"] = BodyOf(body);
        }
        return seen;
    }

    /// <summary>A 2xx answer: the raw response, a binary answer's bytes, or the data (the raw body's when the operation has no typed answer).</summary>
    private static JsonNode Answered(Sdk sdk, Answer answer, Plan plan, Lens lens)
    {
        var status = Convert.ToInt32(Sdk.Get(answer.Raw, "Status"));
        var body = (byte[])Sdk.Get(answer.Raw, "Body")!;
        if (lens.Raw)
        {
            return RawOf(status, Sdk.Get(answer.Raw, "Headers"), body);
        }
        if (plan.Response == "binary")
        {
            var bytes = (byte[])answer.Result!;
            var sha = Convert.ToHexStringLower(SHA256.HashData(bytes));
            return new JsonObject { ["kind"] = "bytes", ["sha256"] = sha, ["size"] = bytes.Length, ["status"] = status };
        }
        var data = plan.Response switch
        {
            "none" => body.Length == 0 ? null : BodyOf(body),
            "text" => JsonValue.Create((string?)answer.Result),
            "json" => answer.Result is null ? null : JsonSerializer.SerializeToNode(answer.Result, sdk.Info(answer.Declared)),
            _ => throw new DriverException($"a {plan.Response} answer is not one the driver observes"),
        };
        var seen = new JsonObject { ["data"] = data, ["kind"] = "data", ["status"] = status };
        if (lens.Holder is { } holder && plan.ResponseHeaders is { } declared)
        {
            seen["headers"] = HeadersOf(holder, declared);
        }
        return seen;
    }

    /// <summary>
    /// The typed response headers the holder got, by each header's declared name, each value as its text (a number
    /// invariant, a bool <c>true</c>/<c>false</c>); an unset one is left out.
    /// </summary>
    public static JsonObject HeadersOf(object holder, PlanHeaders declared)
    {
        var seen = new JsonObject();
        foreach (var (name, property) in declared.Fields)
        {
            var text = Sdk.Get(holder, property) switch
            {
                null => null,
                bool flag => flag ? "true" : "false",
                IFormattable value => value.ToString(null, CultureInfo.InvariantCulture),
                var value => value.ToString(),
            };
            if (text is not null)
            {
                seen[name] = text;
            }
        }
        return seen;
    }

    /// <summary>The <c>raw</c> observed: the body as text, every header by its lower-case name.</summary>
    private static JsonObject RawOf(int status, object? headers, byte[] body)
    {
        var lower = new JsonObject();
        foreach (var (name, value) in (IEnumerable<KeyValuePair<string, string>>)headers!)
        {
            var key = name.ToLowerInvariant();
            lower[key] = lower[key] is { } seen ? $"{seen.GetValue<string>()}, {value}" : value;
        }
        return new JsonObject { ["body"] = Encoding.UTF8.GetString(body), ["headers"] = lower, ["kind"] = "raw", ["status"] = status };
    }

    /// <summary>A non-empty body's JSON, or its text when it is no JSON.</summary>
    public static JsonNode? BodyOf(byte[] body)
    {
        var text = Encoding.UTF8.GetString(body);
        try
        {
            return JsonNode.Parse(text);
        }
        catch (JsonException)
        {
            return JsonValue.Create(text);
        }
    }
}
