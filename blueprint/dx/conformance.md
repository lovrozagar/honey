# dx — SDK conformance matrix

The proof that **every feature works in every generated target**. Analogous to the server's 96-cell observability matrix, but for the emitted artifacts: one reference honey app exposing every feature, and a shared scenario suite each target runs against the **live reference server**, asserting the decoded result **and** the wire match one expected table. A feature correct in TS but broken in Rust cannot slip through, because the grid enumerates feature × target — a missing or diverging cell is red.

## The three layers (all required; this file owns layer 3)

1. **Compile** — the generated code builds in its real toolchain (tsc/oxfmt, `go build`, `cargo build`, `python -m py_compile`+mypy, `dotnet build`, `javac`). `polyglot-compile`, `examples-compile`, go-cli `compile`.
2. **Golden / byte-equiv** — emitter output + each `runtime/<lang>/*` template is deterministic (`*-emitter-byte-equiv`, golden siblings).
3. **Behavioral conformance (this matrix)** — each target drives the shared scenarios against the running reference app and must produce identical observable behavior.

## Targets (8)

`ts`, `go`, `rust`, `python`, `csharp`, `java` (SDKs) · `cli` (the Go binary) · `mcp` (the server, driven by an MCP client harness).

## Features (rows) — every one exercised by every target

| feature | asserted |
| --- | --- |
| each verb (GET/POST/PUT/PATCH/DELETE) + path/query/header params | request wire matches; typed result decoded |
| JSON request + response, status-keyed results | the right status variant is returned/narrowed |
| typed errors (honey error-key) | error surfaces as the target's typed error; key preserved |
| binary response (A1) | bytes/stream type; `Accept` set to the declared media type |
| binary request (`.input({ binary })`) | raw body sent with the declared content-type |
| typed response headers (A2) | declared headers readable on the response |
| SSE stream | events typed from the declared schema; ordering preserved |
| SSE/WS **reconnect** (`Last-Event-ID`) | resumes from the last id against the bit-06 reference server — parity across all targets |
| per-call overrides (base/timeout/headers) (C2) | override applied, client default untouched |
| raw-response accessor (C2) | status + headers + body reachable |
| auth (api key / bearer / custom) | sent on-origin; **dropped on a cross-origin redirect** (H18.10) — all targets, incl. C#/Java whose HttpClient resends by default |
| request id propagation | `x-request-id` round-trips |

CLI-only rows: `--json` uniform output, exit codes, `--output <file>` binary, discovery index, shell completion. MCP-only rows: `x-mcp` gating, `outputSchema`+`structuredContent`, tool annotations (readOnly/idempotent/destructive), binary/image result, token-budget ceiling.

## How it runs

- One reference app (`tests/integration/conformance/app.ts`) is generated into all 8 targets; each target's scenario runner hits the **live** app (the `mock-server`/reference server), not a recorded fixture.
- Each cell asserts: the HTTP wire honey received (method, path, headers sans volatile, body) **and** the target's decoded value/error, against one expected table shared by all targets — so divergence between languages is the failure, not just a per-language bug.
- The matrix is **complete or red**: a target missing a feature row, or a row whose result differs across targets, fails CI. New feature ⇒ new row ⇒ exercised in every target.

Tests: `tests/integration/conformance/{matrix,app}.ts` + per-target `conformance/<target>.test.ts`; realtime reconnect rides the bit-06 reference server; owned by bits 11–18, gated in bit 18's token budget and bit 19's release (no SDK ships with a red conformance cell).

**Resource hygiene (see 00-rules "Toolchain resources"):** the matrix runs real toolchains, so build artifacts go under `~/.cache/honey-tmp/` on disk — **never `/tmp`** (a RAM-backed tmpfs here); languages run serially (≤2 at a time) with each cleaning its `~/.cache/honey-tmp/<lang>` before the next; a step checks free memory/disk before a heavy compile and cleans+waits rather than piling on. This is opt-in (`test:harness`), not part of `bun run test`.
