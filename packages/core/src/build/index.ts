/** `@lovrozagar/honey/build`: the Vite plugins, honey() (the app's artifacts) and the build target plugin. */
export { type HoneyCodegenConfig, type HoneyOpenApiOutputConfig, type HoneyVitePluginConfig, honey } from "./plugin.ts"
export { type BuildApp, type BuildTarget, createBuildPlugin, type HoneyBuildConfig } from "./targets.ts"
