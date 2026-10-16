# Bit 14 — Python SDK

Closes: C2 · A1/A2 · H8 (SSE/WS resume) · H18.10 (cross-origin auth drop). C1 auto-pagination is CUT (H20); sync + async clients both ship — unlike Rust's cut, because the async-only recipe fails in Python (G2: `asyncio.run` can't nest, a reused async client dies), with streams async-only.
Oracle kept green: `tests/integration/python-harness`, python-emitter determinism (re-emit is byte-identical, H22), python-nested.
Formatter post-pass: ruff (mandatory — `ruff format` + `ruff check` on the pinned ruff, no `# noqa` suppression; G13). Runtime: vendored, `httpx2 >=2.12.0,<3` (+`httpx2[ws]` only when the IR has ws/realtime ops — Go's require model, Fb3; G9, supersedes the abandoned `httpx` with its unpatched CVEs, and drops the `websockets` dep); shipped-SDK floor `requires-python >=3.11` built/tested under the pinned `.python-version` via uv (G10/G11, H9).

## Scope
The Python SDK emitter + vendored runtime (split v0 `codegen-python.ts` 916, `python-type-emitter.ts` 181 into `gen/emit/python/`). Reads only the IR.

## Files (from files.tsv — `gen/emit/python`)
- `gen/emit/python/{sdk,types,transport,sse,ws,errors}.ts` (+test each) + index.
- `gen/runtime/python/*` — vendored httpx2 runtime template.

## Tests (named, written first)
- `gen/emit/python/sdk.test.ts` — operations + models from IR; sync + async clients (streams async-only, G2).
- `gen/emit/python/overrides.test.ts` — per-call overrides + raw response (C2).
- `gen/emit/python/sse.test.ts` + `gen/emit/python/ws.test.ts` — typed events; reconnect against the reference server (H8).
- `gen/emit/python/binary.test.ts` — `bytes`/stream; typed headers (A1/A2).
- `gen/emit/python/format.test.ts` — output is ruff-clean (`ruff format` + `ruff check`, no blanket `# noqa`).
- `conformance/python.test.ts` — the Python client runs the shared conformance matrix against the live reference server.

## Security corpus
- shared string-escape (F2).

## Budget
- token: per-operation size within budget.
