# Honey Type Utilities — InferContext & Route Lookup Types

## Goal

Add utility types to Honey that let services extract accumulated context types from any Honey instance chain, eliminating circular dependencies between app/routes/services. Follows the proven pattern used by tRPC, Hono, and Elysia — pure TypeScript inference, no codegen.

## Problem

```
app.ts → imports routes → imports services → needs typeof app (CIRCULAR)
```

Solution: services import types from the **base chain** (middleware-only, no routes), not the full app.

## Scope

### In

- `InferContext<T>` — extract accumulated `TCtx` from a `Honey<TEnv, TCtx, TRoutes>` instance type
- `InferEnv<T>` — extract `TEnv` from a Honey instance type
- `InferRouteCtx<T, Path, Method>` — extract the full handler context (ctx + input + params + output-constrained json) for a specific route
- `InferRouteInput<T, Path, Method>` — extract input type for a specific route+method
- `InferRouteOutput<T, Path, Method>` — extract output type for a specific route+method
- Unit tests for all utility types (compile-time type assertions)
- Document the base/routes split pattern in a test that demonstrates the architecture

### Out

- CLI codegen (separate spec, done after this)
- Runtime changes to Honey class
- Changes to RouteBuilder or middleware system
- `.gen.ts` file generation
- Changes to existing codegen (plugin.ts, codegen.ts)

## Design

### 1. Utility Types (in `types.ts`)

```typescript
/** Extract TCtx from a Honey instance — the accumulated middleware context */
export type InferContext<T> = T extends Honey<infer _E, infer TCtx, infer _R> ? TCtx : never

/** Extract TEnv from a Honey instance */
export type InferEnv<T> = T extends Honey<infer TEnv, infer _C, infer _R> ? TEnv : never

/** Lookup a specific route's {input, output} from the accumulated route map */
type RouteLookup<T, TPath extends string, TMethod extends string> =
	InferRoutes<T> extends infer R
		? TPath extends keyof R
			? Lowercase<TMethod> extends keyof R[TPath]
				? R[TPath][Lowercase<TMethod>]
				: never
			: never
		: never

/** Extract input type for a route */
export type InferRouteInput<T, TPath extends string, TMethod extends string = "GET"> =
	RouteLookup<T, TPath, TMethod> extends { input: infer I } ? I : never

/** Extract output type for a route */
export type InferRouteOutput<T, TPath extends string, TMethod extends string = "GET"> =
	RouteLookup<T, TPath, TMethod> extends { output: infer O } ? O : never
```

### 2. RouteRecord Enhancement

Current `RouteRecord` stores `{ input, output }`. To support `InferRouteCtx`, also store `ctx`:

```typescript
export type RouteRecord<TMethod extends string, TPath extends string, TInput, TOutput, TCtx = unknown> = {
	[P in TPath]: {
		[M in Lowercase<TMethod>]: {
			ctx: TCtx
			input: TInput
			output: TOutput
		}
	}
}
```

Then `InferRouteCtx` resolves the full handler context:

```typescript
/** Extract the full handler context type for a specific route — includes middleware additions, input, params */
export type InferRouteCtx<T, TPath extends string, TMethod extends string = "GET"> =
	RouteLookup<T, TPath, TMethod> extends { ctx: infer C } ? C : never
```

### 3. Handler return type update

In `RouteBuilder.handler()`, the return type changes from:

```typescript
Honey<TEnv, TBaseCtx, TRoutes & RouteRecord<TMethod, TPath, TInput, TOutput>>
```

to:

```typescript
Honey<TEnv, TBaseCtx, TRoutes & RouteRecord<TMethod, TPath, TInput, TOutput, TCtx>>
```

Where `TCtx` is the RouteBuilder's accumulated context at handler registration time.

### 4. Usage Pattern (no circular deps)

```typescript
/* base.ts */
import { honey, type InferContext } from "@lovrozagar/honey"
export const base = honey<Env>().use(authMiddleware).use(dbMiddleware)
export type AppCtx = InferContext<typeof base>

/* services/org.ts */
import type { AppCtx } from "../base"
export class OrgService {
	static list(ctx: AppCtx) {
		/* ctx.userId, ctx.db fully typed */
	}
}

/* routes/orgs.ts */
import { base } from "../base"
import { OrgService } from "../services/org"
export const app = base.get("/orgs").handler((ctx) => ctx.json("ok", await OrgService.list(ctx)))
```

For route-specific context (with input/params):

```typescript
/* After app is built, in a DIFFERENT dependency direction: */
type App = typeof app
type OrgListCtx = InferRouteCtx<App, "/orgs", "GET">
/* = HoneyContext<Env> & { userId: string } & { db: D1 } & { input: { search: ... } } */
```

## Test Plan

### Compile-time type tests

- `InferContext` extracts correct type from bare Honey instance
- `InferContext` extracts accumulated type after `.use()` chain
- `InferEnv` extracts env type
- `InferRoutes` returns full route map
- `InferRouteInput` returns input for specific path+method
- `InferRouteOutput` returns output for specific path+method
- `InferRouteCtx` returns full accumulated context for a route
- Types resolve to `never` for non-existent paths/methods
- Works with `const` path literals
- `RouteRecord` backwards compat — existing `InferRoutes` usage still works

### Architecture demo test

- Build a mini app with base/routes/services split
- Prove the types flow without circular deps
- Show `InferContext<typeof base>` works for service signatures

## Execution Order

1. Add `InferContext`, `InferEnv` to `types.ts` + export from `index.ts`
2. Add `ctx` field to `RouteRecord` type
3. Update `RouteBuilder.handler()` return type to pass `TCtx`
4. Add `RouteLookup`, `InferRouteInput`, `InferRouteOutput`, `InferRouteCtx` to `types.ts` + export
5. Write type-level unit tests
6. Run existing tests for regression (`bunx vitest run`)
7. Biome + tsc checks

## Decisions

- Pure TS utility types, no codegen — follows tRPC/Hono/Elysia precedent
- Default `TMethod` to `"GET"` in inference utilities for ergonomics
- Store `TCtx` in RouteRecord to enable per-route context extraction

## Discovered

## Rejected

- ts-morph / TS compiler API for type extraction — slow, fragile, every framework abandoned it
- `.gen.ts` codegen for types — stale files, unnecessary given `typeof` pattern
- Runtime metadata approach — can't carry compile-time middleware context types
