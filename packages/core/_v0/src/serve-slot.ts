import { detectRuntime } from "./detect-runtime.ts"
import type { HoneyServeOptions, ServeHandle } from "./serve.ts"

export type ServeStart = (app: unknown, options?: HoneyServeOptions) => Promise<ServeHandle>

const MISSING = 'Honey.serve() requires `import "@lovrozagar/honey/serve"` in the app entry.'

/**
 * Set while codegen evaluates an app module. A global, not a module variable: the app may load a
 * different copy of this module than the generator (jiti instance, source vs compiled build).
 */
const CODEGEN = Symbol.for("@lovrozagar/honey.codegen")

let runtime: ServeStart | undefined

export function registerServeRuntime(next: ServeStart): void {
	runtime = next
}

export function resetServeRuntime(): void {
	runtime = undefined
}

export function getServeRuntime(): ServeStart {
	if (isCodegenProcess()) return codegenServe
	if (!runtime) throw new Error(MISSING)
	return runtime
}

/** Marks this process as running codegen: `app.serve()` resolves without listening. */
export function setCodegenProcess(active: boolean): void {
	const slot = globalThis as unknown as Record<symbol, unknown>
	if (active) slot[CODEGEN] = true
	else delete slot[CODEGEN]
}

export function isCodegenProcess(): boolean {
	return (globalThis as unknown as Record<symbol, unknown>)[CODEGEN] === true
}

/* codegen loads the app to read its routes; a top-level `await app.serve()` must not bind a port */
const codegenServe: ServeStart = async (_app, options = {}) => {
	let detected = options.runtime
	try {
		detected ??= detectRuntime()
	} catch {
		detected = "node"
	}
	const hostname = options.hostname ?? "127.0.0.1"
	const port = options.port ?? 3000
	return {
		async close() {},
		hostname,
		port,
		runtime: detected === "cloudflare" ? "node" : detected,
		url: `http://${hostname}:${port}`,
	}
}
