# Bit 18 — MCP server

Closes: D1 (structured output, annotations, binary)
Oracle kept green: `tests/integration/mcp-harness`, mcp-meta-serializer, codegen-mcp(-hardening).
Formatter post-pass: oxfmt (the MCP server is TS). Gating: `.meta({ extensions: { "x-mcp": true } })`.

## Scope
The MCP **server** emitter (split v0 `codegen-mcp.ts` 445 + `client-mcp/server.ts` 221 into `gen/emit/mcp/`). The biggest lever for the agent-token metric. Reads only the IR.

## Files (from files.tsv — `gen/emit/mcp`)
- `gen/emit/mcp/{server,tools,output-schema,annotations,binary,errors}.ts` (+test each) + index. (`inputSchema` is emitted inside `tools.ts`.)
- `gen/runtime/mcp/*` — vendored MCP server runtime template.
- As shipped (the close's mapping): the emitter is `server.ts` (the package: `src/`, a jiti-erased CommonJS twin the bin runs, since node refuses to strip types inside an installed package; `package.json` with no dependency), `tools.ts`, `schema.ts`, `literal.ts`, `output-schema.ts`, `annotations.ts` and `runtime.ts` (the runtime joined into one module); the vendored runtime is `gen/runtime/mcp/{jsonrpc,server,stdio,call,guard,result,stream}.ts` (stdio only; 2025-11-25 negotiating down to 2025-03-26, no outputSchema or structuredContent under 2025-03-26; calls concurrent, replies by id). Dropped from the plan: `binary.ts` and `errors.ts` (binary and error results ship in `runtime/mcp/result.ts`, tested by `result.test.ts`), `types.ts` (no emitted types module), `path-guard.test.ts` (H18.11 lives in the security corpus).

## Tests (named, written first)
- `gen/emit/mcp/tools.test.ts` — only `x-mcp` operations become tools; `inputSchema` from the IR.
- `gen/emit/mcp/output-schema.test.ts` — `outputSchema` emitted + `structuredContent` returned (D1), with a text fallback.
- `gen/emit/mcp/annotations.test.ts` — `readOnly` for GET, `idempotent`/`destructive` from method/meta (D1).
- `gen/emit/mcp/binary.test.ts` — image/blob result once A1 lands.
- `gen/emit/mcp/token-budget.test.ts` — each tool schema within the per-operation threshold (H6); a bloated schema fails.

- `conformance/mcp.test.ts` — the MCP server runs the shared conformance matrix (tools, outputSchema+structuredContent, annotations, binary result, token-budget) via an MCP client harness against the live reference server (dx/conformance.md).
- Closed at f: 33 cells through the official sdk client, 24 run and 9 lacked by design, each stated in the runner (auth/api-key-on-origin and auth/cross-origin-redirect-drops: no header or redirect config; overrides ×3 and raw-response: a tool has no per-call transport options; reconnect/ws-reconnect-token: ws is no tool; request-id/explicit; verbs/reference-request: H18.11 refuses its `/`); the MCP-only rows gating, output-schema, annotations, binary-result and token-budget; the cell × mutant grid of 19 mutants with no hollow cell. Every API-answered result carries `_meta: {"honey/status": n}`.
- Decided: D1's resources are out (Q12): the server declares no resources capability; a binary result is embedded-resource content inside a tool result. ws, realtime and multipart operations are not tools, and generate names each one skipped; an SSE operation is a bounded collect (`max_events`, `last_event_id`, `ended`).

## Security corpus
- shared string-escape (F2); tool input schema cannot smuggle a prototype-pollution key.
- As shipped, the path guard's corpus is in `tests/security/emit-adversarial.mcp.test.ts` beside its siblings (decoding until stable, `%252f`, mixed case), with prototype keys refused in schemas and arguments, the F2 fuzz through the whole tool emitter, and the API key scrubbed raw, URL- and form-encoded from results, error bodies and stderr. The planned `codegen/mcp/path-guard.test.ts` — the path-param guard rejects any value containing `/`, `\`, `%2f`, `%5c`, or a `.`/`..` segment (H18.11), not just whole-string `""`/`.`/`..` (v0 `client-mcp/server.ts:131`). Adversarial: agent tool input `id = "../../admin"`, `"a/b"`, `"x%2f..%2fy"` must be refused, not delegated to the SDK path encoder.

## Budget
- token: **the** gated surface — every tool schema measured; this bit owns the strictest token budget.
- Closed at g (`scripts/sdk-budget.mcp.test.ts`): each e2e app's tools/list read from its running server, the total and the largest tool at `ceilingOf(measured, 0.2)`, with completeness: compose 363 / 72, defaults 127 / 51, gateway 367 / 141, kitchen 627 / 71, surface 2,110 / 205 (the largest tool under 00-rules' provisional ~400); the conformance reference app 2,305 / 203.
- runtime: locked at zero headroom at 29,649 B, every file named (a 8,383, b 11,998, c 18,567, d 23,299, e 29,471, f 29,649).
