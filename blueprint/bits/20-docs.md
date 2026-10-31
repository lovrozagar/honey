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
- The `@lovrozagar/honey/codegen` export goes: its SDK, CLI and MCP generators move to `@lovrozagar/honey-clients` (the `honey-clients generate` bin and its module API). Only v0's document-level `mergeSpecs` and `scopeSpec` (merging or cutting finished OpenAPI files) are removed (bit 19 Q5). Several honey services still combine into one source of truth through `mergeTree` over their route trees, and one merged tree still emits several documents (`codegen.openApi` outputs, each with its own securitySchemes and `filterRoutes`), as Anyrow's gateway does. Merging a third-party document is a post-1.0 IR feature.
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
- `honey()`'s `codegen.sdk` and `codegen.cli` are removed (bit 19 h2, Q1): the plugin writes the app's own artifacts (route tree, manifest, OpenAPI JSON/YAML, types), and `honey-clients generate --app <module>` writes the SDKs, the CLI and MCP. Passing either key is an error naming that command.
- A gateway config (`app` plus `codegen.mergeTree`, Anyrow's shape) works unchanged (bit 19 h2). The tree written is the services' merged routes plus the gateway's own, and the documents, manifest and types come from the served `app` (its errors and metaSpec included) with the services' schemas. A first run bootstraps the merged tree.
- A gateway that adds an own route its generated tree lacks can't be imported over that tree: export the gateway's app, built without its tree, from the merge entry as `app`, and generation builds the tree from it before importing the served app (bit 19 h2). A non-gateway app that loads its own generated tree generates from an entry that builds it without that tree; v0's codegen-process tolerance has no v1 counterpart (Q3). The error names both fixes.
- `honey()` transforms no module (bit 19 h2, Q4): v0 injected feature entries into the build; each feature is now a plain import.
- `@lovrozagar/honey/trust` and `trustProxy` are cut (H23): `ctx.ip` is the platform peer (`CF-Connecting-IP` on Workers, the socket on Node and Bun), never an `X-Forwarded-*` value. Behind your own proxy, read the header your proxy sets in your own code.
- `@lovrozagar/honey/openapi/spec` is removed (bit 19 i): v0's `spec()` handler is `serveOpenApi` from `@lovrozagar/honey/openapi`, which mounts the JSON and YAML documents (and a docs page with `docs`) rather than returning a handler.
- `app.ws(path)` becomes `ws(app, path)`, with `import { ws } from "@lovrozagar/honey/ws"` (bit 19 i2), the same shape as `realtime(app, path)`; it takes any handle `.ws()` was a method of (the app, a `.prefix()` base, a scoped chain) and types the route exactly as before. The method is gone so that an app that opens no socket bundles no WebSocket route code (about 1.1 KB gzipped).
- `testClient` comes from `@lovrozagar/honey/testing` (bit 20 a), and its `transport: "node"` is `transport: "serve"`: it serves the app over real HTTP through `serve(app)`, so this runtime's own adapter answers (Node's on Node, Bun's on Bun). Its `app` takes any `{ fetch }` app; the cookie jar is v0's (name → value, no path or domain scoping).
- `@lovrozagar/honey` and `@lovrozagar/honey-clients` require Node 22.12 or later (bit 20 d; v0 said 20): core uses `Promise.withResolvers`, and CI's oldest Node is 22.12.0.
- `app.serve(...)` is removed (bit 19 j1): `import { serve } from "@lovrozagar/honey/serve"`, then `await serve(app, { hostname, port })`.
- An installed `@lovrozagar/honey` and `@lovrozagar/honey-clients` run their compiled `dist/` on every runtime, Bun included (bit 19 i); v0's `bun` export condition to the TypeScript source is gone.

**Bit 19 i docs note (the generated CLI's release flow):** the emitted release workflow signs `checksums.txt` keyless with cosign (`checksums.txt.sigstore.json`) and attests it, and `install.sh`/`install.ps1` verify that bundle against the repo's release workflow when `cosign` is on PATH; `<PREFIX>_INSTALL_VERIFY=require` refuses to install without that check. A CLI generated without `--repo` installs by sha256 alone. The flow assumes a public repository: an anonymous one-liner cannot fetch a private repo's release assets, and attestations need a public repo or a paid plan.
The commands, as the installers run them (document them for a user verifying by hand):
- the checksums: `cosign verify-blob --bundle checksums.txt.sigstore.json --certificate-identity-regexp '(?i)^https://github\.com/<owner>/<repo>/\.github/workflows/release\.yml@refs/tags/v' --certificate-oidc-issuer https://token.actions.githubusercontent.com checksums.txt`;
- an archive's build provenance: `gh attestation verify <archive> --repo <owner>/<repo>`.

**Bit 19 i2/j docs notes:** the README's `app.realtime("/rt", …)` block is stale (v1 has `realtime(app, path)`), fixed in this bit's docs pass; the e2e apps, the README and the bench were moved to `ws(app, path)` at the cutover.

**Bit 19 h2 docs note (not a break, v0 parity):** a gateway's runtime `serveOpenApi` document has no service request or response bodies, because a generated tree carries no schemas. A gateway serves its generated document asset instead, as Anyrow does.

## Security corpus
- none (docs); examples must not demonstrate an insecure default.

## Budget
- token: the agent-facing docs/skills bundle is measured against the token budget (H6).

## Shipped (the bit 20 close)

Closed at f, on e3's e92e73d; the closing CI run is this stack's push, after the bench ceilings were re-derived from 11 or more CI samples (e3's first blocking run, 40645792418, reded websockets message-10k at 4.36 over a 4.114 ceiling drawn from 6). Each phase landed red-first, with one verify on its pushed tip:

- **a** cc5e731: `testClient` at `@lovrozagar/honey/testing`, all 43 v0 testClient cases ported; `transport: "serve"` (real HTTP through `serve(app)`, this runtime's adapter) replaces v0's `"node"`; v0's unscoped cookie jar kept. 76aa619: the SSE-over-upgrade leg's producer yields per send (a microtask-only producer starved the first flush past 5 s under coverage); 9f8ffd2: a never-yielding SSE producer is held under 16 MB by backpressure over node:http.
- **b** ce1f747: dx-coverage's pointer half; 13 dangling dx/ test pointers fixed (the research counted 9).
- **c, c2** cb4c0e0, 049855f: docs/: 18 area pages, 11 capability pages, migration, streaming, testing, the CLI release flow, the SDK recipes (Rust's `block_on` included); one example program per language compiled against the SDK generated from kitchen's document, each page's SDK block a verbatim slice of it; dx-coverage's docs half, new-capability and examples-compile; per-operation doc comments in the TS and Java SDKs, so all six carry them (gen-api-ref retired on them).
- **d** bfb20f8, 0eed73e, ab42a96: the npm READMEs (core new, gen rewritten), the root README as an 89-line front page, packages/core/docs/packaging.md, docs/packages.md; readmes.test; engines.node `>=22.12.0` (Node 20 lacks `Promise.withResolvers`).
- **e** 4f376bb, 1bde177, 502dbd9: `_v0`'s 23 dependents cut (each red-checked with `_v0` moved aside), then `git rm -r _v0` alone (698 files), then what held only while it existed; v0 lives at 1a968f1, and v0-cases.json, tokens.json and hotpath.json are frozen as its records.
- **e2, e3**: the finalize, adapter, streaming and websockets benches rebuilt as v1-to-raw-twin ratios (they had compared v1 with v0 live), with hotpath joining; baselines recorded on CI (blueprint/baselines/bench.json: median of 6 green runs, ceiling the worst × 1.10, each scenario's sensitivity stated), one run and no retry, a slowed mutant per scenario red; adapter post-1kib is report-only (bimodal on CI: 2 runs ~2.4, 4 at 3.85–4.7, ~+110% blind in its fast mode). hotpath had gated nothing in CI before e3 (its only baseline was Bun 1.4; CI pins 1.3.11).
- **f**: COMPLETE = 20, every v0 case ported or retired with its reason.

**Decisions:** docs are markdown under docs/ (a site deploy is the owner's call after 1.0); no agent bundle beyond the measured SKILL.md (tokens.json stays v0-derived by design); per-target READMEs are not a generated artifact.

**Open at close:** ~~j3 (cf prod) waits for the repository's Cloudflare secrets~~ done after the close: the live leg ran on the owner's account at 4e505e0, all 5 apps as `honey-e2e-<app>` Workers (103 passed, 1 skipped), each torn down by exact name; the first `@lovrozagar/honey-clients` npm publish and the trusted-publisher entries are the owner's; deploying docs/ as a site is the owner's call; the R5 Anyrow note awaits the owner's approval.
