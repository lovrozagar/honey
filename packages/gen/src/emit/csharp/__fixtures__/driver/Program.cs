using System.Diagnostics;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

namespace Honey.Driver;

/// <summary>
/// The C# SDK's test driver (bit 15, contract 45 §6.5, Fb10; contract 47 §4.3): one fixed program, no generated
/// code, and no reference to any SDK. Stdin is the shared envelope (Protocol.cs); every call of the cell runs in
/// order on one client aimed at <c>base</c>, and stdout is the grid's <c>Observed[]</c> JSON, one per call. The
/// SDK's dll is loaded at run time; the driver walks the emitter's call plans by reflection (Invoke.cs) and binds
/// every argument and writes every answer through the SDK's own exported <c>JsonSerializerContext</c>, so its wire
/// is the SDK's wire. A script (Script.cs; unit tests and the harness send one, the conformance runner never does)
/// sets what a grid setup cannot, installs recording hooks and directs each call, and stdout becomes
/// <c>{"observed": (Observed|null)[], "trace": Trace&lt;CsError&gt;}</c> (Trace.cs). A stream call (SSE, WebSocket,
/// realtime) observes what its stream delivered under a 10 s watchdog (Stream.cs). Before call <c>i</c>: its
/// <c>sleepMs</c>, then the recorder marks it; <c>elapsedMs</c> covers the call alone. Any failure, and any call or
/// outcome it cannot express, exits 1 with <c>driver: reason</c> on stderr: a red cell, never a silent pass. A bad
/// script and what the driver cannot drive are refused before the SDK loads.
/// </summary>
internal static class Program
{
    private static async Task<int> Main()
    {
        try
        {
            var envelope = Protocol.Read(await Console.In.ReadToEndAsync());
            var script = envelope.Script is { } node ? Scripts.Parse(node, envelope.Cell.Calls.Count) : null;
            Protocol.Refuse(envelope, script);
            Console.WriteLine(await DriveAsync(envelope, script));
            return 0;
        }
        catch (DriverException e)
        {
            await Console.Error.WriteLineAsync($"driver: {e.Message}");
            return 1;
        }
        catch (Exception e)
        {
            await Console.Error.WriteLineAsync($"driver: {e.GetType().Name}: {e.Message}");
            return 1;
        }
    }

    /// <summary>Every call of the cell in order on one client: the observed (and the trace under a script), or the reason it ended the run.</summary>
    private static async Task<string> DriveAsync(Envelope envelope, Script? script)
    {
        var sdk = Sdk.Load(envelope.Sdk);
        var recorder = new Recorder();
        var config = Configured(sdk, envelope);
        if (script is not null)
        {
            Scripts.Apply(script, config, sdk, recorder);
        }
        using var client = (IDisposable)(Activator.CreateInstance(sdk.Type(envelope.Sdk.Client), config)
            ?? throw new DriverException($"{envelope.Sdk.Client} did not construct"));
        var observed = new JsonArray();
        for (var i = 0; i < envelope.Cell.Calls.Count; i++)
        {
            var call = envelope.Cell.Calls[i];
            var entry = script?.Calls is { } entries && i < entries.Count ? entries[i] : null;
            if (entry?.SleepMs is { } sleep)
            {
                await Task.Delay(sleep);
            }
            recorder.Current = i;
            var clock = Stopwatch.StartNew();
            Outcome outcome;
            try
            {
                outcome = await Invoke.CallAsync(sdk, client, envelope, call, entry, script is not null);
            }
            catch (Exception e)
            {
                var reason = e is DriverException ? e.Message : $"{e.GetType().Name}: {e.Message}";
                throw new DriverException($"call {i} ({call.Operation}): {reason}");
            }
            recorder.Called(clock.ElapsedMilliseconds, outcome);
            observed.Add(outcome.Observed);
        }
        return script is null ? observed.ToJsonString() : new JsonObject { ["observed"] = observed, ["trace"] = recorder.Trace() }.ToJsonString();
    }

