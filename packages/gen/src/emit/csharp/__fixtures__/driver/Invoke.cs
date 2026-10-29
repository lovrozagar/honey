using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Honey.Driver;

/// <summary>
/// The binding core (Fb10): one call sent by its plan, nothing generated. The method is found from the client (its
/// <c>Safe</c> mirror in the safe style, bit 21 i5) through each of the plan's <c>accessors</c> by
/// <c>GetProperty</c>, then by <c>GetMethod(plan.method)</c>. Each
/// parameter binds by its name: a path param from the call's <c>params</c>, a JSON, form or text body from its JSON
/// value, a query param from <c>search</c> and a header param from the call's headers, each value deserialized
/// through the SDK context's metadata for the parameter's declared type (a string into a string parameter as it
/// is). A binary body is <c>size</c> bytes <c>i &amp; 0xff</c> through <c>BinaryBody</c>'s implicit conversion from
/// <c>byte[]</c>, or under <c>oneShotBody</c> from a non-seekable <c>Stream</c> (Fc6). The script's
/// <c>idempotencyKey</c> is the plan's parameter, a plan with typed response headers gets a new holder as
/// <c>headersInto</c> (Fc7), and <c>cancel</c> is the method's <c>CancellationToken</c> alone. A stream method's own
/// fields bind by their fixed names (contract 50 §2, claimed before any declared param): <c>lastEventId</c> and
/// <c>reconnectToken</c> from the call, <c>protocols</c>, <c>maxReconnectAttempts</c> and <c>reconnectDelay</c> from
/// the script; a bound value no parameter takes fails the run. A call header no param declares goes in
/// <c>RequestOptions.Headers</c> (F6); the options also carry the call's timeout, a named origin's base URL, and
/// always a <c>RawResponse</c> to read. The method runs with <c>DoNotWrapExceptions</c>, so the SDK's own exception
/// arrives, and a result is read only when the declared return type is generic (P5). A stream plan's open and reads
/// are Stream.cs's.
/// </summary>
internal static class Invoke
{
    /// <summary><paramref name="call"/> sent on <paramref name="client"/> as <paramref name="entry"/> directs, and observed (Observe.cs).</summary>
    public static async Task<Outcome> CallAsync(Sdk sdk, object client, Envelope envelope, Call call, CallScript? entry, bool scripted)
    {
        var plan = envelope.Plans[call.Operation];
        var root = envelope.Safe ? Sdk.Get(client, "Safe") ?? throw new DriverException("the client's Safe is null") : client;
        var target = plan.Accessors.Aggregate(root, (at, name) => Sdk.Get(at, name)
            ?? throw new DriverException($"{at.GetType().Name}.{name} is null"));
        var method = target.GetType().GetMethod(plan.Method)
            ?? throw new DriverException($"{target.GetType().Name} has no method {plan.Method}");
        var raw = sdk.Create("RawResponse");
        var options = Options(sdk, envelope, call, raw, out var given);
        var bound = Bound(sdk, method, call, plan, entry);
        var lens = new Lens(call.Raw == true, scripted, entry?.Envelope == true, bound.GetValueOrDefault(Holder));
        using var cancel = new CancellationTokenSource();
        bound[Token] = cancel.Token;
        var parameters = method.GetParameters();
        if (bound.Keys.FirstOrDefault(name => name is not (Holder or Token) && parameters.All(p => p.Name != name)) is { } unbound)
        {
            throw new DriverException($"{plan.Method} has no parameter {unbound}");
        }
        var args = parameters.Select(p => Argument(sdk, p, given, bound, options)).ToArray();
        Cancel(cancel, entry?.Cancel is { } wait ? Scripts.CancelOf(wait) : null);
        if (plan.Stream is not null)
        {
            /* a safe SSE call answers a Result of its stream; a connection is the very method on both clients */
            var settles = envelope.Safe && plan.Stream == "sse" ? raw : null;
            var streamCall = new StreamCall(sdk, plan, call, entry, lens, raw);
            return await Streams.ObserveAsync(streamCall, async () => await ResultAsync(target, method, args)
                ?? throw new DriverException($"{plan.Method} opened nothing"), settles);
        }
        object? result;
        try
        {
            result = await ResultAsync(target, method, args);
        }
        catch (Exception e) when (e is not DriverException)
        {
            return envelope.Safe ? Observe.ThrownSafe(sdk, e, lens) : Observe.Thrown(sdk, e, lens, raw);
        }
        return envelope.Safe
            ? Observe.Safe(sdk, result, raw, plan, lens)
            : Observe.Returned(sdk, new Answer(method.ReturnType, result, raw), plan, lens);
    }

    /// <summary>
    /// <paramref name="method"/> run on <paramref name="target"/> and awaited, the SDK's own exception unwrapped: its
    /// task's result, or null when the declared return type is not generic (P5).
    /// </summary>
    public static async Task<object?> ResultAsync(object target, MethodInfo method, object?[] args)
    {
        var task = method.Invoke(target, BindingFlags.DoNotWrapExceptions, null, args, null) as Task
            ?? throw new DriverException($"{method.Name} returned no Task");
        await task;
        return method.ReturnType.IsGenericType ? method.ReturnType.GetProperty("Result")!.GetValue(task) : null;
    }

    /* the keys of the values bound by what they are rather than by a parameter's name */
    private const string Holder = "<headersInto>";
    private const string Token = "<token>";

