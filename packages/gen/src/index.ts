/**
 * `@lovrozagar/honey-clients`'s module entry (bit 19 h2): what core's build plugin imports, dynamically, to write an
 * app's artifacts (the route tree, the types, each file only when it changed). The SDK, CLI and MCP server generators
 * stay behind the `honey-clients` bin. Bit 21 e: the MCP handler an app mounts is the plugin's `codegen.mcp` output.
 */
export { type ExtractedTypes, type ExtractOptions, extractTypes, loadTsMorph } from "./extract/extract.ts"
export { type GeneratedMcpHandler, generateMcpHandler } from "./emit/mcp/mounted.ts"
export { generateRouteTree, type RouteTreeV2 } from "./emit/ts/route-tree.ts"
export { type GenerateTypesOptions, generateTypes } from "./emit/ts/type-gen.ts"
export { generated, type GenerateContext, type GenerateRun, type Io, writeGenerated } from "./cli.ts"
export {
	type Options,
	type Target,
	TARGETS,
	type TargetOptions,
	type TargetOptionsSchema,
	targetOptionSchemas,
} from "./gen/targets.ts"
/* `writeTarget` writes one target's files into a directory the caller picks, keeping `MANIFEST` there: for a caller
   that lays out `generated`'s files itself rather than as `writeGenerated`'s `<out>/<target>` */
export { MANIFEST, writeFileIfChanged, type Written, writeTarget } from "./gen/write.ts"
