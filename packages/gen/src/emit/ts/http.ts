/**
 * The vendored TS runtime, as the text an SDK ships (H9/F5): the modules under `runtime/ts`, read
 * here and nowhere else, joined into one module in dependency order with their imports of each
 * other dropped. Both fronts emit it verbatim, so a test that runs the emitted client runs this text.
 */
import { readFileSync } from "node:fs"

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
	"ws",
	"realtime",
	"realtime-connection",
	"http",
	"stale",
	"app-types",
	"app",
	"sdk",
]

/* an import of a sibling runtime module, on one line or several */
const SIBLING_IMPORT = /^import\s+(?:type\s+)?\{[^}]*\}\s+from\s+"\.\/[\w-]+\.ts"\n/gm

/** One runtime module's source, without its imports of its siblings. */
function moduleSource(name: string): string {
	const text = readFileSync(new URL(`../../runtime/ts/${name}.ts`, import.meta.url), "utf8")
	return text.replace(SIBLING_IMPORT, "").trim()
}

/** The whole runtime as one module: what `runtime.gen.ts` holds. */
export function runtimeSource(): string {
	return `${RUNTIME_MODULES.map(moduleSource).join("\n\n")}\n`
}
