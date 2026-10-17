using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Honey.Driver;

/// <summary>
/// The binding core (Fb10): one call sent by its plan, nothing generated. The method is found from the client
/// through each of the plan's <c>accessors</c> by <c>GetProperty</c>, then by <c>GetMethod(plan.method)</c>. Each
/// parameter binds by its name: a path param from the call's <c>params</c>, the body from its JSON value, a query
/// param from <c>search</c> and a header param from the call's headers, each value deserialized through the SDK
/// context's metadata for the parameter's declared type (a string into a string parameter as it is). A call
/// header no param declares goes in <c>RequestOptions.Headers</c> (F6); the options also carry the call's
/// timeout, the alt origin's base URL, and always a <c>RawResponse</c> to read. The cancellation token is
/// <c>default</c> in phase b. The method runs with <c>DoNotWrapExceptions</c>, so the SDK's own exception
/// arrives, and a result is read only when the declared return type is generic (P5).
/// </summary>
internal static class Invoke
{
    /// <summary><paramref name="call"/> sent on <paramref name="client"/> and observed (Observe.cs).</summary>
    public static async Task<JsonNode?> CallAsync(Sdk sdk, object client, Envelope envelope, Call call)
    {
        var plan = envelope.Plans[call.Operation];
        var target = plan.Accessors.Aggregate(client, (at, name) => Sdk.Get(at, name)
            ?? throw new DriverException($"{at.GetType().Name}.{name} is null"));
        var method = target.GetType().GetMethod(plan.Method)
            ?? throw new DriverException($"{target.GetType().Name} has no method {plan.Method}");
        var raw = sdk.Create("RawResponse");
        var options = Options(sdk, envelope, call, raw, out var given);
        var args = method.GetParameters().Select(p => Argument(sdk, p, given, options)).ToArray();
        object? result;
        try
        {
            var task = method.Invoke(target, BindingFlags.DoNotWrapExceptions, null, args, null) as Task
                ?? throw new DriverException($"{plan.Method} returned no Task");
            await task;
            result = method.ReturnType.IsGenericType ? method.ReturnType.GetProperty("Result")!.GetValue(task) : null;
        }
        catch (Exception e) when (e is not DriverException)
        {
            return Observe.Thrown(sdk, e, call.Raw == true);
        }
        return Observe.Returned(sdk, new Answer(method.ReturnType, result, raw), plan, call.Raw == true);
    }

    /// <summary>
    /// The call's <c>RequestOptions</c>, and every value it gives a parameter, by parameter name: path params,
    /// the body, query params, and the call headers a param declares.
    /// </summary>
    private static object Options(Sdk sdk, Envelope envelope, Call call, object raw, out Dictionary<string, JsonNode?> given)
    {
        var plan = envelope.Plans[call.Operation];
        given = [];
        foreach (var path in plan.Path)
        {
            var value = call.Params?.GetValueOrDefault(path.Name)
                ?? throw new DriverException($"the call has no path param {path.Name}");
            given[path.Param] = JsonValue.Create(value);
        }
        if (call.Body is { } body)
        {
            var param = plan.Body?.Param ?? throw new DriverException("the call sends a body, and the method takes none");
            given[param] = body.Value;
        }
        foreach (var (name, value) in call.Search ?? [])
        {
            given[plan.Query.GetValueOrDefault(name) ?? throw new DriverException($"the method declares no query param {name}")] = value;
        }
        var declared = plan.Headers.ToDictionary(h => h.Key.ToLowerInvariant(), h => h.Value);
        var extra = new Dictionary<string, string>();
        foreach (var (name, value) in call.Headers ?? [])
        {
            if (declared.TryGetValue(name.ToLowerInvariant(), out var param))
            {
                given[param] = JsonValue.Create(value);
            }
            else
            {
                extra[name] = value;
            }
        }
        return RequestOptions(sdk, envelope, call, raw, extra);
    }

    /// <summary>The call's timeout, its undeclared headers, the alt origin's base URL, and the raw response to fill.</summary>
    private static object RequestOptions(Sdk sdk, Envelope envelope, Call call, object raw, Dictionary<string, string> extra)
    {
        var options = sdk.Create("RequestOptions");
        Sdk.Set(options, "Raw", raw);
        if (call.TimeoutMs is { } ms)
        {
            Sdk.Set(options, "Timeout", TimeSpan.FromMilliseconds(ms));
        }
        if (extra.Count > 0)
        {
            Sdk.Set(options, "Headers", extra);
        }
        switch (call.Origin)
        {
            case null:
                break;
            case "alt":
                Sdk.Set(options, "BaseUrl", envelope.Alt ?? throw new DriverException("the call's origin is alt, and the run has none"));
                break;
            default:
                throw new DriverException($"origin {call.Origin} is not one the driver knows");
        }
        return options;
    }

    /// <summary>
    /// Parameter <paramref name="p"/>'s argument: the options, the token, a given value through the SDK's context,
    /// or the parameter's default; a required one with no value is a DriverException.
    /// </summary>
    private static object? Argument(Sdk sdk, ParameterInfo p, Dictionary<string, JsonNode?> given, object options)
    {
        if (p.ParameterType == typeof(CancellationToken))
        {
            return CancellationToken.None;
        }
        if (p.ParameterType == options.GetType())
        {
            return options;
        }
        if (given.TryGetValue(p.Name!, out var node))
        {
            /* a string is a string: a path param binds without a context entry the API may not need */
            if (p.ParameterType == typeof(string) && node is JsonValue value && value.TryGetValue<string>(out var text))
            {
                return text;
            }
            try
            {
                return node.Deserialize(sdk.Info(p.ParameterType));
            }
            catch (JsonException e)
            {
                throw new DriverException($"argument {p.Name}: {e.Message}");
            }
        }
        return p.HasDefaultValue ? p.DefaultValue : throw new DriverException($"the call gives no value for {p.Name}");
    }
}
