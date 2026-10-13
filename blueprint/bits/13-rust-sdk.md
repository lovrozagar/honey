# Bit 13 — Rust SDK

Closes: C2 · A1/A2
Oracle kept green: `tests/integration/rust-harness`, rust-emitter byte-equivalence, rust-nested.
Formatter post-pass: rustfmt. Runtime: vendored, `reqwest` + `tokio`/`tokio-tungstenite` (H9).

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
