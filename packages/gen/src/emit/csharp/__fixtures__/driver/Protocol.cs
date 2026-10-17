using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Honey.Driver;

/// <summary>
/// The stdin envelope (driven.ts): the SDK to load, the grid cell, the emitter's call plans by operation, the
/// origins, and the optional script. The records mirror the grid's <c>Setup</c> and <c>Call</c>
/// (tests/integration/conformance/matrix.ts), the plan (sdk-plan.ts) and the script (protocol.ts), decoded
/// strictly: a member the driver does not know fails the run before any call, so a new grid member is a red cell,
/// never a silent pass.
/// </summary>
internal sealed record Envelope(
    SdkTarget Sdk,
    Cell Cell,
    Dictionary<string, Plan> Plans,
    string Base,
    string? Alt = null,
    JsonNode? Script = null);

/// <summary>The SDK's built dll, its root namespace and its client class.</summary>
internal sealed record SdkTarget(string Dll, string Namespace, string Client);

/// <summary>A grid cell: its calls and setup; the rest of a grid Cell (its expectations) is the runner's.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Skip)]
internal sealed record Cell(IReadOnlyList<Call> Calls, Setup? Setup = null);

internal sealed record Setup(
    Auth? Auth = null,
    Dictionary<string, string>? Headers = null,
    string? Redirect = null,
    int? TimeoutMs = null);

/// <summary><c>bearer</c> with its token, or <c>header</c> with its name and value.</summary>
internal sealed record Auth(string Kind, string? Token = null, string? Name = null, string? Value = null);

internal sealed record Route(string Method, string Path);

/// <summary><c>json</c> with its value, or <c>binary</c> with its content type and size.</summary>
internal sealed record CallBody(string Kind, JsonNode? Value = null, string? ContentType = null, int? Size = null);

internal sealed record Call(
    string Operation,
    Route Route,
    CallBody? Body = null,
    Dictionary<string, string>? Headers = null,
    string? LastEventId = null,
    string? Origin = null,
    Dictionary<string, string>? Params = null,
    bool? Raw = null,
    string? ReconnectToken = null,
    Dictionary<string, JsonNode?>? Search = null,
    IReadOnlyList<string>? Send = null,
    int? Take = null,
    int? TimeoutMs = null);

/// <summary>A path param's spec name and its parameter name.</summary>
internal sealed record PathParam(string Name, string Param);

/// <summary>The body's kind and its parameter name.</summary>
internal sealed record PlanBody(string Kind, string Param);

/// <summary>The <c>&lt;Op&gt;Headers</c> holder's type, and each declared response header to its property.</summary>
internal sealed record PlanHeaders(string Type, Dictionary<string, string> Fields);

/// <summary>One operation's call plan (sdk-plan.ts), in the emitter's own names.</summary>
internal sealed record Plan(
    string Operation,
    IReadOnlyList<string> Accessors,
    string Method,
    IReadOnlyList<PathParam> Path,
    PlanBody? Body,
    Dictionary<string, string> Query,
    Dictionary<string, string> Headers,
    IReadOnlyList<string> Required,
    string? IdempotencyKey,
    string Response,
    bool Throws,
    string? Stream,
    PlanHeaders? ResponseHeaders = null);

/// <summary>The script (protocol.ts <c>Script</c>): what a unit test adds to a grid cell.</summary>
internal sealed record Script(
    IReadOnlyList<CallScript?>? Calls = null,
    ScriptConfig? Config = null,
    ScriptHooks? Hooks = null,
    bool? Log = null,
    bool? LogDurations = null,
    ScriptRefresh? OnAuthExpired = null);

/// <summary>The client config a grid setup has no member for.</summary>
internal sealed record ScriptConfig(
    string? AuthHeaderName = null,
    string? AuthHeaderPrefix = null,
    bool? HttpClient = null,
    ScriptInvalidation? Invalidation = null,
    long? MaxResponseBytes = null);

internal sealed record ScriptInvalidation(int StaleTimeMs, int? MaxSourcesPerTarget = null, int? StaleMaxEntries = null);

/// <summary>One hook per entry, in order; an absent list installs one recording no-op.</summary>
internal sealed record ScriptHooks(IReadOnlyList<RequestHook>? Request = null, IReadOnlyList<ResponseHook>? Response = null);

/// <summary>A request hook: the header it sets (name, value), then the failure it throws.</summary>
internal sealed record RequestHook(string? Fail = null, IReadOnlyList<string>? SetHeader = null);

/// <summary>A response hook: the body it sets (UTF-8), then the failure it throws.</summary>
internal sealed record ResponseHook(string? Body = null, string? Fail = null);

/// <summary>OnAuthExpired: the n-th refresh answers <c>Tokens[n-1]</c>, and fails past the end.</summary>
internal sealed record ScriptRefresh(IReadOnlyList<string> Tokens);

