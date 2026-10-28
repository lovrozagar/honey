/**
 * The cloudflare bundle's entry: the app with MCP mounted at /api/mcp, its uploads in the Worker's Durable Objects,
 * and the object class itself, which honey's build exports from the Worker beside its default fetch (bit 21 h).
 */
import { createApp } from "./app.ts"
import { workerUploadStore } from "./uploads-store.cloudflare.ts"

export { McpUploads } from "./uploads-object.ts"

export const app = createApp(undefined, { uploadStore: workerUploadStore() })
