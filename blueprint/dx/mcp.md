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
| `mcp(app, path, handler, options?)` | — | — | **[bit 21]** mounts the generated MCP handler on the app from `@lovrozagar/honey/mcp`: POST only (GET/DELETE 405), under the app's middleware and basePath, kept out of the document and the tool set; tool calls dispatch in-process through `app.fetch` | the subpath, not the root, so an app that serves no MCP bundles none of it | `mcp/mount.test.ts` |
| `authenticate(request, ctx)` | when any mounted tool's operation declares security | — | **[bit 21]** runs before any dispatch; `false` answers HTTP 401 with `WWW-Authenticate`; returns a boolean only, so no principal travels and the inner routes re-check the forwarded credential | a secured tool set mounted without it throws at mount time; there is no opt-out | `mcp/mount.test.ts` |
| `codegen.mcp` | — | off | **[bit 21]** the plugin output that writes the mounted handler (an entry plus its companion directory); `true`, a path or an object | the standalone stdio/HTTP server still comes from `honey-codegen generate` | `build/config.test.ts`, `emit/mcp/mounted.test.ts` |
