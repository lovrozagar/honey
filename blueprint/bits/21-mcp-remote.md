# Bit 21 — MCP files and remote MCP

Closes: the bit 18 carry-ins deferred at bit 19 (Streamable HTTP; multipart operations as tools), superseded by H24.
Oracle kept green: the MCP conformance grid (stdio), `sdk-budget.mcp.test.ts`, `tests/security/emit-adversarial.mcp.test.ts`.
Spec target: MCP **2026-07-28** (stateless) and the legacy era 2025-11-25 … 2025-03-26, served dual-era (H24).

## Scope
- **Files:** an `x-mcp` operation with a multipart body becomes a tool. A file part is a file argument: inline base64 under a cap, a `{path}` the stdio server reads inside a hard root, or (over HTTP) an upload reference or an opt-in allowlisted https URL.
- **Remote:** Streamable HTTP, served either:
  - standalone by the generated MCP package (`--http`, 127.0.0.1 by default, token required), or
  - mounted in the app itself through `mcp(app, path, handler, options?)` from `@lovrozagar/honey/mcp`. Tool calls dispatch in-process through `app.fetch`, so the app's middleware, limits and per-route auth apply. When the app has auth, the endpoint refuses an unauthenticated request before any dispatch.
- **Auth:** the app's credential carried as a header (the default), or an opt-in OAuth 2.1 resource-server role (RFC 9728 protected-resource metadata, 401/403 challenges). honey never ships an authorization server.
- **The protocol:** one vendored, dependency-free runtime (H9), transport-agnostic and dual-era, under the stdio and HTTP transports. Stateless in both eras: no session id is ever minted.
- **Acceptance:** an Anyrow-shaped fixture with the five public multipart operations (extract ×2, extract-stream ×2 as a bounded SSE collect, suggest-schema; an `ApiKey` header scheme), driven by the official clients over stdio, standalone HTTP and the mounted endpoint (bun, node and Workers).

## Phases
| phase | content |
|---|---|
| a | this record: H24, the bit file, the `./mcp` surface row |
| b | dual-era protocol; the runtime split into `protocol` + `stdio`; modern 2026-07-28 over stdio; client pins add TS `@modelcontextprotocol/client` 2.4.0 and Python `mcp` 2.3.0 |
| c | files over stdio: multipart → tools, inline + path, the hard FILE_ROOT, caps; the provisional extension's wire shape behind one module; Anyrow-shaped acceptance over stdio |
| d | the HTTP transport + standalone `--http`: method table, headers, Origin/Host, token, JSON/SSE, cancel-on-close; batches only under 2025-03-26 |
| e | mounted: the plugin's `mcp` output (`_gen/mcp.gen.ts`), `@lovrozagar/honey/mcp`, in-process dispatch, credential forwarding, auth-before-dispatch, 401/403 → HTTP challenges; e2e bun/node/cf cells |
| f | opt-in OAuth resource server: PRM, challenges, the resource check; TS v2 client authProvider legs against a stub AS |
| g | remote files: the extension's upload flow (one-shot, scoped, expiring HMAC tokens; app-supplied `UploadStore` with an atomic claim) and the opt-in URL fetch |
| h | corpus completion, LACKS re-justified, docs, the budget close, the live Cloudflare leg (honey-63 runs it, as j3) |
| i | (only if the user rules R11 in) the SDK safe API redesign |

## Tests (named, written first)
- The `mcp` conformance target's `http` variant, run against standalone and mounted; legacy (TS sdk 1.32.2) and modern (TS client 2.4.0 pinned to 2026-07-28, Python mcp 2.3.0) clients over both transports.
- New MCP-only rows: file-inline, file-path (stdio), file-path-refused (http), origin-403, method-405, accept-406, header-mismatch-400, batch-by-era, auth-before-dispatch (an unauthenticated tools/list is refused on an authed app), auth-401-challenge, upload-one-shot, url-fetch-allowlist.
- A structure leg: no file but the extension module names `x-mcp-file`.
- A runtime-bundle leg: an app that imports nothing from `./mcp` bundles no MCP module.

