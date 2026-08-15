# Test Type Safety — Fix All 43 TS Errors in Test Files

## Goal

Zero `tsc --noEmit` errors across all source AND test files. Every test should compile under strict TypeScript — not just pass at runtime via vitest (which skips type checking).

## Current State

- Source files: 0 TS errors
- Test files: 43 TS errors across 8 files
- Tests: 548 passing (vitest doesn't type-check)

## Error Categories

### 1. Response API — method restriction on output-declared routes (1 error)

`output-validation.test.ts:72` — `ctx.res.text()` called on JSON-only output route. `ApplyOutput` correctly removes `text` when only `"application/json"` declared.

**Fix**: test intentionally returns wrong content-type. Use `ctx.res.raw(new Response(...))` to bypass type restriction (tests runtime validation, not type safety).

### 2. Plugin return type — `Record<string, unknown>` (17 errors)

`vite-plugin.test.ts` — plugin object typed as `Record<string, unknown>`, so `.resolveId()`, `.buildStart()`, `.configResolved()`, `.load()`, `.hotUpdate()` are all `unknown`.

**Fix**: define a `HoneyVitePlugin` type in `plugin.ts` with the methods the plugin implements. Return that type instead of `Record<string, unknown>`. This was a hack from when we removed the `VitePlugin` import.

```typescript
type HoneyVitePlugin = {
	buildStart(): Promise<void>
	configResolved(cfg: { root: string }): void
	hotUpdate?(ctx: { file: string; modules: unknown[]; server: { moduleGraph: { invalidateAll(): void } } }): void
	load?(id: string): string | undefined
	name: string
	resolveId?(id: string): string | undefined
}
```

### 3. Meta field restrictions — `DefaultMeta` too strict (6 errors)

`codegen.test.ts:92,263,276,286` and `core.test.ts:663,664` — tests use `.meta({ description: "...", tags: [...] })` but `DefaultMeta` only has `openApi?: OpenApiMeta`. Custom fields are rejected.

**Root cause**: tests don't call `.meta<CustomType>()` first to declare the meta shape. Without the type parameter, only `DefaultMeta` fields are allowed.

**Fix**: two options:

- A) Tests call `.meta<{ description?: string; tags?: string[] }>()` on the honey instance first
- B) Tests nest fields correctly: `.meta({ openApi: { description: "...", tags: [...] } })`

Option B is correct — `description` and `tags` belong in `openApi`, not at the root. The tests are wrong. For custom fields like `path` and `note` in codegen tests, declare the meta type first.

### 4. GenerateTypes missing `appExport` (2 errors)

`codegen.test.ts:266,279` — `generateTypes(h, { appImport: "./app" })` missing required `appExport` field.

**Fix**: add `appExport: "app"` to the options.

### 5. Middleware context type flow (2 errors)

`core.test.ts:408,638` — middleware adds `{ db: string }` via `next()` but the handler's `ctx.db` type is unknown because the middleware is typed as a plain async function, not via `createMiddleware`.

**Fix**: either:

- A) Use `createMiddleware` which properly types `TAdds`
- B) Use `h.use(withDb)` where `withDb` has typed return — the chain on `chain.get(...)` gets the added type

These tests use inline `async ({ next }) => next({ db: "connected" })` without going through `createMiddleware`. The fix is to use `createMiddleware`:

```typescript
const withDb = createMiddleware(async ({ next }) => next({ db: "connected" }))
const chain = h.use(withDb)
chain.get("/test").handler((ctx) => ctx.res.text("ok", ctx.db))
```

### 6. Pre-existing unrelated errors (15 errors)

**`meta-codegen.test.ts` (8 errors)** — `JSON.parse()` returns `unknown`, tests access properties without narrowing.

**Fix**: cast parse result: `const data = JSON.parse(result) as Record<string, unknown>`, then access with narrowing.

**`type-emitter.test.ts:167` (1 error)** — `ZodNumber` not assignable to `$ZodType`. Zod version mismatch between test expectations and actual API.

**Fix**: use correct Zod v4 API or adjust the test schema.

**`double-next.test.ts:32` (1 error)** — middleware function cast doesn't match `MiddlewareFn` signature.

**Fix**: use `createMiddleware` wrapper or fix the function signature.

**`ws-keepalive.test.ts:34` (1 error)** — `import.meta.dir` not in standard TS types.

**Fix**: add `/// <reference types="bun-types" />` or use `__dirname` equivalent.

**`codegen.test.ts:266,279,289` (4 more errors)** — additional `generateTypes` option mismatches.

**Fix**: provide all required fields.

## Implementation Order

1. **Plugin type** (17 errors → 0) — biggest bang, define `HoneyVitePlugin`, update return type
2. **Meta field fixes** (6 errors → 0) — move fields to `openApi` or declare meta type
3. **Codegen test options** (2+ errors → 0) — add missing `appExport` fields
4. **Middleware test typing** (2 errors → 0) — use `createMiddleware` properly
5. **Response API test** (1 error → 0) — use `ctx.res.raw()` for intentional bypass
6. **JSON.parse narrowing** (8 errors → 0) — type-safe parse results
7. **Remaining 4** — type-emitter zod, double-next cast, ws-keepalive import.meta, codegen options

## Verification

After each fix:

- `npx vitest run` — all 548+ tests pass
- `bunx tsc --noEmit 2>&1 | grep "error TS" | grep -v node_modules | wc -l` — target: 0

## Files to Change

| File                                           | Errors                        | Category                      |
| ---------------------------------------------- | ----------------------------- | ----------------------------- |
| `src/plugin.ts`                                | 0 (but causes 17 test errors) | Define `HoneyVitePlugin` type |
| `tests/unit/plugin/vite-plugin.test.ts`        | 17                            | Use typed plugin              |
| `tests/unit/codegen/codegen.test.ts`           | 6                             | Meta fields + options         |
| `tests/unit/core/core.test.ts`                 | 4                             | Meta + middleware             |
| `tests/unit/meta/meta-codegen.test.ts`         | 8                             | JSON.parse narrowing          |
| `tests/unit/builder/output-validation.test.ts` | 1                             | Use raw() for bypass          |
| `tests/unit/codegen/type-emitter.test.ts`      | 1                             | Zod v4 API                    |
| `tests/unit/middleware/double-next.test.ts`    | 1                             | Middleware signature          |
| `tests/unit/ws/ws-keepalive.test.ts`           | 1                             | import.meta.dir               |
