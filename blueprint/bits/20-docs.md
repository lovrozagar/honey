# Bit 20 — docs

Closes: — (documents every v1 capability so none drifts back to undocumented surface, the way the v0 gif path did)
Oracle kept green: the docs build; `dx/` cross-check.

## Scope
Every public value in `dx/` has user-facing docs, and every new capability (open media types + headers, range, cache-control, rate-limit, compress, problem+json, webhooks, realtime resume, C#/Java SDKs, the cf-grade CLI, MCP structured output) is documented with an example and its test reference. The OpenAPI human docs (scalar/swagger) and the agent skills bundle (bit 17) are part of docs.

Per-SDK usage recipes are documented here, including: **Rust sync use via a tokio `Runtime` + `block_on`** — the async-only Rust SDK's blocking recipe, which the bit-13 sync-client CUT (H20-style) promises. The `examples/rust/example.rs` compile check lives here (reassigned from bit 19: it is docs-examples-compile, not release), alongside the other `examples/*/example.*` ports in `docs/examples-compile.test.ts`.

## Files (from files.tsv — `testing`, docs)
- `src/testing/testing.ts` (+test) — the public testing helper used by consumer docs examples.
- docs site sources + per-capability pages (one page per `dx/` area).

## Tests (named, written first)
- `docs/dx-coverage.test.ts` — every `dx/` value appears in a docs page (no undocumented public value), **and every `dx/` test reference resolves to a real `files.tsv` sibling or a named integration/telemetry/e2e suite** (a dangling dx pointer fails the build — closes the round-2 grading finding).
- `docs/examples-compile.test.ts` — every docs code example compiles/runs (ported from v0 examples-compile).
- `docs/new-capability.test.ts` — each v1-added capability has a page + an example + a named test.

**Bit 17 carry-in.** The generated CLI module ships no README (its docs are `--help`, `commands`, `schema` and the embedded SKILL.md). Document how an API author writes the module's README and points it at the install one-liner and the release flow.

**Bit 19 carry-in: the 1.0 migration notes.** Document each deliberate break from v0 0.7.x:
- The `@lovrozagar/honey/codegen` export goes: its SDK, CLI and MCP generators move to `@lovrozagar/honey-codegen` (the `honey-codegen generate` bin and its module API). Only v0's document-level `mergeSpecs` and `scopeSpec` (merging or cutting finished OpenAPI files) are removed (bit 19 Q5). Several honey services still combine into one source of truth through `mergeTree` over their route trees, and one merged tree still emits several documents (`codegen.openApi` outputs, each with its own securitySchemes and `filterRoutes`), as Anyrow's gateway does. Merging a third-party document is a post-1.0 IR feature.
- `--app` takes a module that exports the app and binds nothing (bit 19 Q3); v0's no-bind flag has no v1 counterpart because v1 never serves implicitly.
- The TS SDK's realtime connection options `token?` and `onAuthExpired?` are removed (bit 19 Q8 and b2; neither was ever read): `headers` may be a function read on every dial, and the client-level `onAuthExpired` is the one refresh hook.
- Generated SDK error messages read `HTTP <status>: <message>` in every target (bit 19 d2).

## Security corpus
- none (docs); examples must not demonstrate an insecure default.

## Budget
- token: the agent-facing docs/skills bundle is measured against the token budget (H6).
