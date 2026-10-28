/** The cloudflare bundle's entry: the app with MCP mounted at /api/mcp, its uploads in the Worker's Durable Objects. */
import { createApp } from "./app.ts"
import { workerUploadStore } from "./uploads-store.cloudflare.ts"

export const app = createApp(undefined, { uploadStore: workerUploadStore() })
