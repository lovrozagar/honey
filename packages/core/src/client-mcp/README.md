# client-mcp/

Static MCP runtime templates. Files `server.ts` + `types.ts` are copied
verbatim into emitted `@{project}/mcp-server` packages by
`codegen-mcp.ts` at codegen time via `readFileSync(new URL(..., import.meta.url))`.

Changes here propagate to every emitted MCP server on next regen.

Do not import from this directory in honey/core runtime code — it only
exists as a template source for the emitter.
