import { startHoneyServer } from "./serve.ts"
import { registerServeRuntime } from "./serve-slot.ts"

export type { HoneyServeOptions, ServeHandle } from "./serve.ts"
/** Starts a server for `app` on the given runtime. Production build entries call this directly. */
export { startHoneyServer }

export function enableServe(): void {
	registerServeRuntime((app, options) => startHoneyServer(app as never, options))
}

enableServe()
