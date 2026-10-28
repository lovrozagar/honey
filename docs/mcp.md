# The generated MCP server

`honey-codegen generate --target mcp` writes a Model Context Protocol server: one tool per operation, its
input schema from the operation's parameters and body, and structured output for agents. Read-only operations are
annotated as such. The server takes its base URL, extra headers (`$<PREFIX>_HEADERS`) and its redirect policy
(`$<PREFIX>_REDIRECT`) from the environment. A multipart operation is a tool too: each part is an argument, a file
part a file argument (see [File arguments](#file-arguments)). The server speaks stdio by default and Streamable HTTP
with `--http` (see [Over HTTP](#over-http)).

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
| file argument                                     | inline or `{path}`      | a multipart file part, sent as `multipart/form-data` with the form's text parts                                                   | a path is read only over stdio, inside `$<PREFIX>_FILE_ROOT`      |
| `--http`                                          | stdio                   | Streamable HTTP at `/mcp` on `127.0.0.1:8000`, a bearer token required                                                            | the token is `$<PREFIX>_MCP_TOKEN`; it never reaches the API      |

## File arguments

A multipart operation marked `x-mcp` is a tool. Each text part is an argument with the part's own schema; each file
part is a file argument, or a list of them when the part is an array. The form always goes as `multipart/form-data`,
with or without a file in it.

A file argument takes one of two values:

- **Inline**, as the provisional file-uploads extension (`io.modelcontextprotocol/files`, its draft at PR head
  `6101d34`) has it: `{ id, mimeType, size, digest: { algorithm: "sha-256", value }, name?, data }`. `data` is standard
  base64 with its padding: no whitespace, no `data:` prefix, no base64url. It must decode to exactly `size` bytes whose
  SHA-256, base64url without padding, is `digest.value`. All inline files of one call together are at most
  `$<PREFIX>_MAX_INLINE_BYTES` decoded (1 MiB by default). A value without `data` asks for an upload, which this
  server does not serve yet, so it does not advertise the extension: an official client sends an inline file anyway.
- **`{ path }`**, read by the server from its own disk, over stdio only:
  - The path resolves against `$<PREFIX>_FILE_ROOT`, the server's working directory at start by default. A root that
    is no directory stops the server at start.
  - The path is resolved through every symlink and must stay under the resolved root. A `..` chain, an absolute path
    elsewhere, or a link out of the root is refused.
  - The file is opened without following a last link and without waiting on a FIFO. It is read only if its descriptor
    is a regular file and the very file the path resolved to: a swap between the check and the open is refused.
  - It is at most `$<PREFIX>_MAX_FILE_BYTES` (50 MiB by default) and is read to exactly the size it had when opened.
    A file that grows while it is read is refused, as is a `/proc` file whose size is not its length.
  - A refusal names the rule broken, never the path.

**A hard link inside the root to a file outside it cannot be told apart from a file of the root.** It is the same
file to the kernel, so no path check sees it. Keep the root narrow and let no one who should not read a file link it
there.

Each file argument costs a tool 98 tokens of schema. The file-uploads extension is a draft that may still change;
honey tracks it at every phase of bit 21.

## Over HTTP

`<name>-mcp --http` serves Streamable HTTP at `/mcp`, for MCP 2026-07-28 and for 2025-11-25 down to 2025-03-26 on one
endpoint. It keeps no session: each POST is answered on its own, and no `Mcp-Session-Id` is ever sent.

```sh
SHOP_MCP_TOKEN=$(openssl rand -hex 32) SHOP_API_KEY=… shop-mcp --http --port 8000
```

- **`--host`** is `127.0.0.1` by default. `localhost` and `::1` are loopback too. Any other address needs `--expose`.
- **`--port`** is `8000` by default; `0` lets the system pick one. The server says where it listens on stderr:
  `shop MCP server on http://127.0.0.1:8000/mcp`.
- **The token.** Every request sends `$<PREFIX>_MCP_TOKEN` as `Authorization: Bearer <token>`, else it gets 401. The
  server compares the token in constant time. Without the variable set, the server refuses to start unless
  `--no-auth` is given. `--no-auth` with the variable set, or with `--expose`, refuses to start too.
- **The API's own key.** Tool calls reach the API with `$<PREFIX>_API_KEY`, exactly as over stdio. The token is never
  sent to the API, and a result that holds it has it scrubbed.
- **DNS rebinding.** The server answers only a `Host` of `127.0.0.1`, `localhost` or `[::1]` with its own port: any
  other gets 421 (Misdirected Request). `--expose` drops this check, for a non-loopback bind or a reverse proxy that
  sends its own host name; the token is then the guard.
- **Origin.** A browser's `Origin` must be the server's own, else 403. `$<PREFIX>_MCP_ORIGINS` lists others,
  comma-separated, each compared exactly (`https://app.example`). A request with no `Origin` is served.
- **Limits.** POST only (405 otherwise). `Accept` must name `application/json` and `text/event-stream` (406), and the
  body must be JSON (415). A body is read at most `$<PREFIX>_MAX_BODY_BYTES` (4 MiB by default) as it arrives, whatever
  `Content-Length` says (413).
- **Files.** Only inline file values work over HTTP. A `{ path }` is a tool error: a remote caller never makes the server
  read its own disk.
- **Answers.** An answer is JSON, or an event stream once a call reports progress. Under 2026-07-28, closing the request
  or its stream cancels the call; under 2025-11-25 a disconnect is no cancel, as that revision says.
