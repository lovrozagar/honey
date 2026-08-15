# Honey Core — Remaining Spec Gaps (Priority Order)

Status: 377 tests passing, 19 test files. All items complete.
Approach: TDD — RED tests first, then GREEN implementation.

---

## P0 — Critical (core API contract divergences) ✅

### 1. Global vs Chain `.use()` semantics ✅

### 2. `mergeTree` public API — construct Honey from merged tree ✅

### 3. `.meta()` shallow merge (not replace) ✅

### 4. `node.ts serve()` missing env param ✅

### 5. `ctx.search` return type divergence ✅

---

## P1 — High (codegen/OpenAPI — core value proposition) ✅

### 6. `generateManifest` errors aggregation ✅

### 7. `generateManifest` input/output as SchemaDefinition ✅

### 8. `generateOpenApi` with real schemas ✅

### 9. `extractSchemas` returning actual JSON Schema ✅

---

## P2 — Medium (type safety improvements) ✅

### 10. `TUsed` phantom type — prevent double `.input()`/`.output()` ✅

### 11. WSRouteBuilder.input() restriction — search/headers/cookies only ✅

### 12. RouteBuilder `.use()` typed — accept `MiddlewareFn<TCtx, TAdds>` not RuntimeMiddleware ✅

---

## P3 — Important (validation/error improvements) ✅

### 13. Error translation: field name i18n ✅

### 14. Validation: `DeclaredSchema`/`StreamSchema` runtime handling ✅

### 15. Validation: issue code extraction from vendor ✅

### 16. `onMiddleware` telemetry hook wiring ✅

---

## P4 — Build tooling (Vite plugin) ✅

### 17-20. Vite plugin lifecycle ✅

- `honeyVitePlugin()` with virtual module resolution, load, HMR, and build emission
- `generateFromApp()` bridge between runtime Honey instance and static code generation
- `collectRoutesFromTree()` walks TreeNode to extract RouteConfig[]
- Virtual modules: `virtual:honey/routes`, `virtual:honey/manifest`, `virtual:honey/openapi`
- `resolveId` / `load` for virtual module serving
- `handleHotUpdate` for dev-mode HMR invalidation via `routeFiles` glob patterns
- `generateBundle` for build-time artifact emission (manifest.json, openapi.json)
- Accepts lazy app factory `() => Honey` for deferred construction

---

## P5 — Polish ✅

### 21. OTEL adapter: `onMiddleware` span creation ✅

### 22. `RouteMeta` module augmentation pattern ✅

### 23. Body-aware input parsing ✅
