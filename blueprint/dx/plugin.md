# dx — build plugin

`honey/plugin` is the build-time plugin (type generation, route-tree emission, codegen wiring). KEEP (bit 19 `build/{plugin,loaders,targets}.ts`). It is a **build-time** consumer of `@lovrozagar/honey-codegen` (H18.5) — never shipped to a serving request.

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| `honey(pluginOptions)` (vite/bundler) | — | — | wires type extraction + codegen into the build | runs in Node at build time; `ts-morph` is an optional peer loaded only here | `build/plugin.test.ts` |
| `generate` targets | no | all declared | which of the app's own artifacts to write: the route tree, the manifest, the OpenAPI JSON and YAML, the types; SDKs, the CLI and the standalone MCP server come from `honey-codegen generate`; the mounted MCP handler from `codegen.mcp` (bit 21) | the bundle targets are node, bun and cf | `build/targets.test.ts` |
| type generation | — | on | extract middleware ctx/chain types (calls `honey-codegen` `extract/`) | needs a TS honey app + `ts-morph` | `extract/extract.test.ts` |
| route-tree emission | — | on | emits the typed route tree (`honey-codegen` `emit/ts/route-tree.ts`) | consumed by the generated TS client | `build/plugin.test.ts` |
| config loading | — | jiti | loads `honey.config` via jiti | — | `build/loaders.test.ts` |
