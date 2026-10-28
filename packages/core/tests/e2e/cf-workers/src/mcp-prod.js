/**
 * The mcp e2e app's Worker in prod (bit 21 h): the app's built cloudflare bundle as it is, beside the Durable Object
 * class its MCP_UPLOADS binding names (wrangler.web.jsonc). honey's build emits a Worker whose only export is its
 * default `{ fetch }`, and a Worker must export its object classes from its main module, so this module does both.
 * The local prod cell serves it, and the live leg (b21 h-live) deploys it.
 */
export { default } from "../../apps/mcp/dist/cloudflare/index.js"
export { McpUploads } from "../../apps/mcp/src/uploads-object.ts"
