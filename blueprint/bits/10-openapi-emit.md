# Bit 10 — OpenAPI emission

Closes: B1 (servers+variables) · B2 (tags/externalDocs) · B3 (webhooks/callbacks)
Oracle kept green: `unit/codegen/*-openapi` (now gen), the openapi document tests, scalar/swagger serving.

## Scope
Core emits the OpenAPI 3.1 document from the collected operations. Split v0 `openapi/document.ts` 902. Add configurable `servers` + variables, `tags`/`externalDocs` from the resource tree or route meta, and `webhooks` (3.1). Human docs (scalar, swagger, docs-page) stay.

## Files (from files.tsv — core `openapi`)
- `src/openapi/document.ts` (+test, split from 902), `src/openapi/{paths,components,security}.ts` (+test each), `src/openapi/generate.ts` (+test, `generateOpenApi` orchestration), `src/openapi/manifest.ts` (+test, `generateManifest`), `src/openapi/spec-factory.ts` (+test), `src/openapi/spec.ts` (+test). (`collect`, `extract-schemas`, `json-schema-slot` are **bit 09**.)
- `src/openapi/servers.ts` (+test) — list + variables, composed with stripPrefix/basePath (B1).
- `src/openapi/tags.ts` (+test) — tags/externalDocs from the resource tree (B2).
- `src/openapi/webhooks.ts` (+test) — 3.1 `webhooks` declaration (B3).
- `src/openapi/{scalar,swagger,docs-page,serve}.ts` (+test each), `src/openapi/register.ts` (index).
- consumes `routing/invalidate-check.ts` (the pure `missingInvalidate*` analysis, born bit 01): the emitter runs it over the **emitted operations** and logs/throws the report per `InvalidateCheckLevel` through the **bit-07 logger** (not finalize — finalize has no operations). Add a case asserting a mutation with no declared invalidate targets is reported at `warn`/`error` per config.

## Tests (named, written first)
- `openapi/servers.test.ts` — multiple environments + variables render; basePath composition correct.
- `openapi/tags.test.ts` — tags derived; operationId grouping for SDKs unchanged.
- `openapi/webhooks.test.ts` — a declared webhook appears in `webhooks`; the SDK gets a typed payload parser + signature-verify helper (vendored runtime glue, `emit/shared/webhooks.ts`).
- `codegen/webhooks.test.ts` — the emitted verify helper uses the language's **constant-time** comparison (H18.9): TS `crypto.timingSafeEqual`, Python `hmac.compare_digest`, Go `hmac.Equal`, Rust `subtle`/`ring` constant-time, C# `CryptographicOperations.FixedTimeEquals`, Java `MessageDigest.isEqual` — never `==`/`.equals()`/string compare (a signature timing oracle can't be fuzzed, so it is asserted structurally).
- `openapi/document.test.ts` — 3.1 output stable; `x-realtime`/`x-websocket`/`x-mcp` extensions pass through.

## Security corpus
- YAML/JSON emission injection; server-variable injection; webhook signature-verify correctness **and constant-time comparison** (timing side channel).

## Budget
- token: the emitted document per operation is bounded; oversized schemas flagged.
