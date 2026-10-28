# The generated MCP server

`honey-codegen generate --target mcp` writes a Model Context Protocol server: one tool per operation, its
input schema from the operation's parameters and body, and structured output for agents. Read-only operations are
annotated as such. The server takes its base URL, extra headers (`$<PREFIX>_HEADERS`) and its redirect policy
(`$<PREFIX>_REDIRECT`) from the environment.

## Example

```sh
honey-codegen generate --spec openapi.json --target mcp --out ./mcp
```

## Reference

| Value                                             | Default                 | What it does                                                                                                                      | Watch for                                                         |
| ------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `.meta({ extensions: { "x-mcp": true } })` gating | required to emit a tool | only operations marked `x-mcp` become tools                                                                                       | an unmarked operation is not exposed                              |
| tool `inputSchema`                                | from the operation      | typed tool input from the request schema                                                                                          | derived from the IR, not hand-written (emitted inside `tools.ts`) |
| tool `outputSchema` + `structuredContent`         | emitted                 | typed structured result from the response schema                                                                                  | replaces text-only results; still includes a text fallback        |
| tool annotations                                  | from method/meta        | `readOnly` (GET), `idempotent`, `destructive` hints                                                                               | derived from HTTP method + meta, not guessed                      |
| binary / image result                             | —                       | an image or audio body is its content type's MCP content; other bytes an embedded resource; past 1 MiB `isError`, the status kept | base64/blob per the MCP content type                              |
| error result                                      | `{ isError: true }`     | failures surface as tool errors                                                                                                   | the error key maps to the typed error model                       |
| token budget                                      | enforced                | each tool schema is measured against the per-operation threshold                                                                  | an oversized tool schema fails the token gate                     |