/// <summary>
/// One call's script entry. <c>cancel</c> is <c>"before"</c> or <c>{afterMs}</c>; the members only Go or Python
/// can use, and the stream ones, are kept as given so the refusal can name them.
/// </summary>
internal sealed record CallScript(
    JsonNode? Cancel = null,
    JsonNode? CtxTimeoutMs = null,
    bool? Envelope = null,
    string? IdempotencyKey = null,
    JsonNode? IsErrors = null,
    JsonNode? IsKeys = null,
    bool? OneShotBody = null,
    JsonNode? Protocols = null,
    JsonNode? Realtime = null,
    int? SleepMs = null,
    JsonNode? TaskCancel = null,
    JsonNode? Ws = null);

/// <summary>A run the driver cannot express: exit 1 with its reason, before or instead of a call.</summary>
internal sealed class DriverException(string message) : Exception(message);

internal static class Protocol
{
    /* the driver's own wire, decoded by reflection: strict members, required constructor parameters, no null
     * where the record has none; the SDK's values go through the SDK's own context, never through these */
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        RespectNullableAnnotations = true,
        RespectRequiredConstructorParameters = true,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    /// <summary>The envelope in <paramref name="text"/>, or a <see cref="DriverException"/> naming what is wrong.</summary>
    public static Envelope Read(string text)
    {
        try
        {
            return JsonSerializer.Deserialize<Envelope>(text, Options) ?? throw new DriverException("the envelope is null");
        }
        catch (JsonException e)
        {
            throw new DriverException($"the envelope does not decode: {e.Message}");
        }
    }

    /// <summary>
    /// The script in <paramref name="node"/>, decoded strictly: a member no record names is
    /// <c>script: unknown member &lt;name&gt;</c>, at any depth.
    /// </summary>
    public static Script ReadScript(JsonNode node)
    {
        if (node is not JsonObject)
        {
            throw new DriverException("script: the script is a JSON object");
        }
        Strict(node, typeof(Script));
        try
        {
            return node.Deserialize<Script>(Options) ?? throw new DriverException("script: the script is null");
        }
        catch (JsonException e)
        {
            throw new DriverException($"script: {e.Message}");
        }
    }

    /// <summary>Every member of <paramref name="node"/> named by the driver's record <paramref name="type"/>, recursively.</summary>
    private static void Strict(JsonNode? node, Type type)
    {
        if (node is JsonArray items && type.IsGenericType)
        {
            foreach (var item in items)
            {
                Strict(item, type.GetGenericArguments()[0]);
            }
        }
        if (node is not JsonObject members || type.Namespace != typeof(Script).Namespace)
        {
            return;
        }
        foreach (var (name, value) in members)
        {
            var property = type.GetProperties().FirstOrDefault(p => JsonNamingPolicy.CamelCase.ConvertName(p.Name) == name)
                ?? throw new DriverException($"script: unknown member {name}");
            Strict(value, Nullable.GetUnderlyingType(property.PropertyType) ?? property.PropertyType);
        }
    }

    /// <summary>
    /// What the driver cannot drive, refused before the SDK loads as <c>call &lt;i&gt; (&lt;op&gt;): &lt;reason&gt;</c>:
    /// a stream call and its members (phase d), a multipart body (a consumer program sends <c>FilePart</c>s), and an
    /// idempotency key on a method without one.
    /// </summary>
    public static void Refuse(Envelope envelope, Script? script)
    {
        for (var i = 0; i < envelope.Cell.Calls.Count; i++)
        {
            var call = envelope.Cell.Calls[i];
            var plan = envelope.Plans.GetValueOrDefault(call.Operation)
                ?? throw new DriverException($"no call plan names {call.Operation} (call {i})");
            var entry = script?.Calls is { } entries && i < entries.Count ? entries[i] : null;
            var reason = Later(call, plan) ?? Refused(plan, entry);
            if (reason is not null)
            {
                throw new DriverException($"call {i} ({call.Operation}): {reason}");
            }
        }
    }

    /// <summary>The first member of <paramref name="call"/> phase d drives, with that phase; null for none.</summary>
    private static string? Later(Call call, Plan plan) =>
        plan.Stream is { } stream ? $"stream {stream} arrives in phase d"
        : call.Send is not null ? "send arrives in phase d"
        : call.Take is not null ? "take arrives in phase d"
        : call.LastEventId is not null ? "lastEventId arrives in phase d"
        : call.ReconnectToken is not null ? "reconnectToken arrives in phase d"
        : null;

    /// <summary>Why the driver never sends <paramref name="plan"/>'s call as scripted; null when it does.</summary>
    private static string? Refused(Plan plan, CallScript? entry) =>
        plan.Body?.Kind == "multipart" ? "a multipart body is driven by a consumer program (FilePart)"
        : entry?.IdempotencyKey is not null && plan.IdempotencyKey is null
            ? "the script sets idempotencyKey, and the method has no idempotency key field"
        : null;
}
