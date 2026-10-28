import { cfWebSocket } from "@lovrozagar/honey/ws/cloudflare"
import { loadE2eApp } from "../../load.ts"

type WorkerEnv = Record<string, unknown> & { HONEY_E2E_APP?: string }

let cached: { app: ReturnType<typeof loadE2eApp>; name: string } | null = null

function appFor(env: WorkerEnv) {
	const name = env.HONEY_E2E_APP ?? "kitchen"
	if (cached?.name === name) return cached.app
	const app = loadE2eApp(name, cfWebSocket())
	cached = { app, name }
	return app
}

export default {
	fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
		/* an app gets the worker's env, not the one it declares (compose's and surface's name vars no app reads), as
		 * serve() hands it `{}` on Bun and Node */
		return appFor(env).fetch(request, env as never, ctx)
	},
}
