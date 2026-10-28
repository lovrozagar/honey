# dx — MCP server (generated)

The emitted MCP **server** exposes the API's operations as MCP tools to an agent. v1 adds structured output + annotations + binary results (D1) — the biggest lever for the agent-token metric.

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| `.meta({ extensions: { "x-mcp": true } })` gating | — | required to emit a tool | only operations marked `x-mcp` become tools | an unmarked operation is not exposed | `emit/mcp/tools.test.ts`, `emit/mcp/server.test.ts` |
| tool `inputSchema` | — | from the operation | typed tool input from the request schema | derived from the IR, not hand-written (emitted inside `tools.ts`) | `emit/mcp/tools.test.ts` |
| tool `outputSchema` + `structuredContent` | — | emitted | **[D1]** typed structured result from the response schema | replaces text-only results; still includes a text fallback | `emit/mcp/output-schema.test.ts` |
| tool annotations | — | from method/meta | **[D1]** `readOnly` (GET), `idempotent`, `destructive` hints | derived from HTTP method + meta, not guessed | `emit/mcp/annotations.test.ts` |
| binary / image result | — | — | **[D1]** an image or audio body is its content type's MCP content; other bytes an embedded resource; past 1 MiB `isError`, the status kept | base64/blob per the MCP content type | `emit/mcp/result.test.ts` |
| error result | — | `{ isError: true }` | failures surface as tool errors | the error key maps to the typed error model | `emit/mcp/result.test.ts` |
| resources (GET-list) | — | **proposed** | **[D1]** consider MCP `resources` for list endpoints | proposed, not applied until approved | decision only (bit 18) |
| token budget | — | enforced | each tool schema is measured against the per-operation threshold [H6] | an oversized tool schema fails the token gate | `emit/mcp/output-schema.test.ts` |
