# Honey Static Route Tree & Build-Time Optimization

## Goal

Eliminate runtime tree construction entirely. The Vite plugin pre-computes the full route tree at build time — trie structure, error Sets, meta — so the runtime just patches handler fns into existing nodes. No trie insertion, no node creation, no intermediate allocations.

## Scope

- In: `.routeTree()` API, patch-mode in `handler()`, enhanced codegen (pre-built ek/mt, handler map, unique handlers), pre-filtered error factory per route, remove `honey({ tree })` constructor option
- Out: Pre-compiled validators (phase 2), handler fn extraction from inline closures

## Problem

Current startup cost per route (200 routes = 1000+ allocations):

```
.get("/orgs")           → new RouteBuilder, trie traversal
  .meta({...})          → new RouteBuilder, object spread
  .input({...})         → new RouteBuilder, schema storage
  .output({...})        → new RouteBuilder, schema storage
  .handler(fn)          → new RouteBuilder, insertRoute(), middleware concat,
                           output validator closure, error Set construction
```

All deterministic. Same input → same output every time. Should be a build artifact.

## Design

### Constraint: RouteBuilder objects can't be eliminated

The builder chain `.get().meta().input().handler()` creates RouteBuilder objects for TypeScript type inference — each call returns a new generic instantiation. The optimization targets everything inside `.handler()`.

### What `.handler()` does today (per route)

1. `new Set(errorKeys)` — error Set construction
2. `{...meta}` — meta object spread
3. `[...parentMw, ...routeMw]` — middleware array concat
4. OV closure creation from output schemas
5. `insertRoute()` — trie traversal (1-3 segment lookups + possible `createNode()`)

### What `.handler()` does with `.routeTree()` (per route)

1. Lookup `"GET /orgs"` in handler map — O(1)
2. If found: patch `fn`, `mw`, `iv`, `os`, `ov`, `ef` onto existing handler — 6 assignments
3. `ek` and `mt` already pre-built from codegen — skip
4. If not found: fall through to normal `insertRoute()`

### Pre-built vs Patched

| Field | Pre-built (codegen) | Patched (boot) | Notes                                |
| ----- | ------------------- | -------------- | ------------------------------------ |
| `fn`  |                     | x              | user's handler closure               |
| `mw`  |                     | x              | middleware function refs             |
| `ek`  | x                   |                | string Set — trivially serializable  |
| `ef`  |                     | x              | filtered from `_errorFactory` + `ek` |
| `iv`  |                     | x              | zod schema objects                   |
| `os`  |                     | x              | zod schema objects                   |
| `mt`  | x                   |                | plain JSON object                    |
| `ov`  |                     | x              | closure from output schemas          |

### `.routeTree()` API

```typescript
import { routeTree } from "./honey.routes.gen"

const app = honey<Env>()
	.routeTree(routeTree)
	.use(withAuth)
	.get("/orgs")
	.input({ search: z.object({ limit: z.number() }) })
	.handler(listOrgs) /* patches existing handler, skips insertRoute */
```

`.routeTree(tree)` does one thing: sets the root node and stores the handler map. No flags, no modes. The behavior change is in `handler()` — if a handler already exists at `"METHOD /path"` in the map, patch it instead of `insertRoute()`.

### `honey()` takes zero args

Remove `honey({ tree })` constructor option. All tree configuration goes through `.routeTree()`:

```typescript
/* before */
const gateway = honey<{}>({ tree: merged })

/* after */
const gateway = honey<{}>().routeTree(merged)
```

### Enhanced codegen output

```typescript
/* honey.routes.gen.ts */
import type { TreeNode, RouteHandler, RouteTree } from "@ecomet/honey/tree"

const E = Object.create(null) as Record<string, TreeNode>

/* unique handler per route — no dedup, patching shared handlers would corrupt */
const H0: RouteHandler = { fn: null as unknown as RouteHandler["fn"], mw: [], ek: new Set(["email_taken", "not_found"]), ef: null, iv: null, os: null, mt: {"auth":"required","rateLimit":"strict"}, ov: null }
const H1: RouteHandler = { fn: null as unknown as RouteHandler["fn"], mw: [], ek: new Set(), ef: null, iv: null, os: null, mt: {"auth":"required"}, ov: null }
const H2: RouteHandler = { fn: null as unknown as RouteHandler["fn"], mw: [], ek: new Set(), ef: null, iv: null, os: null, mt: {"auth":"required"}, ov: null }

export const tree: TreeNode = { ... }

export const meta: Record<string, Record<string, unknown>> = {
  "GET /orgs": {"auth":"required","rateLimit":"strict"},
  "POST /orgs": {"auth":"required"},
  "GET /orgs/:orgId": {"auth":"required"}
}

export const handlers: Record<string, RouteHandler> = {
  "GET /orgs": H0,
  "POST /orgs": H1,
  "GET /orgs/:orgId": H2,
}

export const routeTree: RouteTree = { root: tree, meta, handlers }
```

