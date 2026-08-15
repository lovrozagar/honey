# Honey Next — Codegen Standalone, Builder Generics, Middleware Safety

## Goal

Four focused improvements: always-standalone codegen (no import mode), consolidated RouteBuilder generics, type-safe middleware dependencies, and cast cleanup.

## Scope

- **In**: standalone codegen only, CLI `--manifest` flag, single `BuilderState` generic, `createMiddleware` with `TReqs`, cast reduction
- **Out**: RPC client (separate spec), runtime perf optimizations, new API features

---

## 1. Always-Standalone Codegen

### Problem

`generateTypes` has two code paths (standalone vs import mode). Import mode creates circular dependencies when services import from the gen file and the gen file imports from user code. The CLI has `detectBaseExport` which hardcodes `"base"` as the preferred export — fragile and wrong for apps that don't use that name.

### Design

Remove import mode entirely. Always use ts-morph extraction. When ts-morph fails (missing devDependency), fall back to `Record<string, unknown>` for env type and `null` for middleware — still standalone, just less specific.

```typescript
/* before — two branches */
if (extracted) {
	/* standalone: inline types */
} else {
	/* import mode: import { InferCtx } from user code — causes circular deps */
}

/* after — always standalone */
const envType = extracted?.envType ?? "Record<string, unknown>"
const mwType = extracted?.middlewareType ?? null
/* always emit inline types, never import from user code */
```

### CLI Changes

