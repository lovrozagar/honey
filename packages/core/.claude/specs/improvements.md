# Honey Improvements

## 1. Error Types in Generated Routes

The error contract (`defineErrors` + `.errors()`) is one of honey's best features but the gen file doesn't include it. Add `errors` to each route record.

Generated output:

```ts
export type Routes = {
	"/orgs": {
		post: {
			ctx: BaseCtx & { input: { json: { name: string; slug: string } } }
			errors: "org_slug_taken" | "org_limit_reached" | "invalid_input"
			input: { json: { name: string; slug: string } }
			meta: { auth: "required" }
			output: {}
		}
	}
}
```

Enables:

- RPC client typed error handling: `if (err.errorKey === "org_slug_taken") { ... }`
- Service layer can declare which errors it may throw
- Client-side exhaustive error matching

## 2. RPC Client

Type-safe HTTP client generated from `Routes` type map. Zero codegen — pure type inference from the existing gen file.

```ts
const client = createClient<Routes>(baseUrl)
const orgs = await client["/orgs"].get({ search: { limit: 10, offset: 0 } })
/*           ^^ typed: { items: string[], total: number }                  */
```

- Path-indexed, method-chained API
- Input types enforced from route's `input` shape
- Output types inferred from route's `output` shape
- Error types narrowed per route (see #1)
- Params extracted from path string, interpolated into URL
- Standard `fetch` under the hood, configurable headers/interceptors
- Export from `honey/client`

## 3. Consolidate RouteBuilder Generics

Current: 12 generic params → brutal error messages, hard to extend.

```ts
class RouteBuilder<TEnv, TCtx, TInput, TErrorKeys, TOutput, TPath, TMethod, TRoutes, TUsed, TBaseCtx, TMeta, TAccMeta>
```

Proposed: single state generic with mapped type updates.

```ts
type BuilderState = {
	accMeta: Record<string, unknown>
	baseCtx: unknown
	ctx: unknown
	env: unknown
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
	input<T>(
		schemas: T,
	): RouteBuilder<Omit<S, "input" | "used"> & { input: S["input"] & InferInputMap<T>; used: S["used"] | "input" }>
}
```

Benefits:

- Single generic in error messages
- Adding new state fields doesn't change the class signature
- Easier to reason about builder state transitions

## 4. Static Route Tree Boot Patching

Generated tree emits `fn: null as unknown as RouteHandler["fn"]` with "patched at boot" comment but no patching code exists. Two options:

**Option A: Wire up patching** — generate a `patchTree(tree, handlers)` function that maps route keys to imported handler functions at startup. Enables true zero-cost route registration in production (no tree building).

**Option B: Drop static tree codegen** — remove `generateRouteTree` / `generateRouteTreeFromApp` until the patching story is complete. The runtime tree building is fast enough and avoids the null-handler footgun.

Recommendation: Option A if perf matters for cold start (CF Workers), Option B otherwise.

## 5. Middleware Dependency Validation

Currently nothing prevents using context properties that aren't in the chain:

```ts
/* compiles but crashes — withAuth not in chain */
base.get("/x").handler((c) => c.user.id)
```

Proposed: `requires<T>()` marker on middleware definitions.

```ts
const withAuth = defineMiddleware({
  requires: {} as { db: Db },  /* phantom — must be in chain before this */
  fn: async ({ ctx, next }) => { ... }
})
```

TypeScript would enforce ordering: `.use(withAuth)` only compiles if `TCtx` already extends `{ db: Db }`.

Note: this already partially works via `MiddlewareFn<TReqs, TAdds>` where `TReqs` is the required context — but `createMiddleware` erases it to `{}`. The fix is making `createMiddleware` preserve `TReqs`.

## 6. `as unknown as` Cleanup

Multiple places use `as unknown as` (banned in CLAUDE.md):

- `Honey.meta()` — type-level only transform, returns `this` cast
- `Honey.route()` — same pattern
- `RouteBuilder` constructor calls

These exist because the builder needs to "rewrite" generic params without constructing a new instance. Options:

- Accept as pragmatic exception, document why in a block comment
- Explore branded phantom approach where the class is generic over a single state type (ties into #3)
- Use `Object.assign` + prototype tricks to create genuinely new typed instances

Likely best resolved as part of #3 — consolidating generics reduces the number of cast sites.
