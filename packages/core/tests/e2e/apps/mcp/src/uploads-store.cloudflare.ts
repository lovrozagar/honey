/**
 * The mcp app's UploadStore on a Worker (bit 21 h): uploads-object.ts's Durable Object store over the Worker's
 * MCP_UPLOADS binding, read at module scope from `cloudflare:workers` (an UploadStore takes no request env). Imported by
 * the Worker entries alone, so the bun and node hosts never reach `cloudflare:workers`.
 */
import { env } from "cloudflare:workers"
import { durableUploadStore, type UploadsNamespace } from "./uploads-object.ts"

/** The store each Worker request's uploads go through: one object an upload, shared by every isolate. */
export const workerUploadStore = () =>
	durableUploadStore(() => (env as unknown as { readonly MCP_UPLOADS: UploadsNamespace }).MCP_UPLOADS)