- Remove `detectBaseExport` — always use `--export` target (defaults to `"app"`)
- Add `--manifest` flag (function exists in codegen but CLI doesn't expose it)
- Remove import-mode fallback code

### Files

| File             | Change                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------- |
| `src/codegen.ts` | Remove import-mode branch from `generateTypes` if one exists                           |
| `src/cli.ts`     | Remove `detectBaseExport`, simplify to always use `--export`, already has `--manifest` |
| `src/plugin.ts`  | Verify plugin already uses standalone mode only                                        |
| Tests            | Update expectations if any test asserts import-mode output                             |

---

## 2. Consolidate RouteBuilder Generics

### Problem

RouteBuilder has 14 generic parameters:

```typescript
class RouteBuilder<
  TEnv, TCtx, TInput, _TErrorKeys, TOutput, TPath, TMethod,
  TRoutes, TUsed, TBaseCtx, TMeta, TAccMeta, TErrorFactory, TDefaultErrors
>
```

Every method returns a new RouteBuilder with all 14 re-specified. Error messages are unreadable. Adding a new state field requires touching every method signature.

### Design

Single `BuilderState` object type:

```typescript
type BuilderState = {
  accMeta: Record<string, unknown>
  baseCtx: unknown
  ctx: unknown
  defaultErrors: string
  env: unknown
  errorFactory: unknown
  errorKeys: string
  input: unknown
  meta: unknown
  method: string
  output: unknown
  path: string
  routes: unknown
  used: string
}

class RouteBuilder<S extends BuilderState> {
  input<T extends InputSchemasDef>(
    schemas: "input" extends S["used"] ? never : T,
  ): RouteBuilder<S & { input: S["input"] & InferInputMap<T>; used: S["used"] | "input" }>

  output<T extends OutputSchemaDef>(
    schemas: "output" extends S["used"] ? never : T,
  ): RouteBuilder<S & { output: T; used: S["used"] | "output" }>

  errors(...keys: ...): RouteBuilder<S & { errorKeys: S["errorKeys"] | TKeys }>

  meta<T>(meta: T): RouteBuilder<S & { accMeta: S["accMeta"] & T }>

  handler(fn: (ctx: HandlerCtx<S>) => HoneyResponse | Promise<HoneyResponse>): Honey<...>
}
```

`HandlerCtx<S>` derives the full context from the state:

```typescript
type HandlerCtx<S extends BuilderState> = ApplyOutput<
	ApplyParams<
		[keyof S["input"]] extends [never] ? S["ctx"] : S["ctx"] & { input: S["input"] },
		ParamsFromPath<S["path"] & string>
	> & {
		readonly meta: Readonly<Omit<S["accMeta"], "openApi">>
	} & ErrorFactoryCtx<S["errorFactory"], S["errorKeys"] | S["defaultErrors"]>,
	S["output"]
>
```

### Migration strategy

1. Define `BuilderState` type
2. Create `type UpdateState<S, Updates>` = `Omit<S, keyof Updates> & Updates`
3. Rewrite RouteBuilder class with single `S extends BuilderState`
4. Each method returns `RouteBuilder<UpdateState<S, { changed fields }>>`
5. Update `_registerRoute` to construct initial state
6. Update `handler()` to derive types from `S`
7. Honey class methods that return RouteBuilder need updated generics

### Same pattern for Honey class

Honey has 6 generics: `TEnv, TCtx, TRoutes, TMeta, TErrorFactory, TDefaultErrors`. Same consolidation:

```typescript
type HoneyState = {
  ctx: unknown
  defaultErrors: string
  env: unknown
  errorFactory: unknown
  meta: unknown
  routes: unknown
}

class Honey<S extends HoneyState> { ... }
```

### Error message improvement

Before:

```
Type 'RouteBuilder<Env, HoneyContext<Env> & { db: Db } & { user: User }, { search: { q: string } }, "not_found", { "application/json": { ok: ... } }, "/orgs", "GET", { ... }, "input" | "output", HoneyContext<Env> & { db: Db }, AppMeta, { auth: "required" }, ErrorFactory, "internal_server_error">' ...
```

After:

```
Type 'RouteBuilder<{ env: Env; ctx: ...; input: { search: { q: string } }; output: ...; path: "/orgs"; method: "GET"; ... }>' ...
```

Single generic, named fields — immediately readable.

### Files

| File             | Change                                                         |
| ---------------- | -------------------------------------------------------------- |
| `src/index.ts`   | Rewrite `RouteBuilder` and `Honey` with single state generic   |
| `src/index.ts`   | Update `HandlerCtx` to accept `BuilderState`                   |
| `src/index.ts`   | Update `ApplyOutput`, `ApplyParams` if needed                  |
| `src/codegen.ts` | Update `generateTypes` signature (accepts `Honey<HoneyState>`) |
| Tests            | Type-level tests may need updating for new generic shape       |

---

## 3. Middleware Dependency Validation

### Problem

`createMiddleware` erases `TReqs` to `{}`:

```typescript
export function createMiddleware<TAdds>(fn: ...): MiddlewareFn<{}, TAdds>
```

This means any middleware can be `.use()`'d anywhere, even if it requires context from a prior middleware:

```typescript
const withAuth = createMiddleware(async ({ ctx, next }) => {
	const token = ctx.req.headers.get("authorization") /* works */
	const db = ctx.db /* runtime crash — db not in chain yet */
	return next({ user: { id: "1" } })
})

/* compiles fine, crashes at runtime */
honey()
	.use(withAuth)
	.get("/x")
	.handler((c) => c.res.json("ok", {}))
```

### Design

Add `TReqs` parameter to `createMiddleware`:

```typescript
export function createMiddleware<TReqs, TAdds>(
	fn: (opts: {
		ctx: TReqs & { req: Request; res: HoneyRes }
		next: <T>(additions: T) => Promise<MiddlewareResult<T>>
	}) => Promise<MiddlewareResult<TAdds>>,
): MiddlewareFn<TReqs, TAdds>
```

TypeScript infers `TReqs` from what `ctx` accesses in the callback. Then `Honey.use()` enforces:

```typescript
use<TAdds>(
  mw: MiddlewareFn<TCtx, TAdds>,  /* TCtx must satisfy TReqs */
): Honey<...>
```

If `TReqs` includes `{ db: Db }` but `TCtx` doesn't have it, TypeScript errors:

```typescript
/* TS error: Property 'db' is missing in type 'HoneyContext<Env>' */
honey<Env>().use(withAuth)
```

But this compiles:

```typescript
honey<Env>().use(withDb).use(withAuth) /* ✓ withDb adds { db: Db } */
```

### Inference challenge

The tricky part: TypeScript needs to infer `TReqs` from the callback's `ctx` usage without explicit annotation. This works because:

```typescript
createMiddleware(async ({ ctx, next }) => {
	ctx.db.query("...") /* TS infers TReqs must include { db: { query: ... } } */
	return next({ user: { id: "1" } })
})
```

TypeScript's contextual typing infers the callback parameter type, which flows back to `TReqs`.

### Backwards compatibility

Existing middleware using `createMiddleware` without accessing `ctx` keeps `TReqs = {}` (no requirements). Middleware accessing `ctx.req` automatically requires `{ req: Request }` which `HoneyContext` satisfies. No breaking changes.

### Files

| File                | Change                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/middleware.ts` | Update `createMiddleware` signature to preserve `TReqs`                                                             |
| `src/index.ts`      | `Honey.use()` and `RouteBuilder.use()` already constrain `MiddlewareFn<TCtx, TAdds>` — verify `TReqs` flows through |
| Tests               | New type-level tests for middleware ordering enforcement                                                            |

---

## 4. Cast Cleanup

### Problem

14 `as unknown as` sites in `index.ts` (banned by code style). Most exist because builder methods need to return `this` with different generic params.

### Design

Most casts disappear with the generics consolidation (#2). The remaining ones:

**Context property injection** (lines 656-671):

```typescript
;(ctx as unknown as Record<string, unknown>).meta = Object.freeze(handler.mt ?? {})
;(ctx as unknown as Record<string, unknown>).errors = handler.ef
```

Fix: add a `set` method or use `Object.defineProperty` which doesn't require type assertion:

```typescript
Object.defineProperty(ctx, "meta", { value: Object.freeze(handler.mt ?? {}) })
Object.defineProperty(ctx, "errors", { value: handler.ef })
```

**executeChain bridge** (line 710):

```typescript
ctx as unknown as Record<string, unknown>
```

Fix: `executeChain` should accept `unknown` for ctx since it just passes it through:

```typescript
function executeChain(
	middlewares: RuntimeMiddleware[],
	ctx: unknown,
	handler: (ctx: unknown) => Response | Promise<Response>,
): Promise<Response>
```

**Parent access** (line 1098):

```typescript
;(this._s.parent as unknown as { _errorFactory: unknown })._errorFactory
```

Fix: add a getter or make `_errorFactory` accessible via a typed method on `Honey`:

```typescript
/* add to Honey class */
/** @internal */
get _factory(): unknown { return this._errorFactory }
```

### Files

| File                | Change                                                              |
| ------------------- | ------------------------------------------------------------------- |
| `src/index.ts`      | Replace casts with `Object.defineProperty`, typed getters, generics |
| `src/middleware.ts` | Widen `executeChain` ctx parameter                                  |

---

## Implementation Order

1. **Codegen standalone** — smallest scope, independent, unblocks CLI parity
2. **Builder generics** — biggest structural change, do before adding more features
3. **Cast cleanup** — falls out naturally from #2, mop up remaining
4. **Middleware deps** — builds on consolidated generics for cleaner implementation

## Decisions

| Decision                                       | Rationale                                                       |
| ---------------------------------------------- | --------------------------------------------------------------- |
| Always standalone codegen                      | Import mode causes circular deps, standalone works everywhere   |
| Single `BuilderState` generic                  | Readable errors, extensible, every method is simpler            |
| Same pattern for Honey class                   | Consistency, same benefits                                      |
| `createMiddleware` preserves `TReqs`           | Type inference catches middleware ordering bugs at compile time |
| `Object.defineProperty` over casts             | Achieves the same mutation without type assertions              |
| Order: codegen → generics → casts → middleware | Each builds on the previous, smallest-to-largest risk           |

## Rejected

| Rejected                                | Why                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Keep import mode as fallback            | Creates circular dependencies, standalone with `Record<string, unknown>` is better than broken imports |
| Separate state types per builder method | Overcomplicates — single `BuilderState` with `UpdateState` helper is sufficient                        |
| Runtime middleware dependency checking  | Type-level enforcement is zero-cost and catches errors earlier                                         |
| `Proxy`-based builder pattern           | Too clever, worse debuggability, no real benefit over class + generics                                 |
