# Honey Invalidate Spec

## Status

Draft

## Goal

Add first-class Honey metadata for declaring which route operations a mutation invalidates.

The design must:

- live in Honey base meta types
- be narrowed by generated route-aware types when available
- use canonical method-qualified route selectors
- remain simple to author and read
- serve as the source of truth for downstream SDK and query integrations

## Non-Goals

- a generic key DSL
- tuple-based metadata forms
- route-pattern inference from REST naming
- read-side key declarations
- transport-level `x-fresh` behavior in the first metadata contract

## Problem

Honey already knows the route graph and already generates route-aware types.

Mutations often make one or more read routes stale. We want a declarative way to express that relationship once, in Honey route metadata, so downstream tooling can use it for:

- query invalidation
- selective refetch behavior
- future SDK-level consistency helpers

The metadata should leverage Honey codegen rather than forcing authors to hand-maintain custom operation IDs, tuple formats, or synthetic cache keys.

## Proposed API

Add `invalidate` to Honey base meta:

```ts
type InvalidateMeta = {
	invalidate?: readonly string[] | null
}
```

This extends existing Honey base metadata rather than creating a separate metadata namespace.

## Authoring Form

`invalidate` entries must always use canonical method-qualified route selectors:

```ts
"GET /v1/organizations/:organization_id/projects"
```

Not allowed in v1:

```ts
"/v1/organizations/:organization_id/projects"
```

Reason:

- no ambiguity
- no fallback “all methods on this path” behavior
- no special-case parser rules
- codegen and runtime matching stay trivial
- editor autocomplete stays exact

## Examples

### Mutation Invalidating Collection Read

```ts
.meta({
  operationId: "project.create",
  invalidate: ["GET /v1/organizations/:organization_id/projects"],
})
```

### Mutation Invalidating Collection And Entity Reads

```ts
.meta({
  operationId: "project.update",
  invalidate: [
    "GET /v1/organizations/:organization_id/projects",
    "GET /v1/organizations/:organization_id/projects/:project_id",
  ],
})
```

### Mutation Invalidating Query-Like POST Reads

```ts
.meta({
  operationId: "project.import",
  invalidate: [
    "POST /v1/organizations/:organization_id/projects/search",
    "GET /v1/organizations/:organization_id/projects",
  ],
})
```

This is intentional. `invalidate` should not be artificially limited to `GET`. If a downstream query package treats a `POST` endpoint as queryable, it should be a valid invalidation target.

## Canonical Selector Format

Each selector must be:

```ts
;`${Uppercase<HttpMethod>} ${RoutePattern}`
```

Examples:

- `GET /v1/users`
- `GET /v1/users/:id`
- `POST /v1/search`

Requirements:

- method must be uppercase
- path must be the Honey route pattern form
- path params must remain as route params, for example `:organization_id`

## Type Model

Honey base meta should define `invalidate` with a permissive fallback type:

```ts
type DefaultInvalidate = readonly string[] | null
```

Generated apps should narrow this to an exact union of valid selectors when route-aware generated types exist.

Illustrative generated type:

```ts
type GeneratedInvalidateRoute =
	| "GET /v1/organizations/:organization_id/projects"
	| "GET /v1/organizations/:organization_id/projects/:project_id"
	| "POST /v1/organizations/:organization_id/projects/search"
```

Then the generated meta type becomes effectively:

```ts
invalidate?: readonly GeneratedInvalidateRoute[] | null
```

If generated route-aware types are unavailable, the type falls back to:

```ts
readonly string[] | null
```

## Honey Type Integration

This should extend existing base Honey metadata, not replace it.

Conceptually:

```ts
type OpenApiMeta<TInvalidate extends readonly string[] | null = readonly string[] | null> = {
	internal?: boolean
	deprecated?: boolean
	description?: string
	invalidate?: TInvalidate
	operationId?: string
	security?: Array<Record<string, string[]>> | string | string[]
	summary?: string
	tags?: string | string[]
}
```

This snippet is conceptual, not a required literal implementation. Honey currently exposes non-generic `OpenApiMeta` and `DefaultMeta`, so the real implementation should preserve that public shape and use Honey's existing generated type or augmentation pattern to narrow `invalidate`.

The behavior must be:

- base Honey always exposes `invalidate`
- generated Honey types narrow `invalidate` to the route-selector union when available

## Codegen Responsibilities

Honey codegen should:

1. collect all canonical route selectors from the route tree
2. emit the selector union for generated type narrowing
3. preserve `invalidate` metadata into generated outputs needed by downstream tooling
4. validate that authored selectors exist in the route graph during generation

Canonical selectors must be generated from the same route inventory Honey already uses for route typing and OpenAPI emission. There must be one canonical string form for each route operation.

## Runtime / Consumer Model

Honey core only defines and emits the metadata contract.

Downstream packages consume it.

Examples:

- a query package can map invalidated selectors to query families
- a future SDK helper can use invalidated selectors to decide which subsequent reads need stronger consistency handling

The important constraint is:

- authors declare invalidation in terms of actual Honey routes
- downstream tooling works from normalized route selectors

## Why Route Selectors Instead Of Operation IDs

Operation IDs are useful but are a secondary naming layer.

Route selectors are better for this feature because:

- they are directly tied to the actual route graph
- Honey already understands them structurally
- they can be generated and validated without inventing another abstraction
- they naturally support query-like `POST` routes
- they are clearer in metadata than synthetic cache keys

## Why No Tuple Shapes

Tuple forms are shorter but harder to read and easier to misuse.

This feature is authored metadata, not a performance-critical wire format.

Clarity matters more than terseness.

## Why No Path-Only Form

Path-only selectors look convenient:

```ts
"/v1/organizations/:organization_id/projects"
```

but they create ambiguity:

- does it mean all methods?
- should `GET` and `HEAD` both match?
- should `POST` query-like reads match too?

Forcing the method in every selector avoids all of that.

## Validation Rules

Validation must happen in two places:

- generated typing should narrow authored values to the exact selector union when available
- codegen should validate raw authored `invalidate` strings against the route graph during generation
- duplicates should be deduplicated in generated normalized metadata
- invalid selectors should fail type-checking when possible and fail generation otherwise

## Backward Compatibility

This feature is fully opt-in.

If `invalidate` is not used:

- existing route metadata behavior is unchanged
- existing generated SDK behavior is unchanged
- existing query integrations are unchanged

## Proposed Implementation Phases

### Phase 1: Base Meta

- add `invalidate?: readonly string[] | null` to Honey base meta

### Phase 2: Generated Narrowing

- generate canonical selector unions
- narrow `invalidate` using generated types when available

### Phase 3: Metadata Emission

- preserve `invalidate` in generated artifacts needed by downstream consumers

### Phase 4: Query Package

- consume generated `invalidate` metadata
- map selectors to query invalidation behavior
- later add convenience helpers

### Phase 5: SDK Integration

- if needed, consume normalized invalidation metadata for stronger read-after-write handling

## Recommendation

Ship the narrow version:

- `invalidate`
- method-qualified route selectors only
- generated route-aware narrowing
- downstream packages consume the emitted metadata

Do not add tuple forms, key DSLs, or path-only shortcuts in v1.
