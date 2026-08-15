import { cfWebSocket } from "honey/ws/cloudflare"
import { createApp } from "@honey/e2e-app"

const app = createApp(cfWebSocket())

export default {
	fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext) {
		return app.fetch(request, env, ctx)
	},
}
