Progress for honey-codegen-v2 created on 2026-03-13 18:55

<!-- session: pending -->
<!-- spec: .claude/specs/honey-codegen-v2.md -->

## Log

- [x] (2026-03-13 19:05) (plan) Refined spec with implementation details
- [x] (2026-03-13 19:07) (impl) Replaced introspectSchema → schemaToJsonSchema with z.toJSONSchema()
- [x] (2026-03-13 19:07) (impl) Fixed OpenAPI input mapping: search→query, headers→header, cookies→cookie params
- [x] (2026-03-13 19:07) (impl) Moved generateRouteTree from plugin.ts to codegen.ts
- [x] (2026-03-13 19:07) (impl) Extended CLI with --openapi-title/--openapi-version and --tree flags
- [x] (2026-03-13 19:07) (impl) Added Vite plugin file-writing mode (dev + build)
- [x] (2026-03-13 19:07) (impl) Exported mergeTree from index.ts
- [x] (2026-03-13 19:07) (test) Updated tests for async generateOpenApi, removed honeyPlugin tests, added JSON Schema + query param tests
- [x] (2026-03-13 19:07) (verify) 475/475 tests pass, demo generates all 3 artifacts

## Files

- src/codegen.ts — schemaToJsonSchema, generateRouteTree, OpenAPI input mapping
- src/plugin.ts — async generateFromApp, file-writing Vite plugin
- src/cli.ts — multi-artifact CLI (types + openapi + tree)
- src/index.ts — mergeTree re-export
- tests/unit/codegen/codegen.test.ts — async OpenAPI tests, JSON Schema assertions
- tests/unit/plugin/plugin.test.ts — generateRouteTree + async generateFromApp
- tests/unit/plugin/vite-plugin.test.ts — async load/handleHotUpdate
