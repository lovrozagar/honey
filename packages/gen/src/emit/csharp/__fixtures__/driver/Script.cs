using System.Reflection;
using System.Text.Json.Nodes;

namespace Honey.Driver;

/// <summary>
/// The envelope's optional script (protocol.ts <c>Script</c>, decoded strictly by Protocol.cs): client config a
/// grid setup has no member for, recording hooks, a scripted <c>OnAuthExpired</c>, <c>OnLog</c>, and per-call
/// directives. A unit test or the harness sends one; the conformance runner never does. What only Go
/// (<c>ctxTimeoutMs</c>, <c>isKeys</c>, <c>isErrors</c>, <c>ws.readLimit</c>) or Python (<c>taskCancel</c>) can do is
/// refused for good, before the SDK loads; the stream directives (<c>protocols</c>, <c>realtime</c>, <c>ws</c>) are
/// the stream method's fields and the WebSocket's script (Stream.cs). Every hook is async with the call's token
/// (Fc8), bound to the SDK's own delegate type by reflection: the driver holds no reference to any SDK.
/// </summary>
internal static class Scripts
{
    /// <summary>The script in <paramref name="node"/>, checked for a cell of <paramref name="calls"/> calls.</summary>
    public static Script Parse(JsonNode node, int calls)
    {
        var script = Protocol.ReadScript(node);
        var entries = script.Calls ?? [];
        if (entries.Count > calls)
        {
            throw new DriverException($"script: {entries.Count} calls scripted for a cell of {calls}");
        }
        for (var i = 0; i < entries.Count; i++)
        {
            /* a WsSend cannot tell an absent member from a JSON null, so a message's members are counted in the script */
            var sends = node["calls"]?[i]?["ws"]?["send"] as JsonArray;
            var reason = entries[i] is not { } entry ? null
                : sends?.Any(message => message is not JsonObject { Count: 1 }) == true
                    ? "ws.send: a message holds exactly one of json, text and bytes"
                : Refusal(entry);
            if (reason is not null)
            {
                throw new DriverException($"script: call {i}: {reason}");
            }
        }
        if (script.Hooks?.Request?.Any(hook => hook.SetHeader is not null and not [_, _]) == true)
        {
            throw new DriverException("script: a request hook's setHeader is [name, value]");
        }
        if (script.LogDurations == true && script.Log != true)
        {
            throw new DriverException("script: logDurations needs log");
        }
        return script;
    }

    /// <summary>Why the driver refuses a call's entry, or null.</summary>
    private static string? Refusal(CallScript entry) =>
        entry.CtxTimeoutMs is not null ? "ctxTimeoutMs is Go's ctx deadline; a C# call is bounded by timeoutMs"
        : entry.IsKeys is not null ? "isKeys is Go's errors.Is; the C# trace records key"
        : entry.IsErrors is not null ? "isErrors is Go's errors.Is; the C# trace records the type and text"
        : entry.TaskCancel is not null ? "taskCancel is a Python AsyncSDK task's; a C# call ends by its token (cancel)"
        : entry.Ws?.ReadLimit is not null ? "ws.readLimit is Go's SetReadLimit; a C# socket caps a message at 16 MiB"
        : entry.Cancel is { } cancel && CancelOf(cancel) is null ? "cancel is \"before\" or {\"afterMs\": n}, n > 0"
        : null;

    /// <summary>A <c>cancel</c>'s wait: zero for <c>"before"</c>, else <c>afterMs</c>; null when it is neither.</summary>
    public static TimeSpan? CancelOf(JsonNode cancel) => cancel switch
    {
        JsonValue before when before.TryGetValue<string>(out var text) && text == "before" => TimeSpan.Zero,
        JsonObject { Count: 1 } after when after["afterMs"] is JsonValue ms && ms.TryGetValue<int>(out var n) && n > 0 =>
            TimeSpan.FromMilliseconds(n),
        _ => null,
    };

