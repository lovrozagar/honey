import { cfWebSocket } from "honey/ws/cloudflare"
import { loadE2eApp } from "../../apps/load.ts"

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
		return appFor(env).fetch(request, env, ctx)
	},
}
