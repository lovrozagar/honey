/**
 * The MCP e2e app (bit 21 e): routes.ts's five operations, and MCP mounted at /api/mcp on the handle under no guard,
 * its handler the plugin's own output. Its tools require the ApiKey scheme, so the mount authenticates before any
 * dispatch: a request without an `ApiKey <key>` credential is refused 401 there. The key itself is the inner routes'
 * to check, so a wrong one reaches them, and their 401 is the endpoint's. Bit 21 g: out-of-band uploads. Bit 21 h:
 * each at most 1 MiB, in `uploadStore`: this process's memory on bun and node, a Durable Object on a Worker
 * (uploads-object.ts), so every isolate claims and takes through one place.
 */
import type { WSAdapter } from "@lovrozagar/honey"
import { mcp } from "@lovrozagar/honey/mcp"
import { memoryUploadStore, type UploadStore, uploads } from "@lovrozagar/honey/mcp/uploads"
import { mcpHandler } from "./_gen/mcp.gen.ts"
import { UPLOAD_SECRET } from "./key.ts"
import { type AppOptions, createRoutes } from "./routes.ts"

export { KEY } from "./key.ts"

/** Each upload's cap: under a Durable Object's 2 MB value, where the Worker keeps the bytes. */
export const UPLOAD_MAX_BYTES = 1_048_576

/** The app with MCP mounted; a WebSocket adapter is taken as every e2e app's is, and unused. */
export function createApp(_wsAdapter?: WSAdapter, options?: AppOptions & { readonly uploadStore?: UploadStore }) {
	const app = createRoutes(options)
	return mcp(app, "/mcp", mcpHandler, {
		authenticate: (request) => /^ApiKey \S+$/.test(request.headers.get("authorization") ?? ""),
		uploads: uploads({
			maxBytes: UPLOAD_MAX_BYTES,
			secret: UPLOAD_SECRET,
			store: options?.uploadStore ?? memoryUploadStore(),
		}),
	})
}