## Security corpus
Every leg is red first:
- **Headers:** version/`_meta` mismatch; missing or mismatched `Mcp-Method`/`Mcp-Name`; non-ASCII encoded names; unsupported versions.
- **Origin** (`null`, case, ports, trailing dot, userinfo, IDN, scheme, duplicates) and **Host** (rebinding names, IPv6, ports).
- **Body:** size; nesting; batches per era; a POSTed JSON-RPC response; prototype keys.
- **Paths:** `..`, absolute outside, symlink and symlink chain escapes, the check-then-swap race (dev/ino), devices, FIFO, socket, directory, `/proc/self/*`, encoded and NUL bytes, growth past the cap.
- **Inline:** size vs declared, padding, whitespace, data-URI prefix, digest, cap ±1.
- **Uploads:** replay, expiry, scope swap (tool, args, principal), size/digest on PUT, foreign secret, PUT without a call.
- **URL fetch:**
  - hosts off the allowlist; no wildcard unless listed;
  - non-https;
  - a redirect off the allowlist;
  - a body past the cap with a lying Content-Length (the cap is streamed);
  - a timeout;
  - private, loopback, mapped and decimal/octal IP literals.
- **Auth:** an inner 401 surfaces as HTTP 401 with a challenge; credentials are scrubbed from results, errors and logs on every transport.

## Budget
- **Runtime bytes:** the MCP runtime lock is 31,165 B at zero headroom (`sdk-budget.mcp.test.ts:77`). Each phase names its added bytes per feature, with dead code cut first.
- **Tokens:** the per-app MCP ceilings move only by named tokens (the file tools of `surface` `POST /in/file` and the reference app's new routes); H6's per-tool ~400 holds.

## Tracked: the provisional file-uploads extension
The file argument's wire shape follows `io.modelcontextprotocol/files`. That is a draft extension in an open PR, https://github.com/modelcontextprotocol/experimental-ext-file-uploads/pull/1, pinned at head `6101d34eb52b21d4b87028543ecd1fd59ed3d5df`. It may change, its identifier included.
- **One module** owns that shape, and a structure leg holds that no other file names `x-mcp-file`.
- **Re-checked at every phase start and at the close:** a change in the PR is a one-module diff plus its legs.
- **No shipping client implements it yet;** the legs use a minimal extension client of our own.

## Recorded during the bit
- **Host refusal is 421** (Misdirected Request, RFC 9110 §15.5.20) where the TypeScript MCP SDK answers 403. A request for a host the server is not is misdirected, not forbidden.
- **`ctx.res.json(key)` has no runtime check** of a `.output()` key. The types are the contract. `assertOutputKeys` runs only where the document and route tree are generated, so the minimal bundle stays under its 26,200 B lock. A decided limit.
- **An upload store's claim lives in D1 or a Durable Object, its bytes in R2.** D1 rows and SQLite Durable Object values cap near 2 MB, while uploads default to 50 MiB. The plan's "D1 or DO" for the whole store was wrong; the docs and `UploadStore`'s comment say so.
- **A honey-built Worker passes its entry's named exports on** (h), so the Durable Object an upload store needs can be exported. Without it the production setup the docs recommend could not be built. `default` stays honey's fetch; a second default is refused. workerd refuses a module whose named export is a string, number, boolean or null, and one such export stops the whole Worker. The plugin sees names, not values, so such a value passes on as an inert empty object (9f5f413, found by a leg that loads a plain-value entry in workerd).
- **Deleting a Worker by name removes its own Durable Object namespaces.** A probe on the owner's account (wrangler 4.110, `wrangler delete --name`, no `--force`) left the account's namespace ids exactly as before. The live MCP leg relies on this, and its teardown asserts it rather than deleting a namespace itself.
- **The live leg's upload store is a Durable Object,** not memory: a memory store would make the leg's verdict depend on which isolate answered. `wrangler dev` runs one isolate, so cross-isolate one-shot is shown only live (`upload-raced`).
- **api-key-on-origin stays a LACKS row** with its exact reason (h); lifting it needs a change to the reference document, not to the emitters.
- **Every test or hook that spawns declares its bound** (`honey/spawn-timeout`): three spawning legs passed locally and timed out under vitest's defaults on slow CI runners. Core and gen each hold `SPAWN_TIMEOUT`, and a structure leg keeps the twins equal.
- **Open for the close:** whether the repo guards the Bun version (the owner's machine runs 1.4.4, CI pins 1.3.11; two Bun-only gaps surfaced this bit: `headersDistinct`, and jiti's `Error.prepareStackTrace` hook under Vite).
