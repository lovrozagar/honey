# Bit 13 — Rust SDK

Closes: C2 · A1/A2 · H8 (SSE/WS resume) · H18.10 (cross-origin auth drop). C1 auto-pagination is CUT (H20); the sync (blocking) client is CUT (H20-style) — async-only, sync is a tokio `Runtime` + `block_on` (bit 20 recipe).
Oracle kept green: `tests/integration/rust-harness`, rust-emitter determinism (re-emit is byte-identical, H22), rust-nested.
Formatter post-pass: rustfmt (mandatory, not opt-in; H12, `dx/codegen.md`). Runtime: vendored, `reqwest` + `tokio`/`tokio-tungstenite` (H9); built/tested under the pinned stable channel in `rust-toolchain.toml` (G9/G10, mirroring `.go-version`/GOTOOLCHAIN), shipped-SDK MSRV floor named once the runtime deps are pinned (phase b).

## Scope
The Rust SDK emitter + vendored runtime (split v0 `codegen-rust.ts` 1,402, `rust-type-emitter.ts` 548 into `gen/emit/rust/`). Reads only the IR.

## Files (from files.tsv — `gen/emit/rust`)
- `gen/emit/rust/{sdk,types,http,sse,ws,errors,realtime}.ts` (+test each) + index.
- `gen/runtime/rust/*` — vendored Rust runtime template.

## Tests (named, written first)
- `gen/emit/rust/sdk.test.ts` — operations + types from IR; `Result` error mapping.
- `gen/emit/rust/overrides.test.ts` — per-call overrides + raw response (C2).
- `gen/emit/rust/sse.test.ts` + `gen/emit/rust/ws.test.ts` — typed events; reconnect against the reference server (H8).
- `gen/emit/rust/binary.test.ts` — `bytes`/stream; typed headers (A1/A2).
- `gen/emit/rust/format.test.ts` — output is rustfmt-clean.
- `conformance/rust.test.ts` — the Rust client runs the shared conformance matrix against the live reference server.

## Security corpus
- shared string-escape (F2).

## Budget
- token: per-operation size within budget.