    /// <summary>The <c>ClientConfig</c> the cell's setup asks for, aimed at <c>base</c>.</summary>
    private static object Configured(Sdk sdk, Envelope envelope)
    {
        var config = sdk.Create("ClientConfig");
        Sdk.Set(config, "BaseUrl", envelope.Base);
        var setup = envelope.Cell.Setup ?? new Setup();
        switch (setup.Auth)
        {
            case null:
                break;
            case { Kind: "bearer", Token: { } token }:
                Sdk.Set(config, "BearerToken", token);
                break;
            case { Kind: "header", Name: { } name, Value: { } value }:
                Sdk.Set(config, "ApiKey", value);
                Sdk.Set(config, "AuthHeaderName", name);
                Sdk.Set(config, "AuthHeaderPrefix", "");
                break;
            default:
                throw new DriverException($"setup: auth {setup.Auth.Kind} is not one the driver knows");
        }
        if (setup.Headers is { } headers)
        {
            Sdk.Set(config, "Headers", new Dictionary<string, string>(headers));
        }
        if (setup.MaxResponseBytes is { } max)
        {
            Sdk.Set(config, "MaxResponseBytes", max);
        }
        if (setup.Redirect is { } redirect)
        {
            var policy = redirect switch
            {
                "follow" => "Follow",
                "same-origin" => "SameOrigin",
                _ => throw new DriverException($"setup: redirect {redirect} is not one the driver knows"),
            };
            Sdk.Set(config, "Redirect", Enum.Parse(sdk.Type("RedirectPolicy"), policy));
        }
        if (setup.TimeoutMs is { } ms)
        {
            Sdk.Set(config, "Timeout", TimeSpan.FromMilliseconds(ms));
        }
        return config;
    }
}

/// <summary>The loaded SDK: its assembly, its root namespace and its one exported source-generated context.</summary>
internal sealed class Sdk(Assembly assembly, string ns, JsonSerializerContext context)
{
    /// <summary>The SDK at <paramref name="target"/>, loaded into the default context beside the driver's own BCL.</summary>
    public static Sdk Load(SdkTarget target)
    {
        var assembly = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.GetFullPath(target.Dll));
        var contexts = assembly.GetExportedTypes().Where(t => t.IsSubclassOf(typeof(JsonSerializerContext))).ToList();
        if (contexts.Count != 1)
        {
            throw new DriverException($"the SDK exports {contexts.Count} JsonSerializerContext types, not one");
        }
        var value = contexts[0].GetProperty("Default", BindingFlags.Public | BindingFlags.Static)?.GetValue(null);
        var context = value as JsonSerializerContext
            ?? throw new DriverException($"{contexts[0].Name} has no static Default");
        return new Sdk(assembly, target.Namespace, context);
    }

    /// <summary>The SDK's type <paramref name="name"/> in its root namespace.</summary>
    public Type Type(string name) =>
        Find(name) ?? throw new DriverException($"the SDK has no type {ns}.{name}");

    /// <summary>The SDK's type <paramref name="name"/> in its root namespace; null when the SDK emits none.</summary>
    public Type? Find(string name) => assembly.GetType($"{ns}.{name}");

    /// <summary>A new <paramref name="name"/>, by its public parameterless constructor.</summary>
    public object Create(string name) =>
        Activator.CreateInstance(Type(name)) ?? throw new DriverException($"{name} did not construct");

    /// <summary>The SDK context's metadata for <paramref name="type"/>: the SDK's own options and converters.</summary>
    public JsonTypeInfo Info(Type type) =>
        context.GetTypeInfo(type) ?? throw new DriverException($"the SDK's context has no metadata for {type}");

    /// <summary>Whether <paramref name="value"/> is the SDK's type <paramref name="name"/> or derives from it.</summary>
    public bool Is(object value, string name) => Type(name).IsInstanceOfType(value);

    /// <summary>Sets <paramref name="target"/>'s property <paramref name="name"/> (an init accessor included).</summary>
    public static void Set(object target, string name, object? value) =>
        PropertyOf(target, name).SetValue(target, value);

    /// <summary><paramref name="target"/>'s property <paramref name="name"/>.</summary>
    public static object? Get(object target, string name) => PropertyOf(target, name).GetValue(target);

    /// <summary><paramref name="target"/>'s property <paramref name="name"/>'s metadata.</summary>
    public static PropertyInfo PropertyOf(object target, string name) =>
        target.GetType().GetProperty(name)
            ?? throw new DriverException($"{target.GetType().Name} has no property {name}");
}
