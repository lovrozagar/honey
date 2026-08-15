import { startHoneyServer } from "./serve.ts"
import { registerServeRuntime } from "./serve-slot.ts"

export function enableServe(): void {
	registerServeRuntime((app, options) => startHoneyServer(app as never, options))
}

enableServe()
