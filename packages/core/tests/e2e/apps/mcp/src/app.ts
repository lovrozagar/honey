/**
 * The MCP e2e app (bit 21 e): routes.ts's five operations, and MCP mounted at /api/mcp on the handle under no guard,
 * its handler the plugin's own output. Its tools require the ApiKey scheme, so the mount authenticates before any
 * dispatch: a request without an `ApiKey <key>` credential is refused 401 there. The key itself is the inner routes'
 * to check, so a wrong one reaches them, and their 401 is the endpoint's.
 */
import type { WSAdapter } from "@lovrozagar/honey"
import { mcp } from "@lovrozagar/honey/mcp"
import { mcpHandler } from "./_gen/mcp.gen.ts"
import { type AppOptions, createRoutes } from "./routes.ts"

export { KEY } from "./key.ts"

/** The app with MCP mounted; a WebSocket adapter is taken as every e2e app's is, and unused. */
export function createApp(_wsAdapter?: WSAdapter, options?: AppOptions) {
	const app = createRoutes(options)
	return mcp(app, "/mcp", mcpHandler, {
		authenticate: (request) => /^ApiKey \S+$/.test(request.headers.get("authorization") ?? ""),
	})
}
