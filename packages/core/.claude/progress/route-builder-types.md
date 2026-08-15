Progress for route-builder-types — 2026-03-13

<!-- session: complete -->

## Completed

- [x] StandardSchemaLike shared type (types.ts) — aligned with StandardSchemaV1
- [x] InputSchemasDef replaces old function-based InputValidators (tree.ts)
- [x] .input() → InferOutput from Zod/Standard Schema → ctx.input.search.id typed
- [x] .errors(factory, ...keys) → keys constrained to factory keys, autocomplete works
- [x] .output({ "application/json": { ok: schema } }) → ctx.json("ok", data) status key + data typed
- [x] OutputSchemaDef with StatusKey autocomplete + 12 content-type suggestions
- [x] .handler() returns Honey instance with accumulated route types
- [x] validateInput() wired in fetch() as internal middleware
- [x] runSchema/validateOutput made async for Zod v4 compat
- [x] Path param inference — "/users/:id" → ctx.params.id typed via ParamsFromPath<TPath>
- [x] Route type accumulation — TRoutes on Honey, RouteRecord, InferRoutes, $routes phantom
- [x] Output validation wiring — validateOutput() called at runtime when outputValidation != "off"
- [x] Middleware requirement enforcement — MiddlewareFn uses function type syntax for contravariance
- [x] RouteMeta extensibility — mt field on RouteHandler, .meta() stores and codegen serializes
- [x] Codegen schema serialization — input sources + output content-types/status-keys in manifest
- [x] MiddlewareFn.errors tied to error factory — defineMiddleware() constrains keys, TErrors generic
- [x] 317 tests passing, 0 tsc errors, 0 biome errors

## Files touched

- src/types.ts — StandardSchemaLike, InferOutput, InferInputMap, InputSchemasDef, OutputSchemaDef, ParamsFromPath, RouteRecord, InferRoutes
- src/tree.ts — InputSchemasDef replaces InputValidators, mt/os fields on RouteHandler, OutputSchemaDef import
- src/validation.ts — async runSchema, imports from types.ts
- src/middleware.ts — MiddlewareFn function type syntax (contravariance), TErrors generic, defineMiddleware()
- src/index.ts — RouteBuilder 8 generics, HandlerCtx, ApplyOutput, ApplyParams, TRoutes on Honey, route accumulation
- src/codegen.ts — meta/input/output serialization in generateManifest
- tests/unit/builder/builder.test.ts — 27 tests (type + runtime, path params, route accumulation, middleware enforcement)
- tests/unit/builder/output-validation.test.ts — 7 tests (output validation wiring)
- tests/unit/codegen/codegen.test.ts — 14 tests (+ meta/input/output serialization)
- tests/unit/core/core.test.ts — fixed middleware types for contravariance
- tests/unit/tree/tree.test.ts — added mt/os fields to fixtures
- tests/unit/tree/param-decode.test.ts — added mt/os fields to fixtures
- tests/unit/validation/validation.test.ts — async validateOutput tests
