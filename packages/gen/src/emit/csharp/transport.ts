/**
 * The vendored C# runtime, as the files a C# SDK ships under `Runtime/` (H9/F5): `runtime/csharp/*.cs`, read here
 * and nowhere else (the F8 mutation target), each emitted as committed but for its one `namespace Honey.Runtime;`
 * line, which becomes the SDK's own namespace (Fb2), so `using <RootNamespace>;` reaches the client, the config,
 * the exceptions and the models alike. Phase b ships the same core for every API: WebSocket and realtime add their
 * files in phase d.
 */
import { readFileSync } from "node:fs"
import { compareCodeUnits } from "../shared/lang.ts"

/** What the API needs from the runtime beyond plain HTTP. */
export type CSharpRuntimeFeatures = { readonly realtime: boolean; readonly ws: boolean }

/* every SDK: config, errors, the safe result, the strict JSON converters, the operation, the encoders, the transport */
const CORE: readonly string[] = ["Config", "Errors", "Json", "Operation", "Path", "Query", "Result", "Transport"]

/* the one line each committed file holds, swapped for the SDK's namespace */
const NAMESPACE = /^namespace Honey\.Runtime;$/m

/* a top-level type at column 0: its modifiers, its kind, its name (type parameters after it are not part of it) */
const TOP_LEVEL =
	/^(?:(?:public|internal|file|sealed|abstract|static|readonly|partial|unsafe)\s+)*(?:record\s+struct|record\s+class|class|record|struct|enum|interface)\s+([A-Za-z_]\w*)/gm

/** The runtime file names an SDK with `features` ships, `.cs` included, in code-unit order. */
export function runtimeFileNames(_features: CSharpRuntimeFeatures): string[] {
	return CORE.map((name) => `${name}.cs`).sort(compareCodeUnits)
}

/** The runtime files an SDK with `features` ships, by file name, read from disk on every call, in `rootNamespace`. */
export function runtimeFiles(features: CSharpRuntimeFeatures, rootNamespace: string): Record<string, string> {
	return Object.fromEntries(
		runtimeFileNames(features).map((name) => [
			name,
			readFileSync(new URL(`../../runtime/csharp/${name}`, import.meta.url), "utf8").replace(
				NAMESPACE,
				() => `namespace ${rootNamespace};`,
			),
		]),
	)
}

/** Every top-level class, record, struct, enum and interface name in `source`: what a spec type may not take. */
export function runtimeTypeNames(source: string): string[] {
	return [...source.matchAll(TOP_LEVEL)].map((match) => match[1] as string)
}
