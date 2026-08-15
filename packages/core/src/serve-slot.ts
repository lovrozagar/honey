import type { HoneyServeOptions, ServeHandle } from "./serve.ts"

export type ServeStart = (app: unknown, options?: HoneyServeOptions) => Promise<ServeHandle>

const MISSING = 'Honey.serve() requires `import "honey/serve"` in the app entry.'

let runtime: ServeStart | undefined

export function registerServeRuntime(next: ServeStart): void {
	runtime = next
}

export function resetServeRuntime(): void {
	runtime = undefined
}

export function getServeRuntime(): ServeStart {
	if (!runtime) throw new Error(MISSING)
	return runtime
}
