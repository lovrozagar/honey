# Bit 12 — Go SDK

Closes: C2 · A1/A2
Oracle kept green: `tests/integration/go-harness`, go-emitter byte-equivalence, go-nested.
Formatter post-pass: gofmt (mandatory, not opt-in). Runtime: vendored, `net/http` + the WS lib (H9).

## Scope
The Go SDK emitter + vendored runtime (split v0 `codegen-go.ts` 970, `go-type-emitter.ts` 660 into `gen/emit/go/`). Reads only the IR.

## Files (from files.tsv — `gen/emit/go`)
- `gen/emit/go/{sdk,types,http,sse,ws,errors}.ts` (+test each) + index.
- `gen/runtime/go/*` — vendored Go runtime template.

## Tests (named, written first)
- `gen/emit/go/sdk.test.ts` — operations + resource structs from IR.
- `gen/emit/go/overrides.test.ts` — per-call overrides + raw response (C2).
- `gen/emit/go/sse.test.ts` + `gen/emit/go/ws.test.ts` — typed events; reconnect against the reference server (H8).
- `gen/emit/go/binary.test.ts` — `[]byte`/stream; typed headers (A1/A2).
- `gen/emit/go/format.test.ts` — output is gofmt-clean.
- `conformance/go.test.ts` — the Go client runs the shared conformance matrix against the live reference server (dx/conformance.md).

## Security corpus
- shared string-escape (F2); go-cli shares the same emit layer (bit 17).

## Budget
- token: per-operation size within budget; the single static binary (CLI, bit 17) stays small.
