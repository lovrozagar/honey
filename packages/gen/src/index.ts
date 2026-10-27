/**
 * `@lovrozagar/honey-codegen`'s module entry (bit 19 h2): what core's build plugin imports, dynamically, to write an
 * app's artifacts (the route tree, the types, each file only when it changed). The SDK, CLI and MCP generators stay
 * behind the `honey-codegen` bin.
 */
export { type ExtractedTypes, type ExtractOptions, extractTypes, loadTsMorph } from "./extract/extract.ts"
export { generateRouteTree, type RouteTreeV2 } from "./emit/ts/route-tree.ts"
export { type GenerateTypesOptions, generateTypes } from "./emit/ts/type-gen.ts"
export { writeFileIfChanged } from "./gen/write.ts"
