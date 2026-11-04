/**
 * `@lovrozagar/honey/plugin`: `honeyPlugin()`, the Vite plugin, and its config types. The generation runner the CLI shares
 * with it stays internal.
 */
export {
	type HoneyCodegenConfig,
	type HoneyOpenApiOutputConfig,
	type HoneyVitePlugin,
	type HoneyVitePluginConfig,
	honeyPlugin,
} from "./plugin.ts"
