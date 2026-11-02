/**
 * The vendored TS runtime, as the text an SDK ships (H9/F5): the modules under `runtime/ts`, read
 * here and nowhere else, joined into one module in dependency order with their imports of each
 * other dropped. An SDK ships only the transports its operations use: the event-stream modules for an
 * SSE or realtime API, the WebSocket ones for a WebSocket or realtime API, the realtime ones for a
 * realtime API, and only the app client ships its own `createClient`. The webhook verifier is no part of it: it ships
 * in its own file (`webhookSource`), so a receiver bundles nothing else. Both fronts emit it verbatim, so a test that runs the emitted client runs this text.
 */
import { readFileSync } from "node:fs"
import type { IR } from "../../ir/model.ts"
import { sdkModel } from "../../ir/sdk-model.ts"

/** What a client needs from the runtime beyond plain HTTP; `app` is the app client's own `createClient`. */
export type TsRuntimeFeatures = {
	readonly app: boolean
	readonly realtime: boolean
	readonly sse: boolean
	readonly ws: boolean
}

/** The app client's runtime: `createClient` and every transport, since it cannot know its routes'. */
export const FULL_RUNTIME: TsRuntimeFeatures = { app: true, realtime: true, sse: true, ws: true }

/** The runtime modules under `runtime/ts`, each after the ones it imports. */
export const RUNTIME_MODULES: readonly string[] = [
	"media-type",
	"defaults",
	"redirect-policy",
	"error",
	"path",
	"request",
	"response",
	"config",
	"redirects",
	"hooks",
	"sse",
	"realtime",
	"realtime-connection",
	"http",
	"stream",
	"ws",
	"realtime-transports",
	"stale",
	"app-types",
	"app",
	"sdk",
	"sdk-sse",
	"sdk-ws",
	"sdk-realtime",
]

/* the modules each transport adds; realtime dials over an event stream and a WebSocket, so it ships both */
const SSE: readonly string[] = ["sse", "stream", "sdk-sse"]
const WS: readonly string[] = ["ws", "sdk-ws"]
const REALTIME: readonly string[] = ["realtime", "realtime-connection", "realtime-transports", "sdk-realtime"]
const APP: readonly string[] = ["app-types", "app"]

/** The runtime modules an SDK with `features` ships, in `RUNTIME_MODULES` order. */
export function runtimeModules(features: TsRuntimeFeatures): string[] {
	const left = new Set([
		...(features.sse || features.realtime ? [] : SSE),
		...(features.ws || features.realtime ? [] : WS),
		...(features.realtime ? [] : REALTIME),
		...(features.app ? [] : APP),
	])
	return RUNTIME_MODULES.filter((name) => !left.has(name))
}

/** What the SDK of `ir` needs from the runtime: its operations' transports, never the app client. */
export function runtimeFeatures(ir: IR): TsRuntimeFeatures {
	const streams = new Set(sdkModel(ir).ops.map((op) => op.stream))
	return { app: false, realtime: streams.has("realtime"), sse: streams.has("sse"), ws: streams.has("ws") }
}

/* an import of a sibling runtime module, on one line or several */
const SIBLING_IMPORT = /^import\s+(?:type\s+)?\{[^}]*\}\s+from\s+"\.\/[\w-]+\.ts"\n/gm

/** One runtime module's source, without its imports of its siblings. */
function moduleSource(name: string): string {
	const text = readFileSync(new URL(`../../runtime/ts/${name}.ts`, import.meta.url), "utf8")
	return text.replace(SIBLING_IMPORT, "").trim()
}

/** The Standard Webhooks verifier: it imports nothing, so the webhook file that carries it stands alone. */
export function webhookSource(): string {
	return moduleSource("webhook")
}

/** The runtime as one module, with `features`' transports: what `runtime.gen.ts` holds. */
export function runtimeSource(features: TsRuntimeFeatures): string {
	return `${runtimeModules(features).map(moduleSource).join("\n\n")}\n`
}