### Pre-filtered error factory (`ef`)

After the error refactor, `ctx.errors` is built per-request by looping `handler.ek` and filtering `_errorFactory`. With `.routeTree()`, this moves to boot time:

```typescript
/* In handler() when patching */
if (this._s.parent._errorFactory && existing.ek.size > 0) {
	const ef: Record<string, unknown> = Object.create(null)
	for (const key of existing.ek) {
		if (key in this._s.parent._errorFactory) {
			ef[key] = this._s.parent._errorFactory[key]
		}
	}
	existing.ef = Object.freeze(ef)
}

/* In fetch() — one assignment, no loop */
ctx.errors = handler.ef ?? Object.create(null)
```

### Edge cases

1. **Route in builder but not in handler map** → normal `insertRoute()` fallback
2. **`.routeTree()` + `.use()`** → handler map propagates to new Honey instance (same as `_defaults`, `_telemetry`)
3. **`.route()` sub-routers** → sub-router routes insert normally into existing trie nodes
4. **`mergeTree`** → `honey().routeTree(mergeTree(...))` — handlers already live, no patching needed
5. **WS routes** → not in handler map, normal `insertWsRoute()`
6. **Dev mode** → don't use `.routeTree()`, keep dynamic builder for HMR

## Implementation Steps

**Prerequisite**: Error refactor complete (ctx.errors, remove defaults, \_createError)

- [ ] Add `handlers` field to `RouteTree` type, `ef` field to `RouteHandler` — `src/tree.ts`
- [ ] Remove `honey({ tree })` constructor option — `src/index.ts`
- [ ] Add `_handlerMap` to Honey class, propagate through `.use()` etc. — `src/index.ts`
- [ ] Add `.routeTree(tree)` method — sets root + handler map — `src/index.ts`
- [ ] Add `handlerMap` to `RouteBuilderState`, pass from `_registerRoute()` — `src/index.ts`
- [ ] In `handler()`: if handler map has `"METHOD /path"`, patch instead of insertRoute — `src/index.ts`
- [ ] Pre-compute `ef` at patch time from `_errorFactory` + `handler.ek` — `src/index.ts`
- [ ] In `fetch()`: use `handler.ef` for `ctx.errors` — `src/index.ts`
- [ ] Enhanced codegen: unique handlers per route, pre-built `ek`+`mt`, emit `handlers` map + `routeTree` export — `src/codegen.ts`
- [ ] Update mergeTree integration test to use `.routeTree()` — `tests/`
- [ ] Update demo app — `demo/src/app.ts`
- [ ] Tests: patch mode, fallback insert, pre-built ek/mt, pre-filtered ef, codegen output — `tests/`

## Decisions

- `.routeTree()` replaces `honey({ tree })` — one API, zero constructor args
- No flags or modes — `handler()` checks handler map existence, patches if found, inserts if not
- Patch approach over code transform — inline closures can't be serialized, patching is zero-DX-change
- No handler dedup in enhanced codegen — each route gets unique handler constant
- `ef` (pre-filtered error factory) stored on handler — moves per-request loop to per-boot
- Handler map key format: `"METHOD /path"` (same as meta export)
- Handler map propagates through `.use()` like other Honey config fields

## Discovered

- RouteBuilder objects can't be eliminated — needed for TypeScript type narrowing via generic instantiation
- Current handler dedup in `generateRouteTree` uses `generateHandlerKey` (mw names + error keys) — incompatible with patching since different routes need different fn/mw/iv
- Out of 8 handler fields, only 2 (ek, mt) can be pre-built at codegen time — the rest require runtime values
- The `ef` optimization is an additional win — eliminates per-request loop over error keys

## Rejected

- Full handler serialization (importing handler fns by name) — requires named exports, DX regression
- Code transform to extract inline closures — complex, error-prone AST manipulation
- Eliminating RouteBuilder objects — needed for TypeScript generics
- Pre-compiled zod validators — runtime objects, needs zod-to-validator transform (phase 2)
- Middleware fn serialization — closures/factory results can't be serialized
- Separate `honey({ tree })` and `.routeTree()` — unnecessary split, one API handles both
