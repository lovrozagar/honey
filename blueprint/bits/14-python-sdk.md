# Bit 14 — Python SDK

Closes: C2 · A1/A2
Oracle kept green: `tests/integration/python-harness`, python-emitter byte-equivalence, python-nested.
Formatter post-pass: ruff (or black) — mandatory, not a `# noqa` suppression. Runtime: vendored, `httpx` (H9).

## Scope
The Python SDK emitter + vendored runtime (split v0 `codegen-python.ts` 916, `python-type-emitter.ts` 181 into `gen/emit/python/`). Reads only the IR.

## Files (from files.tsv — `gen/emit/python`)
- `gen/emit/python/{sdk,types,transport,sse,ws,errors}.ts` (+test each) + index.
- `gen/runtime/python/*` — vendored httpx runtime template.

## Tests (named, written first)
- `gen/emit/python/sdk.test.ts` — operations + models from IR; sync + async clients.
- `gen/emit/python/overrides.test.ts` — per-call overrides + raw response (C2).
- `gen/emit/python/sse.test.ts` + `gen/emit/python/ws.test.ts` — typed events; reconnect against the reference server (H8).
- `gen/emit/python/binary.test.ts` — `bytes`/stream; typed headers (A1/A2).
- `gen/emit/python/format.test.ts` — output is ruff/black-clean (no blanket `# noqa`).
- `conformance/python.test.ts` — the Python client runs the shared conformance matrix against the live reference server.

## Security corpus
- shared string-escape (F2).

## Budget
- token: per-operation size within budget.
