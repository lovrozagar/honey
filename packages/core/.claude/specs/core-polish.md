# Core Polish — HEAD, Fast Path, Search, Paths, ExecutionCtx

## Goal

Five core improvements. No middleware sugar — all in the request/response hot path.

## Approach

RED → CODE → GREEN per item. No horizontal slices.

---

## 1. HEAD Auto-Handling

### Why

Every framework auto-converts HEAD → GET. Without it, users must register duplicate routes or HEAD returns 405.

### Design

In `matchRoute()`, if `method === "HEAD"` and no HEAD handler found, retry with `"GET"`. Return the GET handler — `fetch()` already strips the body from GET responses for HEAD requests (Web Standard behavior: `new Response(null)` for HEAD).

Actually — the Web Standard `Response` doesn't auto-strip body for HEAD. Need to strip in `fetch()` after handler returns: if method is HEAD, return `new Response(null, { headers, status })`.

### Tests

- HEAD to route with only GET → 200, empty body, correct headers
- HEAD to route with explicit HEAD handler → uses HEAD handler (not GET)
- HEAD to unknown route → 404

### Files

| File           | Change                                   |
| -------------- | ---------------------------------------- |
| `src/tree.ts`  | `matchRoute` falls back to GET for HEAD  |
| `src/index.ts` | `fetch()` strips body for HEAD responses |

---

## 2. Single-Handler Fast Path

### Why

When a route has zero middleware (no global, no chain, no route-level), `executeChain` still creates closures, allocates `dispatch()`, checks `called` flag — all for zero middleware. Skip it.

### Design

In `fetch()`, after building `allMiddlewares`:

```typescript
if (allMiddlewares.length === 0) {
	response = await handler.fn(ctx)
} else {
	response = await executeChain(allMiddlewares, ctx, (c) => handler.fn(c))
}
```

No new code paths — just a conditional skip. The handler is called directly.

### Tests

- Route with no middleware → handler called, correct response
- Route with middleware → still uses executeChain (no regression)
- Verify no `dispatch()` closure created when zero middleware (structural, not behavioral)

### Files

| File           | Change                   |
| -------------- | ------------------------ |
| `src/index.ts` | Conditional in `fetch()` |

---

## 3. Multi-Value `ctx.search`

### Why

`?tags=a&tags=b` currently gives `{ tags: "a" }` — silently drops `b`. Every other framework preserves multi-value.

### Design

Change type from `Record<string, string>` to `Record<string, string | string[]>`:

- Single occurrence: `{ name: "foo" }` (string)
- Multiple occurrences: `{ tags: ["a", "b"] }` (string[])

```typescript
for (const [key, value] of url.searchParams) {
	const existing = search[key]
	if (existing === undefined) {
		search[key] = value
	} else if (Array.isArray(existing)) {
		existing.push(value)
	} else {
		search[key] = [existing, value]
	}
}
```

### Type Change

```typescript
/* before */
declare readonly search: Record<string, string>

/* after */
declare readonly search: Record<string, string | string[]>
```

### Tests

- `?name=foo` → `{ name: "foo" }` (string)
- `?tags=a&tags=b` → `{ tags: ["a", "b"] }` (string[])
- `?tags=a&tags=b&tags=c` → `{ tags: ["a", "b", "c"] }` (string[])
- `?a=1&b=2` → `{ a: "1", b: "2" }` (no arrays when single)
- Empty query → `{}`

### Files

| File             | Change                      |
| ---------------- | --------------------------- |
| `src/context.ts` | Change search getter + type |

---

## 4. `ctx.path` + `ctx.routePattern`

### Why

Handler doesn't know the matched path or route pattern. Needed for logging, metrics, OpenAPI runtime introspection.

- `ctx.path` — actual URL path after basePath strip: `"/orgs/123"`
- `ctx.routePattern` — route pattern that matched: `"/orgs/:orgId"`

### Design

Both are set by `fetch()` before calling the handler, via `Object.defineProperty` (same pattern as `meta` and `errors`):

```typescript
Object.defineProperty(ctx, "path", { value: path })
Object.defineProperty(ctx, "routePattern", { value: handler.rp })
```

`handler.rp` (route pattern) is stored on `RouteHandler` at registration time — `insertRoute` already has the path string.

### Type

Add to `HoneyContext`:

```typescript
declare readonly path: string
declare readonly routePattern: string
```

### Tests

- `ctx.path` returns matched path (basePath stripped)
- `ctx.routePattern` returns `"/orgs/:orgId"` for dynamic routes
- `ctx.routePattern` returns `"/health"` for static routes
- `ctx.path` with basePath → basePath stripped

### Files

| File             | Change                                                                       |
| ---------------- | ---------------------------------------------------------------------------- |
| `src/context.ts` | Declare `path` and `routePattern` properties                                 |
| `src/tree.ts`    | Add `rp` field to `RouteHandler`                                             |
| `src/index.ts`   | Set `path` and `routePattern` on ctx in `fetch()`, store `rp` in `handler()` |

---

## 5. `ctx.executionCtx`

### Why

`ctx.background()` wraps `waitUntil` but doesn't expose `passThroughOnException()` (CF Workers) or the raw `ExecutionContext`. Hono exposes `c.executionCtx`.

### Design

Store the execution context and expose it:

```typescript
declare readonly executionCtx: { waitUntil?: (p: Promise<unknown>) => void } | undefined
```

Set in `fetch()`:

```typescript
Object.defineProperty(ctx, "executionCtx", { value: executionCtx })
```

`ctx.background()` stays as convenience sugar — it handles the "no executionCtx" case gracefully (fire-and-forget). `ctx.executionCtx` is the raw escape hatch for CF-specific features.

### Tests

- `ctx.executionCtx` returns the execution context when provided
- `ctx.executionCtx` is undefined when not provided
- `ctx.background()` still works (no regression)

### Files

| File             | Change                                 |
| ---------------- | -------------------------------------- |
| `src/context.ts` | Declare `executionCtx` property        |
| `src/index.ts`   | Set `executionCtx` on ctx in `fetch()` |

---

## Implementation Order

1. HEAD auto-handling (tree.ts + index.ts)
2. Single-handler fast path (index.ts)
3. Multi-value search (context.ts)
4. Path + routePattern (context.ts + tree.ts + index.ts)
5. ExecutionCtx (context.ts + index.ts)

## Verification

After each item:

- `npx vitest run` — all tests pass
- `bunx tsc --noEmit | grep "^src/"` — 0 source errors
