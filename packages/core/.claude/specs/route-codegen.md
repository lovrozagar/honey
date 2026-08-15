# Honey Route Context Codegen

## Goal

Generate `.gen.d.ts` files containing fully resolved route context types so services can import them directly — zero circular deps, full autocomplete, full route context (middleware ctx + input + params + output).

## Problem

TypeScript cannot resolve route context types in services without circular deps:

```
routes.ts → imports Service → service.ts → needs InferRouteCtx<typeof app> → needs typeof app → circular
```

Pure TS utilities (Part A) solve middleware-level context (`InferCtx<typeof base>`), but cannot provide **per-route** context (input, params, output-constrained json) to services without the circular dep.

## Solution

Codegen walks the live app instance, extracts all route metadata + schema types, and writes a `.gen.d.ts` file that services import from. The generated file has no imports from user route files — it's a standalone type artifact.

```ts
/* service.ts — imports from generated file, no circular dep */
import type { Routes } from "./honey.gen"

class OrgService {
  static list(ctx: Routes["/orgs"]["get"]["ctx"]) {
    ctx.input.search.q   /* route input */
    ctx.db.query(...)     /* middleware context */
    ctx.params.orgId      /* typed params */
  }
}
```

## Scope

### In

- CLI: `bunx honey generate --entry src/app.ts --out src/honey.gen.d.ts`
- Vite plugin extension: auto-regenerate on route file changes
- Generated `.gen.d.ts` contains:
  - Base context type (accumulated middleware)
  - Per-route context types (ctx + input + params)
  - Per-route input/output types
  - Route map type (path → method → { ctx, input, output })
  - Convenience type aliases per route
- Multiple app support (multiple --entry flags or config)
- Watch mode for CLI (`--watch`)

### Out

- RPC client generation (separate future spec)
- Runtime code generation (only `.d.ts` types)
- Changes to existing runtime behavior
- Schema serialization / JSON Schema output (already in codegen.ts)

## Design

### Generated file shape

```ts
/* src/honey.gen.d.ts — auto-generated, do not edit */

import type { HoneyContext } from "honey"

/* ---- env ---- */
export type Env = { DB: D1Database; SECRET: string }

/* ---- base context (middleware chain) ---- */
export type BaseCtx = HoneyContext<Env> & {
	db: { query: (sql: string) => unknown[] }
	user: { id: string; locale: string; name: string }
}

/* ---- route map ---- */
export type Routes = {
	"/health": {
		get: {
			ctx: BaseCtx
			input: {}
			output: {}
		}
	}
	"/orgs": {
		get: {
			ctx: BaseCtx & {
				input: { search: { limit: string; offset: string } }
			}
			input: { search: { limit: string; offset: string } }
			output: { "application/json": { ok: { items: unknown[]; total: number } } }
		}
	}
	"/orgs/:orgId": {
		get: {
			ctx: BaseCtx & {
				readonly params: { orgId: string }
			}
			input: {}
			output: {}
		}
		delete: {
			ctx: BaseCtx & {
				readonly params: { orgId: string }
			}
			input: {}
			output: {}
		}
	}
}

/* ---- convenience aliases ---- */
export type HealthGetCtx = Routes["/health"]["get"]["ctx"]
export type OrgsGetCtx = Routes["/orgs"]["get"]["ctx"]
export type OrgsOrgIdGetCtx = Routes["/orgs/:orgId"]["get"]["ctx"]
export type OrgsOrgIdDeleteCtx = Routes["/orgs/:orgId"]["delete"]["ctx"]
```

### Package structure

Lives in core as entry points — same pattern as `honey/cors`, `honey/codegen`:

```
src/cli.ts           → honey/cli (bin entry)
src/codegen.ts       → honey/codegen (extend with type emitter)
src/plugin.ts        → honey/plugin (extend vite plugin)
src/type-emitter.ts  → internal (schema → type string walker)
```

### CLI interface

```
bunx honey generate [options]

Options:
  --entry <path>     Entry file exporting Honey app (required)
  --export <name>    Export name to use (default: "default" or "app")
  --out <path>       Output .gen.d.ts path (default: alongside entry)
  --watch            Watch entry + imported files for changes
  --base-ctx-name    Name for base context type (default: "BaseCtx")
```

Multiple apps via config file (`honey.config.ts`):

```ts
import { defineConfig } from "honey/config"

export default defineConfig({
	apps: [
		{ entry: "src/api.ts", out: "src/api.gen.d.ts" },
		{ entry: "src/admin.ts", export: "adminApp", out: "src/admin.gen.d.ts" },
	],
})
```

Or multiple CLI calls:

```bash
bunx honey generate --entry src/api.ts --out src/api.gen.d.ts
bunx honey generate --entry src/admin.ts --export adminApp --out src/admin.gen.d.ts
```