    /// <summary>Cancels <paramref name="source"/> now for a zero <paramref name="wait"/>, or after it; nothing for none.</summary>
    private static void Cancel(CancellationTokenSource source, TimeSpan? wait)
    {
        if (wait == TimeSpan.Zero)
        {
            source.Cancel();
        }
        else if (wait is { } after)
        {
            source.CancelAfter(after);
        }
    }

    /// <summary>
    /// The values the call binds by what they are: a binary body by its parameter name, the script's idempotency key
    /// by the plan's parameter, and the typed headers' holder.
    /// </summary>
    private static Dictionary<string, object?> Bound(Sdk sdk, MethodInfo method, Call call, Plan plan, CallScript? entry)
    {
        var bound = new Dictionary<string, object?>();
        var oneShot = entry?.OneShotBody == true;
        if (call.Body is { Kind: "binary" } body)
        {
            var param = plan.Body?.Param ?? throw new DriverException("the call sends a body, and the method takes none");
            var type = method.GetParameters().Single(p => p.Name == param).ParameterType;
            bound[param] = Binary(type, body.Size ?? throw new DriverException("a binary body has no size"), oneShot);
        }
        else if (oneShot)
        {
            throw new DriverException("the script sets oneShotBody, and the call sends no binary body");
        }
        if (entry?.IdempotencyKey is { } key)
        {
            bound[plan.IdempotencyKey!] = key;
        }
        if (plan.ResponseHeaders is { } headers)
        {
            bound[Holder] = sdk.Create(headers.Type);
        }
        if (plan.Stream is not null)
        {
            Fields(bound, call, entry);
        }
        return bound;
    }

    /// <summary>A stream method's own fields, each given one bound by its fixed name; Protocol.cs refused a misfit.</summary>
    private static void Fields(Dictionary<string, object?> bound, Call call, CallScript? entry)
    {
        var fields = new (string Name, object? Value)[]
        {
            ("lastEventId", call.LastEventId),
            ("reconnectToken", call.ReconnectToken),
            ("protocols", entry?.Protocols),
            ("maxReconnectAttempts", entry?.Realtime?.MaxReconnectAttempts),
            ("reconnectDelay", entry?.Realtime?.ReconnectDelayMs is { } ms ? (TimeSpan?)TimeSpan.FromMilliseconds(ms) : null),
        };
        foreach (var (name, value) in fields.Where(field => field.Value is not null))
        {
            bound[name] = value;
        }
    }

    /// <summary><paramref name="size"/> bytes <c>i &amp; 0xff</c> as a <paramref name="type"/> (<c>BinaryBody</c>): in memory, or one-shot.</summary>
    private static object? Binary(Type type, int size, bool oneShot)
    {
        var bytes = Enumerable.Range(0, size).Select(i => (byte)(i & 0xff)).ToArray();
        var from = oneShot ? typeof(Stream) : typeof(byte[]);
        var convert = type.GetMethod("op_Implicit", BindingFlags.Public | BindingFlags.Static, [from])
            ?? throw new DriverException($"{type.Name} has no implicit conversion from {from.Name}");
        return convert.Invoke(null, [oneShot ? new OneShotStream(bytes) : bytes]);
    }

    /// <summary>
    /// The call's <c>RequestOptions</c>, and every value it gives a parameter, by parameter name: path params, a
    /// JSON, form or text body, query params, and the call headers a param declares.
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
        if (call.Body is { Kind: not "binary" } body)
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

    /// <summary>The call's timeout, its undeclared headers, the base URL of the origin it names, and the raw response to fill.</summary>
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
            case "drop":
                Sdk.Set(options, "BaseUrl", envelope.Drop ?? throw new DriverException("the call's origin is drop, and the run has none"));
                break;
            case "refused":
                Sdk.Set(options, "BaseUrl", envelope.Refused ?? throw new DriverException("the call's origin is refused, and the run has none"));
                break;
            default:
                throw new DriverException($"origin {call.Origin} is not one the driver knows");
        }
        return options;
    }

    /// <summary>
    /// Parameter <paramref name="p"/>'s argument: the token, the options, the holder, a bound value, a given value
    /// through the SDK's context, or the parameter's default; a required one with no value is a DriverException.
    /// </summary>
    private static object? Argument(Sdk sdk, ParameterInfo p, Dictionary<string, JsonNode?> given, Dictionary<string, object?> bound, object options)
    {
        if (p.ParameterType == typeof(CancellationToken))
        {
            return bound[Token];
        }
        if (p.ParameterType == options.GetType())
        {
            return options;
        }
        if (bound.GetValueOrDefault(Holder) is { } holder && p.ParameterType == holder.GetType())
        {
            return holder;
        }
        if (bound.TryGetValue(p.Name!, out var value))
        {
            return value;
        }
        if (given.TryGetValue(p.Name!, out var node))
        {
            /* a string is a string: a path param binds without a context entry the API may not need */
            if (p.ParameterType == typeof(string) && node is JsonValue text && text.TryGetValue<string>(out var s))
            {
                return s;
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

/// <summary>A body read once: no length, no seek, so the SDK can neither size nor resend it (<c>oneShotBody</c>).</summary>
internal sealed class OneShotStream(byte[] data) : Stream
{
    private readonly MemoryStream inner = new(data, writable: false);

    public override bool CanRead => true;

    public override bool CanSeek => false;

    public override bool CanWrite => false;

    public override long Length => throw new NotSupportedException();

    public override long Position
    {
        get => throw new NotSupportedException();
        set => throw new NotSupportedException();
    }

    public override int Read(byte[] buffer, int offset, int count) => inner.Read(buffer, offset, count);

    public override void Flush()
    {
    }

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
