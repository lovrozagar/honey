using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Honey.Driver;

/// <summary>
/// The stdin envelope (driven.ts): the SDK to load, the grid cell, the emitter's call plans by operation, the
/// origins, and the optional script. The records mirror the grid's <c>Setup</c> and <c>Call</c>
/// (tests/integration/conformance/matrix.ts) and the plan (sdk-plan.ts), decoded strictly: a member the driver
/// does not know fails the run before any call, so a new grid member is a red cell, never a silent pass.
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
    string? Stream);

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
    /// What phase b cannot drive, refused before the SDK loads: each names the member and the phase it arrives in.
    /// </summary>
    public static void Refuse(Envelope envelope)
    {
        if (envelope.Script is not null)
        {
            throw new DriverException("script arrives in phase c");
        }
        if (envelope.Cell.Setup?.Redirect is not null)
        {
            throw new DriverException("setup.redirect arrives in phase c");
        }
        for (var i = 0; i < envelope.Cell.Calls.Count; i++)
        {
            var call = envelope.Cell.Calls[i];
            var plan = envelope.Plans.GetValueOrDefault(call.Operation)
                ?? throw new DriverException($"no call plan names {call.Operation} (call {i})");
            var member = Later(call, plan);
            if (member is not null)
            {
                throw new DriverException($"{member} (call {i}, {call.Operation})");
            }
        }
    }

    /// <summary>The first member of <paramref name="call"/> a later phase drives, with that phase; null for none.</summary>
    private static string? Later(Call call, Plan plan) =>
        plan.Stream is { } stream ? $"stream {stream} arrives in phase d"
        : call.Send is not null ? "send arrives in phase d"
        : call.Take is not null ? "take arrives in phase d"
        : call.LastEventId is not null ? "lastEventId arrives in phase d"
        : call.ReconnectToken is not null ? "reconnectToken arrives in phase d"
        : call.Body?.Kind == "binary" ? "a binary body arrives in phase c"
        : plan.Response == "binary" ? "a binary answer arrives in phase c"
        : null;
}
