# The build plugin

`honey()` from `@lovrozagar/honey/plugin` is a Vite plugin. On each build it writes the app's own
artifacts: the typed route tree, the route manifest, the OpenAPI document as JSON and YAML, and the types the
generated clients read. The SDKs, the CLI and the MCP server come from `honey-codegen generate`, which reads that
document; see the code generation page. The config loads through jiti, so it may be TypeScript.

## Example

```ts
import { honey } from "@lovrozagar/honey/plugin"
import { defineConfig } from "vite"

export default defineConfig({
	plugins: [honey({ app: "src/app.ts" })],
})
```

## Reference

| Value                                 | Default      | What it does                                                                                                                                                            | Watch for                                                                   |
| ------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `honey(pluginOptions)` (vite/bundler) | —            | wires type extraction + codegen into the build                                                                                                                          | runs in Node at build time; `ts-morph` is an optional peer loaded only here |
| `generate` targets                    | all declared | which of the app's own artifacts to write: the route tree, the manifest, the OpenAPI JSON and YAML, the types; SDKs, the CLI and MCP come from `honey-codegen generate` | the bundle targets are node, bun and cf                                     |
| type generation                       | on           | extract middleware ctx/chain types (calls `honey-codegen` `extract/`)                                                                                                   | needs a TS honey app + `ts-morph`                                           |
| route-tree emission                   | on           | emits the typed route tree (`honey-codegen` `emit/ts/route-tree.ts`)                                                                                                    | consumed by the generated TS client                                         |
| config loading                        | jiti         | loads `honey.config` via jiti                                                                                                                                           | —                                                                           |
