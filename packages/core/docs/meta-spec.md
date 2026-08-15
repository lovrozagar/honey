# `.metaSpec()` — declarative control over what reaches the OpenAPI document

Status: implemented in `@lovrozagar/honey` (tree of record: `packages/core`).

## 1. The problem

Before this feature, `generateOpenApi` mapped route meta onto the operation object with a
hardcoded allowlist of eight fields:

```ts
summary, description, tags, deprecated, operationId, security, invalidate → x-invalidate, mcp → x-mcp
```

Everything else on `.meta()` was **silently discarded**. That has three consequences:

1. **Facts the framework already knows never leave the process.** An app that classifies every
   route by rate-limit category, permission set, or tenancy carries those facts on route meta and
   the document never sees them. Downstream consumers (SDK codegen, gateways, contract testers such
   as [`oat`](https://github.com/lovrozagar/oat)) then re-derive them by heuristic, or don't run the
   check at all.
2. **Hiding is accidental, not deliberate.** Fields that _must not_ be published — a captcha
   provider, a test-bypass surface, internal worker routing — were protected only because the
   allowlist happened not to know about them. Nothing recorded the intent.
3. **Rot is silent.** Adding a field to the app's meta type produced no signal anywhere. The
   default outcome of growth was "dropped".

`.metaSpec()` replaces the allowlist with a **declarative, total, per-document policy**.

## 2. Public API

```ts
honey<Env>()
	.meta<HoneyMeta<AppRouteMeta>>()
	.metaSpec({
		strict: "error",

		meta: {
			permissions: "x-permissions",
			rateLimit: { key: "x-rate-limit", map: (v) => ({ category: v, rps: RPS[v] }) },
			summary: { key: "summary" },
			worker: false,
			captcha: false,
		},

		schema: {
			entity: {
				from: ["output"],
				search: "deep",
				expand: (e) => ({
					"x-entity": e.table,
					"x-generated": e.generated,
					"x-immutable": e.immutable,
					"x-soft-delete": e.softDelete ? { field: e.softDelete } : undefined,
				}),
			},
		},

		profiles: {
			// default-deny: a tag added tomorrow is absent here until someone opts it in
			public: { include: ["x-entity", "x-query"] },
		},
	})
```

honey does not own the shape of `e` above. The descriptor is a contract between whatever stamps the
schema (an ORM, a DTO layer) and the app's policy block; honey only carries it. Agree those field
names once, on the publisher's side, before either end writes code against them.

### 2.1 Entry forms

A policy entry describes one **source key** (a meta key, or a key read off a schema) and what it
contributes to the operation object.

| Form                                     | Meaning                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `false`                                  | **Hidden.** Never emitted, in any profile. Explicit and greppable.                                           |
| `"x-foo"` / `"summary"`                  | **Verbatim.** The source value is written to that operation key unchanged.                                   |
| `{ key, map?, schema?, on?, profiles? }` | **Single target.** `map` transforms the value; returning `undefined` omits it for that route.                |
| `{ expand, schema?, on?, profiles? }`    | **Fan-out.** Returns a record of operation keys → values; `undefined` values and an `undefined` return omit. |

Common options:

- `on?: "http" | "ws" | "both"` — which operation kinds the entry applies to. Default `"both"`.
- `profiles?: readonly string[]` — restrict the entry to named documents. Default: every profile.
- `schema?: StandardSchemaLike` — validates the produced value (see §6).

`map` / `expand` receive `(value, ctx)` where `ctx` is `{ method, path, meta, profile, source }`.

### 2.2 Target keys

An entry may target:

- any **extension** key matching `x-*`, or
- one of the **standard operation fields** honey allows a policy to set:
  `summary`, `description`, `tags`, `deprecated`, `operationId`, `security`, `externalDocs`,
  `servers`.

`responses`, `parameters`, `requestBody` and `callbacks` are **reserved** — they are derived from
schemas and error keys, and a policy that wrote them would produce a document that contradicts the
route. Targeting them is a build error. Any other non-`x-` key is a build error too (it would be
dropped by spec-conformant readers, which is the failure mode this feature exists to remove).

### 2.3 Schema-derived facts

The `schema` section is keyed by **a key read off the route's schema metadata**, not by a meta key.
Sources:

```
"output" | "input.json" | "input.search" | "input.form" | "input.headers" | "input.cookies"
```

`from` defaults to all of them, in that order; the first source that carries the key wins.
`"output"` reads the JSON output schema of the lowest declared 2xx status.

`search` decides how deeply to look:

| `search`           | Behavior                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"root"` (default) | the schema root, seeing through one level of `items` so a bare `array<Entity>` list output still finds the descriptor stamped on the item                                                           |
| `"deep"`           | walks `properties`, `items` and composition members breadth-first (max depth 6) and takes the **shallowest** match — for envelope shapes like `{ articles: [Article], count, hasMore, nextCursor }` |

A deep search that finds two _different_ values at the same depth is a build error
(`AMBIGUOUS_SCHEMA_KEY`), not a guess. The same descriptor reached by several paths is fine.

Reading is vendor-neutral: honey converts the schema to JSON Schema (it already does, for the
request/response bodies) and reads app keys off the **root** of that JSON Schema. For Zod that is
exactly what `.meta({ … })` produces, so an ORM that stamps a descriptor onto the schema it already
uses to parse the request gets the extension for free — and the tag cannot drift from runtime
behavior, because both read the same object.

One schema key routinely fans out to several extensions, which is why `expand` exists.

> **Deliberate limit.** Deriving operation metadata from _schemas and table definitions_ is safe:
> they are a separate, hand-reviewed layer, and a handler can still fail to honor them — which is
> precisely the finding a contract tester should report. Deriving it from _observed handler
> behavior_ is not safe: it makes the document a mirror of the implementation and the tester
> self-confirming. honey has no record-from-runtime mode, and if one is ever added its output must
> land in a committed, reviewable artifact rather than being regenerated at test time.

### 2.4 Profiles (multi-document)

```ts
profiles: {
  public:  { include: ["x-entity", "x-query"] },       // default-deny — preferred
  partner: { include: ["x-entity", "x-query", "x-cost"] },
  staging: { exclude: ["x-rate-limit"] },              // denylist — internal documents only
}
```

- Profile filters operate on **emitted keys**, not source keys.
- `include` is an allowlist of `x-*` keys (standard fields are always kept unless excluded);
  `exclude` is a denylist; with both, `include` applies first. Both also filter `meta.extensions`,
  so the escape hatch cannot route around a profile.
- The implicit profile `"default"` filters nothing.

**Use `include` for a public document.** `exclude` is a denylist: a tag introduced next month is
published unless someone remembers to add it, and the failure mode is a leak. `include` is
default-deny, which is the posture a security boundary wants — the same posture `false` already
takes on individual keys. Reach for `exclude` only when the document is internal and the list of
things to withhold is genuinely shorter than the list to publish.

- A document selects a profile:

```ts
codegen: {
  openApi: [
    { path: "src/_gen/openapi.internal.json", title: "…", version: "1.0.0" },
    { path: "src/_gen/openapi.public.json",   title: "…", version: "1.0.0", profile: "public" },
  ],
}
```

`generateOpenApi(app, { …, profile: "public" })` is the programmatic form.

**Why document-level filtering rather than per-entry visibility as the primary model:** the
question a reviewer asks is "what is in the public document?" — that must be answerable by reading
one block, not by grepping forty entries for a visibility flag. Per-entry `profiles` remains
available for the inverse case ("this entry exists only for the internal document"), and `false`
covers "never, anywhere".

### 2.5 Escape hatch

`OpenApiMeta` now carries:

```ts
extensions?: Record<`x-${string}`, unknown>
```

emitted verbatim, at the highest precedence, and still subject to profile filtering. It exists so a
consumer that gains a tag before honey's policy is updated is not blocked. It is deliberately
secondary: raw passthrough spreads stringly-typed keys across call sites, has no public/private
separation, and fails on nothing.

## 2.6 Middleware-contributed meta

A fact enforced by middleware should not be retyped on every route it protects. Middleware can
contribute meta to every route that mounts it:

```ts
export const shard = createMiddleware(fn, { meta: { tenant: "project_id" } })
// or: defineMiddleware({ fn, errors: […], meta: { tenant: "project_id" } })

app.use(shard)                    // every route on the chain
app.use("/orgs", shard)           // every route under a prefix
app.get("/x").use(shard).handler(…)  // one route
```

One line, every route the middleware covers, and the tag cannot disagree with the code that
enforces it — a hand-written `tenant` on 104 routes can, and a wrong one is worse than a missing
one, because it makes a consumer confident about the wrong parameter.

Rules:

- **Explicit always wins.** Chain `.meta()` and route `.meta()` both outrank a contributed value.
  Among middleware, later mount order wins.
- **Contributed meta is real meta.** It lands in the route's `mt`, so it appears on `ctx.meta`, in
  the manifest, and — critically — it is subject to the policy. A middleware cannot smuggle an
  untagged fact into the document: with `strict: "error"`, contributing `sla` with no policy entry
  fails the build exactly as writing it on a route would.
- **A scoped middleware registered after its routes still reaches them.** `.use("/prefix", mw)`
  back-fills already-registered handlers, mirroring what honey already does for scoped error keys.
  A tag missing where enforcement happens is the failure direction that matters.
- **`internal` may not be contributed.** It controls whether a route appears in generated artifacts
  at all; a middleware that removed 104 routes from the document would be invisible in both the
  route and the middleware. `createMiddleware` throws.

### Why it is resolved at registration, not per request

The precompiled route tree bakes `mt` as a JSON literal (`mw` is never serialized), and
`.routeTree()` patch mode deliberately does not overwrite `mt` — the baked value is what production
serves. Contributed meta is therefore collected once, when the route registers, so the JIT and
precompiled paths cannot disagree. A lazily-derived value would produce one answer in development
and a different, stale one in production — the exact class of divergence this feature exists to
remove. The usual contract applies: change what a middleware contributes, regenerate.

### Two things to put in a release note

- **Adding a middleware can break a build.** Contributed meta is subject to totality, so mounting a
  middleware that contributes `tenant` fails the build of any app whose policy has no `tenant`
  entry — an app that never touched its own meta type. That is the correct trade (explicit beats
  silent) but it is a surprising blast radius for what looks like a local change.
- The tap interaction below.

### One runtime interaction to know about

Meta-driven taps fire for every registered tap key found on a route's meta. A middleware
contributing `tenant` will therefore start firing an `app.tap("tenant", …)` handler on every route
it covers. That is coherent — "run this for every tenant-scoped route" is what meta-driven taps are
for — but it is a behavior change triggered from a distance, so it is worth grepping for tap keys
that collide with meta keys a middleware contributes.

## 2.7 `undefined` omits, `null` is emitted

`map` returning `undefined`, an `undefined` value inside an `expand` record, and a source key absent
from meta all mean **omit**. `null` is a value and is **emitted verbatim**.

The difference is load-bearing whenever a publisher stamps facts it cannot always know. A schema
stamped with `searchable: null` or `tenantColumn: null` means _"I don't know"_, but passing that
straight through publishes `"x-searchable": null`, which a consumer reads as _"nothing is
searchable"_ — a confident wrong answer, worse than silence. Normalize in the policy:

```ts
expand: (e) => ({
	"x-entity": e.table,
	"x-searchable": e.searchable ?? undefined, // unknown → key absent
	"x-tenant": e.tenantColumn ? { column: e.tenantColumn } : undefined,
})
```

honey does not collapse `null` to omitted for you, because "explicitly nothing" is a legitimate
statement that some consumers want (`"x-soft-delete": null` = _this entity definitively has no soft
delete_, as distinct from _unknown_). The framework carries what the policy produces; deciding which
of the two you mean is the policy's job.

This composes with precedence rather than fighting it. A publisher that stamps nothing for a fact
only the routing layer knows leaves the key absent at rank 1; a route-meta or middleware-contributed
value at rank 2 fills it wherever it exists, and where it does not, the key is simply missing —
which is the honest answer.

## 3. Precedence and merge rules

Contributions are collected per operation and resolved by **rank**, highest wins:

| Rank | Source                                                                         |
| ---- | ------------------------------------------------------------------------------ |
| 3    | `meta.extensions` passthrough                                                  |
| 2    | route meta entries — `spec.meta` **and** the built-in default policy, one tier |
| 1    | schema-derived entries (`spec.schema`)                                         |

Rules, stated once:

1. **Route meta beats schema-derived.** The built-in mappings are route meta too, so a route's
   `summary` is never overwritten by a schema-derived entry. An app entry for a built-in key
   replaces that built-in outright (same source key, so no clash).
2. **Chain meta vs route meta is unchanged**: `.meta()` on a chain is merged into each route's meta
   at registration; route meta wins. The policy layer sees the already-merged object.
3. **Two entries of the same rank writing the same operation key is a build error**
   (`DUPLICATE_TARGET`). Within-rank shadowing is always a mistake, never a feature.
4. **Key order in the emitted document is the order of first contribution**: built-ins, then app
   meta, then schema-derived, then `extensions`. Precedence is resolved independently of write
   order, so a higher-ranked contribution overwrites a value in place and never reorders the JSON.
5. **Aliasing a standard field from a second meta key requires hiding the built-in.**
   `blurb: { key: "summary" }` alongside the built-in `summary` entry is a `DUPLICATE_TARGET` error;
   write `summary: false` to say which one owns the field.
6. `undefined` from `map`, an `undefined` value inside an `expand` record, and a source key absent
   from meta all mean _omit_, silently. This is the sanctioned way to write a conditional entry.

## 4. Totality

**A key of the app's meta type with no policy entry is an error, not a silent drop.** This single
rule is what stops the rot: adding a field to the meta type forces an emit-or-hide decision.

Enforced at two levels:

- **Type level.** The `meta` section is a mapped type over the app's meta type with `-?`, minus the
  built-in `DefaultMeta` keys (which ship with default entries and may be _optionally_ overridden).
  Omitting an app key is a TypeScript error at the `.metaSpec()` call site.
- **Codegen level.** Any key observed on a route's meta with no entry is reported per `strict`.
  This catches JavaScript consumers, dynamically-assigned meta, and meta from mounted sub-apps whose
  types were erased.

`strict` values: `"error"` (default when a `metaSpec` is declared), `"warn"`, `"off"`.

**Known limit:** a _misspelled_ policy key is not rejected at the call site. `.metaSpec()` takes a
generic `TSpec extends HoneyMetaSpec<TMeta>` — required to keep `Honey` from becoming invariant in
`TMeta`, which would break assignability across the whole builder — and TypeScript does not
excess-property-check a literal inferred as a generic. The typo is still caught, from the other
side: the real key it was meant to name now has no entry, so `MISSING_ENTRY` fires for it. The
misspelled entry itself is inert.

Apps that never call `.metaSpec()` run with `strict: "off"` and the built-in policy only — see §7.

## 5. Error taxonomy

All diagnostics are collected across the whole document and thrown as one aggregated
`Error` (first 20 listed, with a count), because failing on the first of 250 operations makes
migration miserable.

| Code               | Level                                    | When                                                                   | Why this level                                                     |
| ------------------ | ---------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `MISSING_ENTRY`    | error (`strict:"error"`) / warn / silent | a meta key on some route has no policy entry                           | the rot-stopper; downgradable during migration                     |
| `RESERVED_FIELD`   | error                                    | entry targets `responses` / `parameters` / `requestBody` / `callbacks` | would contradict schema-derived content                            |
| `UNKNOWN_FIELD`    | error                                    | entry targets a non-`x-`, non-allowlisted field                        | silently ignored by readers                                        |
| `DUPLICATE_TARGET` | error                                    | two same-rank entries write one key                                    | ambiguous, order-dependent output                                  |
| `INVALID_VALUE`    | error                                    | entry `schema` rejects the produced value                              | a malformed tag is indistinguishable from a missing one downstream |
| `ASYNC_VALIDATION` | error                                    | entry `schema` validates asynchronously                                | codegen value resolution is synchronous                            |
| `MAP_THREW`        | error                                    | `map` / `expand` threw                                                 | policy bugs must not produce a half-populated document             |
| `UNKNOWN_PROFILE`  | error                                    | a document requests a profile that is not declared                     | almost always a typo that would silently emit everything           |
| omitted value      | silent                                   | `map` returned `undefined`, or the meta key is absent                  | the sanctioned conditional                                         |

Every message carries `method`, `path`, source key and target key.

## 6. Validating what is emitted

```ts
rateLimit: {
  key: "x-rate-limit",
  map: (v) => ({ category: v, rps: RPS[v] }),
  schema: z.object({ category: z.string(), rps: z.number().int().positive() }),
}
```

The schema validates the **produced** value (for `expand`, the produced record). It runs at codegen
time only, synchronously, through Standard Schema — so any of honey's supported validators works.
A failure is a build error, not a warning: shipping a tag that a consumer silently ignores is
worse than not shipping it, because it looks like coverage.

## 7. Default policy and the compatibility argument

When an app declares no `metaSpec`, codegen runs the **built-in policy**, which is the previous
eight mappings, unchanged, with the same truthiness gates and the same emit order:

| Meta key      | Target                       | Gate             | HTTP | WS  |
| ------------- | ---------------------------- | ---------------- | ---- | --- |
| `summary`     | `summary`                    | truthy           | ✓    | ✓   |
| `description` | `description`                | truthy           | ✓    | ✓   |
| `tags`        | `tags` (string → `[string]`) | truthy           | ✓    | ✓   |
| `deprecated`  | `deprecated`                 | truthy           | ✓    | —   |
| `operationId` | `operationId`                | truthy           | ✓    | ✓   |
| `security`    | `security` (normalized)      | truthy           | ✓    | —   |
| `invalidate`  | `x-invalidate`               | array, non-empty | ✓    | —   |
| `mcp`         | `x-mcp`                      | `=== true`       | ✓    | —   |
| `internal`    | _hidden_                     | —                | —    | —   |
| `extensions`  | verbatim passthrough         | —                | ✓    | ✓   |

The WS column reproduces the previous WS mapping exactly (it was a strict subset). App entries
default to `on: "both"`; the asymmetry is preserved only for the built-ins.

Because the built-ins are compiled first and written first, and because precedence is resolved
independently of write order, **a no-policy app produces a byte-identical document**. There is a
test that asserts exactly this against the pre-change generator output.

## 8. Migration path (≈250 operations, 9-field meta type)

Mechanical, and reversible at every step.

1. **Add `.metaSpec({ strict: "warn", meta: {} })`.** Generate. Every dropped key is now listed,
   once, with the routes that carry it. Nothing about the document changed.
2. **Triage the list into three buckets**: emit verbatim, emit transformed, hide. Write the entries.
   `false` for anything internal — `worker`, `captcha`, `proxyTimeout` — so the intent is recorded
   rather than implied.
3. **Add the public profile** with `exclude` for the tags that must not be published, and add the
   second `codegen.openApi` entry. Diff the two documents; the diff _is_ the review.
4. **Flip `strict` to `"error"`.** The mapped type now also fails the typecheck if a tenth meta
   field appears without a decision.
5. **Move ORM-derived facts to the `schema` section** last, once the meta-driven tags are stable.
   This is the step that removes per-route annotation: the descriptor the ORM already stamps on the
   schema fans out to `x-entity` / `x-generated` / `x-immutable` / `x-soft-delete` with no route
   edits at all.

Steps 1–2 are per-meta-key (nine edits). Step 5 is per-entity, not per-route.

## 9. Trade-offs rejected

- **Flat spec object (`.metaSpec({ permissions: "x-permissions" })`) as the only form.** Reads well
  until profiles, schema sources and `strict` need a home, and then every one of them collides with
  a possible meta key name. Sections cost one nesting level and buy an unambiguous namespace.
- **Per-entry visibility (`visible: ["internal"]`) as the primary profile model.** Rejected as the
  primary: it distributes the answer to "what does the public document contain" across the whole
  policy. Kept as a secondary `profiles` option on entries.
- **Post-hoc stripping only** (the existing `sanitize.stripXExtensions`). It works, but it is a
  denylist applied after the fact: a tag added later is published by default, and the failure mode
  is a leak. Kept for spec-level surgery; not the mechanism for public/private separation.
- **A honey-side vocabulary of blessed tags** (`x-entity`, `x-tenant`, …). Rejected outright:
  binding a framework to one consumer's tag set is how vendor lock-in starts. honey controls
  _emission_; the vocabulary is the app's.
- **Deriving policy from a config file rather than the app builder.** The policy must be typed
  against the app's meta type, which only exists in the app's own module graph.
- **Runtime enforcement.** Everything here is codegen-time. `.metaSpec()` stores one object on the
  route graph and is never consulted on a request.

## 10. Open questions

- **Chain-scoped policies.** `.metaSpec()` is app-global (stored on the shared route graph, merged
  when sub-apps are mounted, parent wins). Whether a mounted sub-app should be able to _override_ a
  parent entry rather than only fill gaps is unresolved; today it fills gaps.
- **Profile inheritance.** Profiles are flat. If real apps grow four or five documents, `extends`
  will be wanted.
- **Fan-out from a schema key into `parameters`.** `x-query` describes sortable/filterable columns
  and duplicates information that could, in principle, be emitted as real query parameters. Both are
  useful to different consumers; honey emits the extension and leaves parameters to the schema.
- **Component-level policy.** Nothing yet maps schema meta onto `components.schemas` entries, only
  onto operations.