### Vite plugin extension

Extend existing `honeyVitePlugin` with `types` option:

```ts
honeyVitePlugin({
	app: apiApp,
	types: "src/api.gen.d.ts" /* enables type codegen */,
	routeFiles: ["src/routes/**"] /* triggers regen on change */,
})
```

On `handleHotUpdate` (already implemented for route tree), also regenerate types when route files change.

### Type extraction strategy

The codegen runs the user's app entry at build time (same as current `generateFromApp`). It walks the route tree and for each route:

1. **Input types** — extracted from `handler.iv` (InputSchemasDef). Each schema entry has `~standard.types.output` which gives the inferred type. Use `ts-morph` or TypeScript compiler API to resolve the actual type string from the schema.

2. **Output types** — extracted from `handler.os` (OutputSchemaDef). Same schema introspection.

3. **Params** — extracted from path string using `extractParams()` (already exists in codegen.ts).

4. **Middleware context** — this is the hard part. The middleware additions (`DbCtx`, `AuthCtx`) are type-level only — not available at runtime.

### The middleware context problem

Middleware context additions exist only in the TypeScript type system:

```ts
const withDb: MiddlewareFn<{}, DbCtx> = ...
// DbCtx = { db: { query: ... } } — only in types
```

At runtime, `handler.mw` has the middleware functions but not their type signatures. Two approaches:

**Approach A: Hybrid — codegen for schemas, InferCtx for middleware**

```ts
/* generated */
import type { InferCtx } from "honey"
import type { base } from "./context"

export type BaseCtx = InferCtx<typeof base>

export type Routes = {
  "/orgs": {
    get: {
      ctx: BaseCtx & { input: { search: { limit: string } }; readonly params: Record<string, string> }
      input: { search: { limit: string } }
      output: { ... }
    }
  }
}
```

The generated file imports `InferCtx<typeof base>` — base context comes from TS inference (no circular dep since base.ts has no routes), route-specific additions (input, params, output) come from codegen.

**Approach B: Full extraction via TS compiler API**
Use `ts-morph` to load the user's source, resolve `InferCtx<typeof base>` to its structural type, and emit the fully resolved type. No imports in generated file.

**Decision: Approach A (hybrid)**

