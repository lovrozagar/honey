/**
 * The vendored Go runtime, as the files a Go SDK ships (H9/F5): `runtime/go/*.go`, read here and
 * nowhere else, emitted verbatim into the SDK's package. The WebSocket and realtime files — the
 * only ones importing `github.com/coder/websocket` — ship only when the API has such operations,
 * so a plain HTTP SDK depends on the standard library alone. The one reader is the F8 mutation target.
 */
import { readFileSync } from "node:fs"
import { compareCodeUnits } from "../shared/lang.ts"

/** What the API needs from the runtime beyond plain HTTP. */
export type GoRuntimeFeatures = { readonly realtime: boolean; readonly ws: boolean }

/* every SDK: config, request, auth, redirects, errors, SSE, invalidation */
const CORE: readonly string[] = [
	"auth",
	"body",
	"config",
	"errors",
	"export",
	"hooks",
	"invalidation",
	"log",
	"nullable",
	"options",
	"path",
	"query",
	"redirect",
	"request",
	"result",
	"sse",
	"stale",
	"stream",
]

/* a WebSocket operation; realtime adds the resumable transports on top of it */
const WS: readonly string[] = ["ws"]
const REALTIME: readonly string[] = ["realtime", "realtime_loop", "transport", "transport_longpoll", "transport_sse"]

/** The runtime file names an SDK with `features` ships, in code-unit order. */
export function runtimeFileNames(features: GoRuntimeFeatures): string[] {
	const names = [...CORE]
	if (features.ws || features.realtime) names.push(...WS)
	if (features.realtime) names.push(...REALTIME)
	return names.map((name) => `${name}.go`).sort(compareCodeUnits)
}

/** Whether these features make the SDK depend on `github.com/coder/websocket`. */
export const needsWebSocket = (features: GoRuntimeFeatures): boolean => features.ws || features.realtime

/** The runtime files an SDK with `features` ships, by file name, read verbatim. */
export function runtimeFiles(features: GoRuntimeFeatures): Record<string, string> {
	return Object.fromEntries(
		runtimeFileNames(features).map((name) => [
			name,
			readFileSync(new URL(`../../runtime/go/${name}`, import.meta.url), "utf8"),
		]),
	)
}
