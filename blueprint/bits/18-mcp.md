# Bit 18 — MCP server

Closes: D1 (structured output, annotations, binary)
Oracle kept green: `tests/integration/mcp-harness`, mcp-meta-serializer, codegen-mcp(-hardening).
Formatter post-pass: biome (the MCP server is TS). Gating: `.meta({ extensions: { "x-mcp": true } })`.

## Scope
The MCP **server** emitter (split v0 `codegen-mcp.ts` 445 + `client-mcp/server.ts` 221 into `gen/emit/mcp/`). The biggest lever for the agent-token metric. Reads only the IR.

## Files (from files.tsv — `gen/emit/mcp`)
- `gen/emit/mcp/{server,tools,output-schema,annotations,binary,errors}.ts` (+test each) + index. (`inputSchema` is emitted inside `tools.ts`.)
- `gen/runtime/mcp/*` — vendored MCP server runtime template.

## Tests (named, written first)
- `gen/emit/mcp/tools.test.ts` — only `x-mcp` operations become tools; `inputSchema` from the IR.
- `gen/emit/mcp/output-schema.test.ts` — `outputSchema` emitted + `structuredContent` returned (D1), with a text fallback.
- `gen/emit/mcp/annotations.test.ts` — `readOnly` for GET, `idempotent`/`destructive` from method/meta (D1).
- `gen/emit/mcp/binary.test.ts` — image/blob result once A1 lands.
- `gen/emit/mcp/token-budget.test.ts` — each tool schema within the per-operation threshold (H6); a bloated schema fails.

- `conformance/mcp.test.ts` — the MCP server runs the shared conformance matrix (tools, outputSchema+structuredContent, annotations, binary result, token-budget) via an MCP client harness against the live reference server (dx/conformance.md).

## Security corpus
- shared string-escape (F2); tool input schema cannot smuggle a prototype-pollution key.
- `codegen/mcp/path-guard.test.ts` — the path-param guard rejects any value containing `/`, `\`, `%2f`, `%5c`, or a `.`/`..` segment (H18.11), not just whole-string `""`/`.`/`..` (v0 `client-mcp/server.ts:131`). Adversarial: agent tool input `id = "../../admin"`, `"a/b"`, `"x%2f..%2fy"` must be refused, not delegated to the SDK path encoder.

## Budget
- token: **the** gated surface — every tool schema measured; this bit owns the strictest token budget.