- Simpler, no ts-morph dependency
- Base context stays in sync automatically (it's a live import)
- Only route-specific types are generated
- The generated file imports from `./context` (user's base file) — this is safe because context.ts has no routes

### Dependency graph with codegen

```
context.ts     → honey, middleware (no routes, no services)
honey.gen.d.ts → context.ts (type import for BaseCtx)
service.ts     → honey.gen.d.ts (type import for route contexts)
routes.ts      → context.ts (value), service.ts (value)
```

Zero circular deps. Services get full route context. Base context stays in sync.

### Schema type resolution

For input/output schemas, we need the inferred TypeScript type as a string. Options:

**Option 1: Runtime `~standard.types`**
Standard Schema exposes `~standard.types.output` — but this is a TypeScript type, not available at runtime.

**Option 2: Zod `.shape` introspection**
Walk the Zod schema structure to reconstruct the type string:

- `ZodString` → `string`
- `ZodNumber` → `number`
- `ZodObject` → `{ key: type, ... }`
- `ZodArray` → `type[]`
- `ZodOptional<T>` → `T | undefined`

This is vendor-specific but covers the 90% case (Zod is dominant).

**Option 3: Standard Schema + vendor fallback**
Check `~standard.vendor`, then use vendor-specific introspection. Support Zod first, add Valibot/ArkType later.

**Decision: Option 3**
Start with Zod introspection (most common), extensible to other vendors. The schema walker emits TypeScript type strings.

### Implementation: Schema type emitter

```ts
function emitSchemaType(schema: StandardSchemaLike): string {
	const vendor = schema["~standard"].vendor
	if (vendor === "zod") return emitZodType(schema)
	/* future: valibot, arktype */
	return "unknown"
}

function emitZodType(schema: unknown): string {
	const s = schema as Record<string, unknown>
	const def = s._def as Record<string, unknown>
	const typeName = def.typeName as string

	switch (typeName) {
		case "ZodString":
			return "string"
		case "ZodNumber":
			return "number"
		case "ZodBoolean":
			return "boolean"
		case "ZodArray":
			return `${emitZodType(def.type)}[]`
		case "ZodOptional":
			return `${emitZodType(def.innerType)} | undefined`
		case "ZodNullable":
			return `${emitZodType(def.innerType)} | null`
		case "ZodObject": {
			const shape = (s as { shape: Record<string, unknown> }).shape
			const entries = Object.entries(shape)
				.map(([k, v]) => `${k}: ${emitZodType(v)}`)
				.join("; ")
			return `{ ${entries} }`
		}
		case "ZodEnum":
			return (def.values as string[]).map((v) => `"${v}"`).join(" | ")
		case "ZodLiteral":
			return JSON.stringify(def.value)
		case "ZodUnion":
			return (def.options as unknown[]).map(emitZodType).join(" | ")
		case "ZodRecord":
			return `Record<string, ${emitZodType(def.valueType)}>`
		case "ZodTuple":
			return `[${(def.items as unknown[]).map(emitZodType).join(", ")}]`
		default:
			return "unknown"
	}
}
```

### Alias naming convention

Route `/orgs/:orgId` + method `GET` → `OrgsOrgIdGetCtx`

```ts
function aliasName(path: string, method: string): string {
	return (
		path
			.split("/")
			.filter(Boolean)
			.map((seg) => {
				if (seg.startsWith(":")) return capitalize(seg.slice(1).replace("?", ""))
				if (seg.startsWith("*")) return capitalize(seg.slice(1) || "Wild")
				return capitalize(seg)
			})
			.join("") +
		capitalize(method) +
		"Ctx"
	)
}
```

## Execution Order

### Phase 1: Schema type emitter

1. Add `emitSchemaType()` + `emitZodType()` to `codegen.ts` (or new `type-emitter.ts`)
2. Unit test: Zod schema → TypeScript type string for all supported types
3. Test with nested objects, arrays, optionals, enums

### Phase 2: Type file generator

1. Add `generateTypes()` to `codegen.ts` — takes app + options, returns `.d.ts` string
2. Walk route tree, extract input/output schemas, emit types
3. Generate `Routes` map type + convenience aliases
4. Generate `BaseCtx` import from user's context file
5. Unit test: full app → generated type string

### Phase 3: CLI

1. Create `src/cli.ts` with arg parsing
2. Load user's entry file, resolve app export
3. Call `generateTypes()`, write to output path
4. Add `--watch` mode using fs.watch on entry + dependencies
5. Add `bin` entry to package.json
6. Test: CLI generates correct file from e2e-app

### Phase 4: Vite integration

1. Extend `honeyVitePlugin` options with `types` field
2. On `configResolved` + `handleHotUpdate`, regenerate types file
3. Write `.gen.d.ts` to disk (not virtual — TS needs real files)
4. Test: Vite plugin regenerates types on route file change

### Phase 5: Config file support

1. Add `defineConfig()` export from `honey/config`
2. CLI reads `honey.config.ts` if no --entry flag
3. Support multiple apps in config
4. Test: multi-app config generates separate type files

### Phase 6: e2e-app demo

1. Restructure e2e-app with codegen:
   - `context.ts` — base honey + middleware
   - `honey.gen.d.ts` — generated types
   - `service.ts` — imports from generated
   - `routes.ts` — registers routes, uses services
2. Add `generate` script to e2e-app package.json
3. Verify full type safety end-to-end

## Test Plan

- Schema emitter: ZodString → "string", ZodObject → "{ ... }", nested, arrays, optionals, enums, unions, records, tuples
- Schema emitter: unknown vendor → "unknown"
- Type generator: app with no routes → empty Routes map
- Type generator: app with middleware → BaseCtx import
- Type generator: app with input schemas → input types in route ctx
- Type generator: app with params → typed params in route ctx
- Type generator: app with output schemas → output types
- Type generator: duplicate path+method → last wins
- Type generator: alias naming for paths with params, wildcards
- CLI: generates valid .d.ts from entry file
- CLI: --watch regenerates on file change
- CLI: errors on missing entry/export
- Vite: regenerates on handleHotUpdate
- Multi-app: separate type files generated
- e2e: service uses generated route context, compiles clean

## Decisions

- Hybrid approach: `InferCtx<typeof base>` for middleware context (live TS import), codegen for route-specific types (input, params, output). This is optimal because middleware type additions are erased at runtime — no way to extract `{ db: { query: ... } }` from a function without changing the middleware API. The import from `context.ts` is architecturally correct: it's the one file guaranteed to have no circular deps, and base ctx stays in sync automatically without regen.
- Zod introspection first, extensible vendor support via `~standard.vendor`
- CLI as primary interface, Vite plugin as dev convenience
- `.gen.d.ts` on disk (not virtual modules) — TypeScript needs real files
- No API changes to middleware system

## Discovered

## Rejected

- Full ts-morph extraction — heavy dependency (~10MB), slow, fragile across TS versions, produces STALE types that go out of sync when middleware changes. Strictly worse than live import.
- Virtual modules for types — TypeScript can't resolve them for imports in user code
- Runtime-only approach — middleware context types are compile-time only, erased by TypeScript
- Codegen for base context — would go stale on middleware changes, live import is always correct
- Schema-declared middleware (`provides: z.object(...)`) — would enable full codegen but requires API change, adds boilerplate, breaks existing middleware
