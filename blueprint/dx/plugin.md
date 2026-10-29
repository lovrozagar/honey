# dx — build plugin

`honey/plugin` is the build-time plugin (type generation, route-tree emission, codegen wiring). KEEP (bit 19 `build/{plugin,loaders,targets}.ts`). It is a **build-time** consumer of `@lovrozagar/honey-codegen` (H18.5) — never shipped to a serving request.

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| `honey(pluginOptions)` (vite/bundler) | — | — | wires type extraction + codegen into the build | runs in Node at build time; `ts-morph` is an optional peer loaded only here | `build/plugin.test.ts` |
| `generate` targets | no | all declared | which of the app's own artifacts to write: the route tree, the manifest, the OpenAPI JSON and YAML, the types; SDKs, the CLI and the standalone MCP server come from `honey-codegen generate`; the mounted MCP handler from `codegen.mcp` (bit 21) | the bundle targets are node, bun and cf | `build/targets.test.ts` |
| a Worker's named exports (cf target) | — | functions and objects passed on | **[bit 21 h]** the emitted Worker module re-exports every named export of the app's entry except the app itself, so wrangler bindings can name a Durable Object class, a `WorkerEntrypoint` or a `Workflow`; a function or object passes on as it is, any other value (a string, a number, a boolean, null) as an inert empty object, since workerd refuses to load a module with one such export; `default` stays honey's fetch handler; node and bun targets pass none | the plain-value substitution is silent: the Workers runtime never reads such an export and the app's own modules import the source, so nothing observes it; an entry exporting a `default` beside a named app export is refused at build time (the Worker's default would be lost); an entry the build cannot resolve is refused | `build/targets.test.ts`, `tests/build/targets.test.ts` |
| type generation | — | on | extract middleware ctx/chain types (calls `honey-codegen` `extract/`) | needs a TS honey app + `ts-morph` | `extract/extract.test.ts` |
| route-tree emission | — | on | emits the typed route tree (`honey-codegen` `emit/ts/route-tree.ts`) | consumed by the generated TS client | `build/plugin.test.ts` |
| config loading | — | jiti | loads `honey.config` via jiti | — | `build/loaders.test.ts` |
