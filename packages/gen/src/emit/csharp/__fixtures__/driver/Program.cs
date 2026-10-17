using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

namespace Honey.Driver;

/// <summary>
/// The C# SDK's test driver (bit 15, contract 45 §6.5, Fb10): one fixed program, no generated code, and no
/// reference to any SDK. Stdin is the shared envelope (Protocol.cs); every call of the cell runs in order on one
/// client aimed at <c>base</c>, and stdout is the grid's <c>Observed[]</c> JSON, one per call. The SDK's dll is
/// loaded at run time; the driver walks the emitter's call plans by reflection (Invoke.cs) and binds every
/// argument and writes every answer through the SDK's own exported <c>JsonSerializerContext</c>, so its wire is the
/// SDK's wire. Any failure, and any call or outcome it cannot express, exits 1 with <c>driver: reason</c> on
/// stderr: a red cell, never a silent pass. What a later phase drives is refused before the SDK loads.
/// </summary>
internal static class Program
{
    private static async Task<int> Main()
    {
        try
        {
            var envelope = Protocol.Read(await Console.In.ReadToEndAsync());
            Protocol.Refuse(envelope);
            Console.WriteLine(await DriveAsync(envelope));
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

    /// <summary>Every call of the cell in order on one client: each one's observed, or the reason it ended the run.</summary>
    private static async Task<string> DriveAsync(Envelope envelope)
    {
        var sdk = Sdk.Load(envelope.Sdk);
        var config = Configured(sdk, envelope);
        using var client = (IDisposable)(Activator.CreateInstance(sdk.Type(envelope.Sdk.Client), config)
            ?? throw new DriverException($"{envelope.Sdk.Client} did not construct"));
        var observed = new JsonArray();
        for (var i = 0; i < envelope.Cell.Calls.Count; i++)
        {
            var call = envelope.Cell.Calls[i];
            try
            {
                observed.Add(await Invoke.CallAsync(sdk, client, envelope, call));
            }
            catch (Exception e)
            {
                var reason = e is DriverException ? e.Message : $"{e.GetType().Name}: {e.Message}";
                throw new DriverException($"call {i} ({call.Operation}): {reason}");
            }
        }
        return observed.ToJsonString();
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
        assembly.GetType($"{ns}.{name}") ?? throw new DriverException($"the SDK has no type {ns}.{name}");

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
        Property(target, name).SetValue(target, value);

    /// <summary><paramref name="target"/>'s property <paramref name="name"/>.</summary>
    public static object? Get(object target, string name) => Property(target, name).GetValue(target);

    private static PropertyInfo Property(object target, string name) =>
        target.GetType().GetProperty(name)
            ?? throw new DriverException($"{target.GetType().Name} has no property {name}");
}
