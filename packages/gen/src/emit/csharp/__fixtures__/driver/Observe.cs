using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Honey.Driver;

/// <summary>What a method returned: its declared return type, the task's result (null without one), and the filled raw response.</summary>
internal sealed record Answer(Type Declared, object? Result, object Raw);

/// <summary>
/// A call's outcome as the grid observes it. A result is <c>data</c>, written back through the SDK's context, with
/// the raw response's status, or <c>raw</c> when the call asks for it; an operation with no typed answer observes
/// its raw body (JSON, else text, else null). A safe-mode <c>SdkResult</c> observes its data or its error. An
/// <c>ApiStatusException</c> is <c>error</c> with its status, no key until phase c, and its body (JSON, else its
/// text); an <c>ApiTimeoutException</c> is <c>timeout</c>. A cancel ends the run in phase b (R4: phases c and d
/// observe it), and so does any other exception, named by its type.
/// </summary>
internal static class Observe
{
    /// <summary>A method's answer as observed: a safe-mode result by its error or data, anything else as data.</summary>
    public static JsonNode Returned(Sdk sdk, Answer answer, Plan plan, bool raw)
    {
        if (plan.Throws)
        {
            var type = answer.Declared.IsGenericType ? answer.Declared.GetGenericArguments()[0] : null;
            return Answered(sdk, answer with { Declared = type ?? typeof(void) }, plan, raw);
        }
        var result = answer.Result ?? throw new DriverException("the safe-mode method returned no SdkResult");
        if (Sdk.Get(result, "Error") is Exception error)
        {
            return Thrown(sdk, error, raw);
        }
        var generic = result.GetType().IsGenericType;
        var data = generic ? Sdk.Get(result, "Data") : null;
        var declared = generic ? result.GetType().GetGenericArguments()[0] : typeof(void);
        return Answered(sdk, answer with { Declared = declared, Result = data }, plan, raw);
    }

    /// <summary>
    /// A call that threw <paramref name="error"/>: a status error or a timeout as the grid observes it, else a
    /// DriverException naming what the grid has no outcome for.
    /// </summary>
    public static JsonNode Thrown(Sdk sdk, Exception error, bool raw)
    {
        if (sdk.Is(error, "ApiStatusException"))
        {
            var status = Convert.ToInt32(Sdk.Get(error, "Status"));
            var body = (byte[])Sdk.Get(error, "Body")!;
            if (raw)
            {
                return RawOf(status, Sdk.Get(error, "Headers"), body);
            }
            var seen = new JsonObject { ["errorKey"] = null, ["kind"] = "error", ["status"] = status };
            if (body.Length > 0)
            {
                seen["body"] = BodyOf(body);
            }
            return seen;
        }
        if (sdk.Is(error, "ApiTimeoutException"))
        {
            return new JsonObject { ["kind"] = "timeout" };
        }
        if (error is OperationCanceledException)
        {
            throw new DriverException($"the call was canceled ({error.GetType().Name}), which phase b does not observe");
        }
        throw new DriverException($"the call threw {error.GetType().Name}, which the grid has no outcome for: {error.Message}");
    }

    /// <summary>A 2xx answer: the raw response, or the data (the raw body's when the operation has no typed answer).</summary>
    private static JsonNode Answered(Sdk sdk, Answer answer, Plan plan, bool raw)
    {
        var status = Convert.ToInt32(Sdk.Get(answer.Raw, "Status"));
        var body = (byte[])Sdk.Get(answer.Raw, "Body")!;
        if (raw)
        {
            return RawOf(status, Sdk.Get(answer.Raw, "Headers"), body);
        }
        var data = plan.Response switch
        {
            "none" => body.Length == 0 ? null : BodyOf(body),
            "text" => JsonValue.Create((string?)answer.Result),
            "json" => answer.Result is null ? null : JsonSerializer.SerializeToNode(answer.Result, sdk.Info(answer.Declared)),
            _ => throw new DriverException($"a {plan.Response} answer is not one phase b observes"),
        };
        return new JsonObject { ["data"] = data, ["kind"] = "data", ["status"] = status };
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
    private static JsonNode? BodyOf(byte[] body)
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
