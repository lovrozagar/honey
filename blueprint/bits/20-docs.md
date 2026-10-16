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

## Security corpus
- none (docs); examples must not demonstrate an insecure default.

## Budget
- token: the agent-facing docs/skills bundle is measured against the token budget (H6).
