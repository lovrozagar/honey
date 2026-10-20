/**
 * Consumer programs (contract 45 §6.4): a `Main` around a test's C# body, compiled with csc against a registry
 * SDK's dll and run beside it (compiledCSharp, Fb9), for what a JSON driver cannot fill, and `checked`, csc's
 * errors for a program against it, for what only the compiler proves (a name, a type, a signature). The program
 * takes its base URL as `args[0]`, so a body may aim a client at the shared recording server (`served()`,
 * emit/shared/__fixtures__/recording-server.ts), and prints every section's notes as one JSON object. It uses
 * reflection-based `JsonSerializer` on its own notes alone. Test programs are never format-gated and never shipped.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { compiledCSharp, type CSharpSdk } from "./compiled.ts"
import type { FixtureKey } from "./documents.ts"

/**
 * The program around `{body}`: `Section(s)` starts a section, `Note(line)` adds to it, `Client()` is the SDK's
 * client aimed at `_base`, which is `args[0]` (an unroutable address without one).
 */
const PROGRAM = `using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using {ns};

internal static class Program
{
    private static readonly Dictionary<string, List<string>> Out = [];
    private static string _at = "main";
    private static string _base = "http://127.0.0.1:9";

    private static void Section(string name) => _at = name;

    private static void Note(object? line) =>
        (Out.TryGetValue(_at, out var list) ? list : Out[_at] = []).Add(line as string ?? JsonSerializer.Serialize(line?.ToString()));

    private static {client} Client(ClientConfig? config = null) => new((config ?? new ClientConfig()) with { BaseUrl = _base });

    private static async Task<int> Main(string[] args)
    {
        _base = args.Length > 0 ? args[0] : _base;
{body}
        Console.WriteLine(JsonSerializer.Serialize(Out));
        return 0;
    }
}
{decls}`

/**
 * A consumer program: its body (statements of `Main`, unindented), the base URL it is given, and `decls`, top-level
 * types after `Program` (a fake `ITransportAdapter`, say), written as they appear.
 */
export type Consumer = { readonly base?: string; readonly body: string; readonly decls?: string }

/** A consumer program's run: whether it ran to the end, its notes by section, its stderr. */
export type Run = { ran: boolean; stderr: string; out: Record<string, string[]> | undefined }

/** PROGRAM around `body`, each line indented into `Main`, using `namespace`, constructing `client`, `decls` after it. */
export function program(namespace: string, client: string, body: string, decls = ""): string {
	const indented = body
		.split("\n")
		.map((line) => (line === "" ? "" : `        ${line}`))
		.join("\n")
	return PROGRAM.replace("{ns}", () => namespace)
		.replace("{client}", () => client)
		.replace("{body}", () => indented)
		.replace("{decls}", () => (decls === "" ? "" : `\n${decls}\n`))
}

/** The emitted client's namespace and class, as the SDK's `Client.cs` declares them. */
export function clientOf(sdk: CSharpSdk): { readonly client: string; readonly namespace: string } {
	const text = readFileSync(join(sdk.src, "Client.cs"), "utf8")
	const namespace = /^namespace ([\w.]+);$/m.exec(text)?.[1]
	const client = /^public sealed class (\w+) : IDisposable$/m.exec(text)?.[1]
	if (namespace === undefined || client === undefined) throw new Error(`${sdk.src}/Client.cs declares no client`)
	return { client, namespace }
}

/** The registry SDK `key` with the consumer `p` run against it as program `name`, without blocking the event loop. */
export async function consume(key: FixtureKey, name: string, p: Consumer): Promise<Run> {
	const sdk = compiledCSharp(key)
	if (!sdk.built) return { out: undefined, ran: false, stderr: sdk.diagnostics.join("\n") }
	const { client, namespace } = clientOf(sdk)
	const source = `// consumer ${name}: a test program, never shipped\n${program(namespace, client, p.body, p.decls)}`
	const ran = await sdk.exec(source, "", p.base === undefined ? [] : [p.base])
	const out = ran.status === 0 ? (JSON.parse(ran.stdout) as Record<string, string[]>) : undefined
	return { out, ran: ran.status === 0, stderr: ran.stderr }
}

/** csc's errors for `source` against the registry SDK `key` (one compile per program text). */
export const checked = (key: FixtureKey, source: string): readonly string[] => compiledCSharp(key).check(source)

/** What a test asserts of a run: it ran, and the notes of `section` (none noted is an empty section). */
export const seen = (run: Run, section = "main") => ({ ran: run.ran, out: run.out && (run.out[section] ?? []) })
