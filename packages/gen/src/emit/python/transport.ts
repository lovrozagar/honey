/**
 * The vendored Python runtime, as the files a Python SDK ships under `src/<pkg>/_honey/` (H9/F5):
 * `runtime/python/*.py`, read here and nowhere else (the F8 mutation target), emitted verbatim. The WebSocket
 * module ships for a WebSocket or realtime API and the realtime modules for a realtime API, so a plain HTTP SDK
 * carries neither them nor the `httpx2[ws]` extra.
 */
import { readFileSync } from "node:fs"
import { compareCodeUnits } from "../shared/lang.ts"

/** What the API needs from the runtime beyond plain HTTP. */
export type PythonRuntimeFeatures = { readonly realtime: boolean; readonly ws: boolean }

/* every SDK: the sans-IO core and its two shells, config, errors, hooks, log, redirects, SSE, invalidation */
const CORE: readonly string[] = [
	"__init__",
	"auth",
	"body",
	"config",
	"errors",
	"events",
	"exchange",
	"hooks",
	"invalidation",
	"log",
	"operation",
	"path",
	"query",
	"redirect",
	"result",
	"send_async",
	"send_sync",
	"sse",
	"stale",
]

/* a WebSocket operation; realtime adds the transports on top of it */
const WS: readonly string[] = ["ws"]
const REALTIME: readonly string[] = ["realtime", "transport", "transport_longpoll", "transport_sse", "transport_ws"]

/* a module's `__all__ = [...]`, one name per line or on one line */
const ALL = /^__all__ = \[([^\]]*)\]/m

/* a top-level public name: `class X`, `def x`, `async def x`, `X =` or `X: T =` at column 0 */
const PUBLIC_NAME =
	/^(?:class (?<cls>[A-Za-z]\w*)|(?:async )?def (?<fn>[A-Za-z]\w*)\(|(?<bound>[A-Za-z]\w*)(?:: [^=\n]+)? = )/gm

/** Whether these features make the package depend on `httpx2[ws]` (Fb3). */
export const needsWebSocket = (features: PythonRuntimeFeatures): boolean => features.ws || features.realtime

/** The runtime file names an SDK with `features` ships, `.py` included, in code-unit order. */
export function runtimeFileNames(features: PythonRuntimeFeatures): string[] {
	const names = [...CORE, ...(needsWebSocket(features) ? WS : []), ...(features.realtime ? REALTIME : [])]
	return names.map((name) => `${name}.py`).sort(compareCodeUnits)
}

/** The runtime files an SDK with `features` ships, by file name, read verbatim. */
export function runtimeFiles(features: PythonRuntimeFeatures): Record<string, string> {
	return Object.fromEntries(
		runtimeFileNames(features).map((name) => [
			name,
			readFileSync(new URL(`../../runtime/python/${name}`, import.meta.url), "utf8"),
		]),
	)
}

/** A runtime module's root exports: the names its `__all__` lists, in order; none without one. */
export function runtimeExports(source: string): string[] {
	const list = ALL.exec(source)?.[1] ?? ""
	return [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string)
}

/** A module's top-level public names (column 0, no leading `_`), in source order: what a component may not take. */
export function publicNames(source: string): string[] {
	return [...source.matchAll(PUBLIC_NAME)].map(({ groups }) => (groups?.cls ?? groups?.fn ?? groups?.bound) as string)
}
