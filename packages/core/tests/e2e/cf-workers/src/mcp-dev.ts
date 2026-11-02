/**
 * The mcp e2e app's Worker in dev (bit 21 h): the app from source with its uploads in Durable Objects, and the object
 * class the MCP_UPLOADS binding names (wrangler.mcp.jsonc). Its own entry, so worker.ts, which the shared
 * wrangler.jsonc deploys as honey-cf-e2e, carries no Durable Object.
 */
import { createApp } from "@honey/e2e-mcp"
import { workersWebSocket } from "@lovrozagar/honey/ws/workers"
import { workerUploadStore } from "../../apps/mcp/src/uploads-store.workers.ts"

export { McpUploads } from "../../apps/mcp/src/uploads-object.ts"

const app = createApp(workersWebSocket(), { uploadStore: workerUploadStore() })

export default {
	fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext) {
		return app.fetch(request, env as never, ctx)
	},
}
