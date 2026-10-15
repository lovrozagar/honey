# Bit 09 — the IR seam

Closes: — · establishes the core→codegen boundary (H2) · splits v0 `codegen-ir.ts` 812, `meta-spec.ts` 718, `type-emitter.ts` 760, `type-extractor.ts` 855
Oracle kept green: `unit/codegen/codegen-ir` (now gen), `conformance`, the ir-snapshot fixtures.

## Scope
The IR is the only thing `packages/gen` reads from core's output. This bit builds the IR model + builder in `gen/ir/`, the shared emit layer (`gen/emit/shared/`: the `codegen-lang` sanitizer, sanitize, hash, the one shared fuzzed string-escape layer — F2), and the type-extraction entry (`gen/extract/`, ts-morph, H12). Core's `meta-spec` (the operation-meta merge) stays in core but is split here.

## Files (from files.tsv — `gen/ir`, `gen/emit/shared`, `gen/extract`, core `meta`)
- `gen/ir/{model,build,resource-tree,slots,sdk-model,route-tree-intern,resolve-refs}.ts` (+test each) — split from v0 `codegen-ir.ts`/`codegen-sdk-model.ts`/`codegen-route-tree-intern.ts`. `schema-naming` moved to core `src/schema/naming.ts` (H2 — the IR builder never imports it); `load.ts` re-homed to bit 17 (a CLI concern, not the IR seam); v0 `loaders.ts` dropped (F4).
- `gen/emit/shared/{lang,sanitize,hash,format}.ts` (+test each) — the sanitizer + the mandatory formatter post-pass (H12); one shared string-escape layer (F2).
- `gen/extract/{extract,walk,serialize,chain}.ts` (+test each, split from v0 type-extractor.ts 855) — ts-morph compiler API; ts-morph optional peer.
- `src/meta/{meta-spec,meta-spec-merge,meta-spec-validate}.ts` (+test) — split from v0 718.
- **core schema conversion** `src/schema/{to-json-schema,zod,valibot,arktype,yup,effect,slots,canonicalize,naming,sanitize-spec}.ts` (+test each, split from v0 `codegen.ts`) — standard-schema → JSON Schema, the seam that feeds the IR. (`resolve-refs` is a gen concern — `gen/ir/resolve-refs.ts` — since only SDK generation deep-resolves refs; core uses `sanitize-spec`.)
- **core collection** `src/openapi/{collect,extract-schemas,json-schema-slot}.ts` (+test each) — walk finalized routes → operation records + per-route schema extraction (bit 09 owns these; document assembly is bit 10). Resolves the bin conflict: `collect`/`json-schema-slot` are **bit 09**, not 10.

## Tests (named, written first)
- `gen/ir/build.test.ts` — resource tree from dotted operationId; request/response slots carry declared schema + content-type; realtime/SSE/WS markers.
- `schema/to-json-schema.test.ts` + per-adapter `schema/{zod,valibot,arktype,yup,effect}.test.ts` — each validator's conversion cases: primitives, objects (required/optional), arrays, enums, unions, nullable, refinements that have a JSON-Schema equivalent (and degrade cleanly when they don't), `Date`/`BigInt` wire shapes, input-vs-output optionality. `schema/slots.test.ts` — collect/hoist/dedup/ref-rewrite; `schema/canonicalize.test.ts` — code-unit ordering, stable across machines.
- `openapi/collect.test.ts` — operation records from finalized routes; `x-*` extensions pass through; `openapi/extract-schemas.test.ts` — per-route schema extraction.
- `gen/emit/shared/escape.test.ts` — no raw spec text reaches source; identifier collisions resolved deterministically (code-unit order, no `localeCompare`).
- `gen/emit/shared/format.test.ts` — the formatter post-pass is applied; fallback path emits valid unformatted code.
- `gen/extract/extract.test.ts` — middleware ctx/chain extracted via the checker (ported hardening cases).

## Security corpus
- the shared string-escape layer is fuzzed here (F2): every emitter inherits it.

## Budget
- token: the IR→surface size per operation is the measured input to the token budget (bit 7.1).