    /// <summary>
    /// Sets the script's client config on <paramref name="config"/> and installs its recorders: the hooks always (one
    /// recording no-op per phase whose list is absent), <c>OnAuthExpired</c> and <c>OnLog</c> when asked.
    /// </summary>
    public static void Apply(Script script, object config, Sdk sdk, Recorder recorder)
    {
        Configure(script.Config ?? new ScriptConfig(), config, sdk);
        var requests = (script.Hooks?.Request ?? [new RequestHook()])
            .Select(object (entry, i) => new RequestRecorder(i, entry, recorder))
            .ToList();
        var responses = (script.Hooks?.Response ?? [new ResponseHook()])
            .Select(object (entry, i) => new ResponseRecorder(i, entry, recorder))
            .ToList();
        Sdk.Set(config, "OnRequest", Delegates(config, "OnRequest", requests, nameof(RequestRecorder.RunAsync)));
        Sdk.Set(config, "OnResponse", Delegates(config, "OnResponse", responses, nameof(ResponseRecorder.RunAsync)));
        if (script.OnAuthExpired is { } refresh)
        {
            Sdk.Set(config, "OnAuthExpired", recorder.Refresher(refresh.Tokens));
        }
        if (script.Log == true)
        {
            var logger = new LogRecorder(script.LogDurations == true, recorder);
            Sdk.Set(config, "OnLog", Bound(Sdk.PropertyOf(config, "OnLog").PropertyType, logger, nameof(LogRecorder.Log)));
        }
    }

    /// <summary>The given config members: the auth header's name and prefix, invalidation, the cap, a caller handler.</summary>
    private static void Configure(ScriptConfig given, object config, Sdk sdk)
    {
        if (given.AuthHeaderName is { } name)
        {
            Sdk.Set(config, "AuthHeaderName", name);
        }
        if (given.AuthHeaderPrefix is { } prefix)
        {
            Sdk.Set(config, "AuthHeaderPrefix", prefix);
        }
        if (given.Invalidation is { } window)
        {
            var invalidation = sdk.Create("InvalidationConfig");
            Sdk.Set(invalidation, "StaleTime", TimeSpan.FromMilliseconds(window.StaleTimeMs));
            if (window.StaleMaxEntries is { } entries)
            {
                Sdk.Set(invalidation, "StaleMaxEntries", entries);
            }
            if (window.MaxSourcesPerTarget is { } sources)
            {
                Sdk.Set(invalidation, "MaxSourcesPerTarget", sources);
            }
            Sdk.Set(config, "Invalidation", invalidation);
        }
        if (given.MaxResponseBytes is { } cap)
        {
            Sdk.Set(config, "MaxResponseBytes", cap);
        }
        if (given.HttpClient == true)
        {
            Sdk.Set(config, "Handler", new DriverLink { InnerHandler = new SocketsHttpHandler() });
        }
    }

    /// <summary>
    /// The list <paramref name="config"/>'s <paramref name="property"/> takes (<c>IReadOnlyList&lt;Func&lt;Context,
    /// CancellationToken, Task&gt;&gt;</c>), each element <paramref name="method"/> of one of <paramref name="targets"/>.
    /// </summary>
    private static Array Delegates(object config, string property, IReadOnlyList<object> targets, string method)
    {
        var func = Sdk.PropertyOf(config, property).PropertyType.GetGenericArguments()[0];
        var list = Array.CreateInstance(func, targets.Count);
        for (var i = 0; i < targets.Count; i++)
        {
            list.SetValue(Bound(func, targets[i], method), i);
        }
        return list;
    }

    /// <summary>
    /// <paramref name="target"/>'s <paramref name="method"/> as a <paramref name="type"/>: its <c>object</c> parameter
    /// takes the SDK's context or log entry (a delegate binds a parameter contravariantly).
    /// </summary>
    private static Delegate Bound(Type type, object target, string method) =>
        Delegate.CreateDelegate(type, target, target.GetType().GetMethod(method, BindingFlags.Public | BindingFlags.Instance)!);
}

/// <summary>
/// The caller chain under <c>httpClient</c>: a link adding <c>User-Agent: honey-driver</c>, <c>X-Builder: b</c> and
/// basic auth (<c>driver:pw</c>), each only where the request has none (caller defaults, so the SDK's own
/// credential is never doubled), over a <c>SocketsHttpHandler</c> whose redirects are on until the SDK's install
/// turns them off.
/// </summary>
internal sealed class DriverLink : DelegatingHandler
{
    private static readonly (string Name, string Value)[] Defaults =
    [
        ("User-Agent", "honey-driver"),
        ("X-Builder", "b"),
        ("Authorization", "Basic ZHJpdmVyOnB3"),
    ];

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        foreach (var (name, value) in Defaults)
        {
            if (!request.Headers.Contains(name))
            {
                request.Headers.TryAddWithoutValidation(name, value);
            }
        }
        return base.SendAsync(request, cancellationToken);
    }
}
