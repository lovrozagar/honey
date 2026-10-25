# Bit 20 — docs

Closes: — (documents every v1 capability so none drifts back to undocumented surface, the way the v0 gif path did)
Oracle kept green: the docs build; `dx/` cross-check.

## Scope
Every public value in `dx/` has user-facing docs, and every new capability (open media types + headers, range, cache-control, rate-limit, compress, problem+json, webhooks, realtime resume, C#/Java SDKs, the cf-grade CLI, MCP structured output) is documented with an example and its test reference. The OpenAPI human docs (scalar/swagger) and the agent skills bundle (bit 17) are part of docs.

Per-SDK usage recipes are documented here, including: **Rust sync use via a tokio `Runtime` + `block_on`** — the async-only Rust SDK's blocking recipe, which the bit-13 sync-client CUT (H20-style) promises. The `examples/rust/example.rs` compile check lives here (reassigned from bit 19: it is docs-examples-compile, not release), alongside the other `examples/*/example.*` ports in `docs/examples-compile.test.ts`.

## Files (from files.tsv — `testing`, docs)
- `src/testing/testing.ts` (+test) — the public testing helper used by consumer docs examples.
- docs site sources + per-capability pages (one page per `dx/` area).

## Tests (named, written first)
- `docs/dx-coverage.test.ts` — every `dx/` value appears in a docs page (no undocumented public value), **and every `dx/` test reference resolves to a real `files.tsv` sibling or a named integration/telemetry/e2e suite** (a dangling dx pointer fails the build — closes the round-2 grading finding).
- `docs/examples-compile.test.ts` — every docs code example compiles/runs (ported from v0 examples-compile).
- `docs/new-capability.test.ts` — each v1-added capability has a page + an example + a named test.

**Bit 17 carry-in.** The generated CLI module ships no README (its docs are `--help`, `commands`, `schema` and the embedded SKILL.md). Document how an API author writes the module's README and points it at the install one-liner and the release flow.

**Bit 19 carry-in: the 1.0 migration notes.** Document each deliberate break from v0 0.7.x:
- The `@lovrozagar/honey/codegen` export goes: its SDK, CLI and MCP generators move to `@lovrozagar/honey-codegen` (the `honey-codegen generate` bin and its module API). Only v0's document-level `mergeSpecs` and `scopeSpec` (merging or cutting finished OpenAPI files) are removed (bit 19 Q5). Several honey services still combine into one source of truth through `mergeTree` over their route trees, and one merged tree still emits several documents (`codegen.openApi` outputs, each with its own securitySchemes and `filterRoutes`), as Anyrow's gateway does. Merging a third-party document is a post-1.0 IR feature.
- `--app` takes a module that exports the app and binds nothing (bit 19 Q3); v0's no-bind flag has no v1 counterpart because v1 never serves implicitly.
- The TS SDK's realtime connection options `token?` and `onAuthExpired?` are removed (bit 19 Q8 and b2; neither was ever read): `headers` may be a function read on every dial, and the client-level `onAuthExpired` is the one refresh hook.
- The TS SDK reads the spec's security scheme for its auth header (bit 19 b3), as every other SDK does: an apiKey scheme's header with no prefix, bearer as `Authorization: Bearer`. A caller's `authHeaderName` alone no longer implies `Bearer `; set `authHeaderPrefix` to keep one.
- WebSocket keepalive is on by default in every SDK (bit 19 d1): a ping every 20 s, the connection ended when a pong does not come within the interval. New config: Go `Config.WSKeepalive` and `TransportOpts.KeepAlive`, Rust `ws_keepalive`, Python `ws_keepalive`; the bare TS `createResumableConnection`'s `keepaliveInterval` now defaults to 20 s (0 turns it off), while the SDK-built realtime connection defaults to 0 because a browser WebSocket has no control ping (bit 19 e2); `keepaliveOf` is exported.
- A realtime connection's open is terminal when every transport refused it (400, 401 after the one refresh, 403, 404, 405, 410, 422), with the most specific refusal as the error (bit 19 e); a transient failure (408, 429, 5xx, transport) still backs off. A refused WebSocket upgrade still falls through to SSE and long-poll.
- A 401 on any realtime transport refreshes the token once per open through the client's one auth hook, and the chain restarts from its first transport. Rust adapters gain `Transport::refresh`, Python adapters `refresh()`. The TS `RealtimeAuthError` export is removed (never thrown).
- A TS realtime operation returns a `ResumableConnection<T>` over WebSocket → SSE → long-poll, built by the SDK, whatever its ws or sse extension (bit 19 e2); a non-realtime ws or sse operation still returns its socket or async iterable. The TS WebSocket dial carries no credential (the platform cannot send headers), so a server that requires auth on the upgrade gets TS clients on SSE or long-poll; tokens never go in the URL.
- `ResumableConnection` is generic over its payload, its `send` returns `Promise<void>`, and `RealtimeOptions` is exported (bit 19 e2).
- `ResumableConnectionOpts.lastId: number` becomes `lastEventId: string`, matching SSE ids and every other SDK's cursor (bit 19 e2).
- A realtime connection sends raw text in every SDK (bit 19 f): Rust gains `send_text`, TS `ResumableConnection.sendText` (a text frame on WebSocket, a `text/plain` POST over SSE and long-poll); `send` still JSON-encodes.
- A TS SDK network failure is `APIConnectionError` (its `cause` the platform error), not a raw `TypeError`, and safe mode throws it like every SDK, since no answer exists (bit 19 f2); an abort or timeout keeps its own error.
- The MCP server takes `$<PREFIX>_HEADERS` (a JSON object of string values, validated at start and scrubbed from every result) and `$<PREFIX>_REDIRECT=same-origin|follow` (default same-origin) (bit 19 g).
- A WebSocket route's `.meta()` refuses `deprecated`, `security`, `invalidate` and `mcp` at the type level, where the build dropped them silently (bit 19 g).
- Generated SDK error messages read `HTTP <status>: <message>` (or `HTTP <status>` with no message) in every target (bit 19 d2): Go and Rust drop the reason phrase (they printed `404 Not Found: <message>`), and TS adds the prefix (it printed the message alone). Code matching on the old text changes; match the typed error and its status instead.
- The TS SDK's SSE caps are UTF-8 bytes like every other SDK's (bit 19 d2): `sseMaxBufferChars` is replaced by `sseMaxLineBytes` (1 MiB) and `sseMaxEventBytes` (8 MiB).
- The TS SDK speaks whatever HTTP version its platform's `fetch` negotiates (Node 26 may use HTTP/2; browsers choose their own); every other SDK is pinned to HTTP/1.1 (bit 19 d2).

## Security corpus
- none (docs); examples must not demonstrate an insecure default.

## Budget
- token: the agent-facing docs/skills bundle is measured against the token budget (H6).
