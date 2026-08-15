# Honey Codegen v2 — Full Static Generation Pipeline

## Goal

Extend honey's codegen from types-only to a full static generation pipeline. CLI emits three artifacts (types, OpenAPI spec, static route tree). Vite plugin watches source and regenerates all artifacts on save. Gateway merge utility for composing route trees from multiple services.

## Scope

### In

- **CLI** — extend `honey generate` to emit all 3 artifacts
- **OpenAPI generator** — fix `introspectSchema()` → real JSON Schema via `z.toJSONSchema()`
- **OpenAPI input mapping** — `search` → query params, `header` → header params, `cookie` → cookie params
- **Static route tree** — already exists in plugin.ts, wire to CLI
- **Vite plugin** — file-writing mode for dev (types + openapi + tree to disk on save)
- **Gateway merge** — export `mergeTree` from main index

### Out

- Runtime route registration changes
- Client SDK generation
- Auth/security scheme generation for OpenAPI

## Implementation Plan

### Steps

- [ ] 1. Replace `introspectSchema()` with `schemaToJsonSchema()` — `src/codegen.ts:94-101`
- [ ] 2. Fix OpenAPI input mapping (search → query, header → header, cookie → cookie) — `src/codegen.ts:234-247`
- [ ] 3. Extend CLI with `--openapi`, `--tree` flags — `src/cli.ts`
- [ ] 4. Move `generateRouteTree()` from plugin.ts to codegen.ts (CLI needs it without Vite dep) — `src/plugin.ts:69-183` → `src/codegen.ts`
- [ ] 5. Add file-writing to Vite plugin dev mode — `src/plugin.ts` `configureServer` hook
- [ ] 6. Export `mergeTree` from `src/index.ts`
- [ ] 7. Update demo app to test all 3 artifacts
- [ ] 8. Unit tests for JSON Schema conversion + CLI multi-artifact

### Patterns

- `generateTypes()` pattern: walk tree, collect routes, emit code — `src/codegen.ts:382`
- `honeyVitePlugin()` pattern: virtual modules + HMR — `src/plugin.ts:270`
- CLI `parseArgs` pattern: `--flag value` pairs — `src/cli.ts:15`

### Types / Interfaces

- `StandardSchemaLike` — `src/types.ts` — schema interface for introspection
- `InputSchemaEntry` — `src/types.ts` — tagged or raw schema entries
- `RouteHandler` — `src/tree.ts` — handler with `iv` (input validators), `os` (output schemas)
- `TreeNode` — `src/tree.ts` — radix tree node structure

### Edge Cases

- Non-Zod StandardSchema: check `schema["~standard"].vendor` before calling `z.toJSONSchema()`, fallback to metadata
- Tagged input entries (`{ _tag, schema }`): unwrap before JSON Schema conversion
- `search` schemas are Zod objects — decompose properties into individual query parameters
- Routes with no input/output: already handled as empty `{}`
- Optional path params (`:id?`): mark as `required: false` in OpenAPI

## Decisions

- CLI is the core, Vite plugin wraps it
- All 3 artifacts from single `honey generate` invocation (flags control which)
- Static tree is a JS module (not JSON) for tree-shaking
- OpenAPI uses Zod v4's `z.toJSONSchema()` for schema conversion
- `generateRouteTree()` moves to codegen.ts so CLI can use it without Vite
- Non-Zod schemas get metadata fallback (not JSON Schema)

## Discovered

- `introspectSchema()` currently returns only `{ types, vendor, version }` metadata — NOT actual JSON Schema
- OpenAPI generator only maps `json` input → requestBody, ignores `search`/`header`/`cookie`
- `generateRouteTree()` lives in plugin.ts, needs to move to codegen.ts for CLI access
- Zod v4.3.6 installed with `toJSONSchema()` available via `import { toJSONSchema } from "zod"`
- `mergeTree()` exists in tree.ts but not exported from index

## Rejected

- Putting JSON Schema in manifest (manifest keeps metadata, OpenAPI gets real schemas)
- Making static tree JSON (JS module enables tree-shaking)
