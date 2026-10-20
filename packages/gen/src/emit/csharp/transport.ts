/**
 * The vendored C# runtime, as the files a C# SDK ships under `Runtime/` (H9/F5): `runtime/csharp/*.cs`, read here
 * and nowhere else (the F8 mutation target), each emitted as committed but for its one `namespace Honey.Runtime;`
 * line, which becomes the SDK's own namespace (Fb2), so `using <RootNamespace>;` reaches the client, the config,
 * the exceptions and the models alike. Every API ships the core, SSE among it; a WebSocket or realtime API adds the
 * socket and its dial, and a realtime API the adapters and the connection (contract 50 §2).
 */
import { readFileSync } from "node:fs"
import { compareCodeUnits } from "../shared/lang.ts"

/** What the API needs from the runtime beyond plain HTTP. */
export type CSharpRuntimeFeatures = { readonly realtime: boolean; readonly ws: boolean }

/* every SDK: the HTTP runtime (config, errors and envelopes, bodies, auth, hooks, log, redirects and the strip
 * handler, stale tracking, the exchange, its wire readers and the transport), the safe result, the strict JSON
 * converters, the encoders, and the SSE parser and its EventStream */
const CORE: readonly string[] = [
	"Auth",
	"Body",
	"Config",
	"Envelope",
	"Errors",
	"Events",
	"Exchange",
	"Handler",
	"Hooks",
	"Invalidation",
	"Json",
	"Log",
	"Operation",
	"Path",
	"Query",
	"Redirect",
	"Result",
	"Sse",
	"Stale",
	"Transport",
	"Wire",
]

/* a WebSocket or realtime operation: the socket and its own HTTP/1.1 upgrade */
const WS: readonly string[] = ["Ws", "WsDial"]

/* a realtime operation: the adapters, the resumable connection and its loop, and the three transports */
const REALTIME: readonly string[] = [
	"Adapters",
	"Realtime",
	"RealtimeLoop",
	"TransportLongPoll",
	"TransportSse",
	"TransportWs",
]

/* the one line each committed file holds, swapped for the SDK's namespace */
const NAMESPACE = /^namespace Honey\.Runtime;$/m

/* a top-level type at column 0: its modifiers, its kind, its name (type parameters after it are not part of it) */
const TOP_LEVEL =
	/^(?:(?:public|internal|file|sealed|abstract|static|readonly|partial|unsafe)\s+)*(?:record\s+struct|record\s+class|class|record|struct|enum|interface)\s+([A-Za-z_]\w*)/gm

/** The runtime file names an SDK with `features` ships, `.cs` included, in code-unit order. */
export function runtimeFileNames(features: CSharpRuntimeFeatures): string[] {
	return [...CORE, ...(features.ws || features.realtime ? WS : []), ...(features.realtime ? REALTIME : [])]
		.map((name) => `${name}.cs`)
		.sort(compareCodeUnits)
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
