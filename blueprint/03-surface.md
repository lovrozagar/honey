# 03 — Surface

Every public export of both packages, tagged **KEEP** (re-homed and split, behavior proven identical by the oracle), **MODIFY** (changed per a decision — gap id in brackets), **DELETE** (removed in v1), **ADD** (new in v1). Derived from v0's `packages/core/package.json` `exports` map plus the planned codegen entry points. A value `dx/` does not list does not exist; this table and `dx/` agree, and `dx/` wins a conflict.

## `@lovrozagar/honey` — entry points

| export | disposition | note |
| --- | --- | --- |
| `.` (`honey()`, `Honey`, `HoneyContext`, `HoneyCtx`, `defineErrors`, `HoneyError`, `createMiddleware`/`defineMiddleware`, `HoneyRes`/`createErrorResponse`, `mergeTree`, `detectRuntime`, `toFetchRequest`, the `Infer*`/meta types) | KEEP | the `Honey` class (~2,600 lines in v0) is split into route-model / finalize / dispatch / registration files under the limits; the public type stays |
| `./accepts` | KEEP | |
| `./body-limit` | KEEP | |
| `./build` | MODIFY [H15] | Deno build target removed |
| `./cli` | MOVE→gen [H3] | the generate CLI becomes `@lovrozagar/honey-codegen`'s; **removed from core** |
| `./client` | MOVE→gen [H3] | the TS SDK client; **removed from core** (→ `honey-codegen` TS emitter + runtime) |
| `./client/sdk` | MOVE→gen [H3] | **removed from core** (→ `honey-codegen` TS emitter) |
| `./codegen` | MOVE→gen [H3] | **removed from core** (→ `honey-codegen` `.` entry) |
| `./codegen-go-cli` | MOVE→gen [H3] | **removed from core** (→ `honey-codegen` CLI emitter) |
| `./codegen/extract` | MOVE→gen [H3] | **removed from core** (→ `honey-codegen` `extract/`) |
| `./cookie`, `./cookie-sign` | KEEP | |
| `./cors` | MODIFY [F1] | credential-reflection hardening kept under the adversarial gate |
| `./crypto` | KEEP | |
| `./csrf` | KEEP | |
| `./curl-logger`, `./request-to-curl` | KEEP | |
| `./errors` | MODIFY [A7] | opt-in RFC 9457 problem+json formatter added; honey-native default unchanged |
| `./etag` | MODIFY [A4] | `Last-Modified` / `If-Modified-Since` added beside ETag |
| `./i18n` | KEEP | |
| `./input` | MODIFY [A1] | `.input({ binary })` raw-body slot with declared content-type |
| `./ip-restrict` | KEEP | |
| `./logger` | KEEP | the only `console` owner |
| `./node` | KEEP | Node adapter |
| `./openapi`, `./openapi/scalar`, `./openapi/swagger` | MODIFY [B1,B2,B3] | configurable `servers` + variables, `tags`/`externalDocs`, `webhooks` |
| `./openapi/spec` | DELETE (bit 19 i) | v0's `spec()` handler is `serveOpenApi` on `./openapi` |
| `./plugin` | KEEP | |
| `./powered-by`, `./pretty-json`, `./server-timing`, `./request-id`, `./timeout` | KEEP | |
| `./proxy` | MODIFY [H15] | Deno branch removed |
| `./realtime` | MODIFY [H8] | SSE declared-schema typing + uniform reconnect; reference resume server ships |
| `./secure-headers` | KEEP | |
| `./serve` | MODIFY [H15] | Deno runtime removed; node/bun/cf detection kept |
| `./static` | MODIFY [A3] | Range / 206 / `Accept-Ranges` |
| `./telemetry/otel` | KEEP | |
| `./testing` | KEEP (bit 20 a) | `testClient`, with the types `TestClient`, `TestClientOptions` and `TestRequestOptions` (src/testing/testing.ts); v0's `transport: "node"` is `transport: "serve"` |
| `./trust` | DELETE [H23] | `trustProxy` is cut; `ctx.ip` is the platform peer |
| `./tree` | KEEP | |
| `./ws` | ADD (bit 19 i2) | `ws(app, path)` → the WS route builder, plus the types `WsRouteOf` and `AnyHoneyHandle`; replaces the `app.ws(path)` method, so an app that opens no socket bundles no WS route code |
| `./mcp` | ADD (bit 21 e) | `mcp(app, path, handler, options?)` → mounts a generated MCP handler (`_gen/mcp.gen.ts`) on `path` (POST; GET/DELETE 405) under the app's middleware, auth before dispatch, optional OAuth resource metadata; an app that serves no MCP bundles none of it |
| `./mcp/oauth` | ADD (bit 21 f) | `oauth(options)` (type `McpOAuthOptions`) → the opt-in OAuth 2.1 resource-server role for `mcp()`: RFC 9728 protected-resource metadata, 401 `Bearer resource_metadata` and 403 step-up challenges; no authorization server, no token validation; a mount without it carries none of it |
| `./ws/bun`, `./ws/cloudflare`, `./ws/node`, `./ws/session` | KEEP | |
| `./ws/deno` | DELETE [H15] | |

### Added to `@lovrozagar/honey`

| export | gap | note |
| --- | --- | --- |
| `./rate-limit` | A5 | `rateLimit()` middleware, pluggable store (memory default), `Retry-After` + `X-RateLimit-*` |
| `./compress` | A6 | optional `compress()` Accept-Encoding negotiation |
| `./cache-control` | A4 | `cacheControl` directive helper |
| `./range` | A3 | range helper for binary/stream bodies |
| response media types + headers | A1/A2 | surfaced through `./input`/`.output()` and the `.` response types, not a new entry |

## `@lovrozagar/honey-codegen` — entry points (ADD; moved from core per H3 + new)

| export | source | note |
| --- | --- | --- |
| `.` (generate from an `openapi.json` → artifacts) | new entry over moved `codegen*.ts` + IR | runnable against any OpenAPI 3.x, not only honey's |
| `./cli` | moved from core `./cli` | the `honey-codegen` generate CLI |
| TS SDK emitter | moved `client/`, `client/sdk`, `ts-type-emitter` | MODIFY [C2] uniform raw-response/overrides |
| Go SDK emitter | moved `client-go/`, `codegen-go`, `go-type-emitter` | MODIFY [C2] + formatter post-pass (gofmt mandatory); C1 auto-pagination CUT (H20) |
| Rust SDK emitter | moved `client-rust/`, `codegen-rust`, `rust-type-emitter` | MODIFY [C2] + rustfmt (mandatory); C1 CUT (H20); sync (blocking) client CUT (H20-style) |
| Python SDK emitter | moved `client-python/`, `codegen-python`, `python-type-emitter` | MODIFY [C2] + ruff/black mandatory; C1 CUT (H20) |
| **C#/.NET SDK emitter** | new | ADD [H5,H11] BCL-only, NuGet, net8.0→net10 |
| **Java SDK emitter** | new | ADD [H5,H11] HttpClient + Jackson, Maven Central, `--release 17` |
| Go CLI emitter | moved `cli-go/`, `codegen-go-cli` | MODIFY [E1] cf-grade: verb consistency, discovery, compact output, completion, skills bundle |
| MCP server emitter | moved `client-mcp/`, `codegen-mcp` | MODIFY [D1] `outputSchema` + `structuredContent`, tool annotations, binary results |
| type extraction (`./codegen/extract`) | moved `type-extractor` | KEEP approach [H12] ts-morph compiler API; split under limits; ts-morph optional peer |
| shared emit layer | moved `codegen-lang`, `codegen-sanitize`, `codegen-schema-naming`, `codegen-sdk-model`, `codegen-hash`, IR | MODIFY [F2] one shared fuzzed string-escape layer |

## Removed in v1

- `./ws/deno` and all Deno surface (H15).
- No per-language runtime package is published (H9); the runtime glue is vendored into each emitted SDK.

## Cross-check

Every public surface **area** has a `dx/` file (app-settings, routing, input-output, middleware, realtime, openapi, observability, proxy, static, cookies, i18n, crypto, plugin, client, codegen, cli, mcp) and every row maps to `files.tsv` rows. Small helper exports are documented inside their area file, not a standalone one: `./accepts` under input-output, `./curl-logger`/`./request-to-curl`/`./server-timing`/`./powered-by`/`./pretty-json`/`./timeout` under middleware/observability, `./request-id` under middleware, `./tree`/`./testing` under routing/testing. The bit-20 `dx-coverage` gate asserts every public export resolves to a documenting `dx/` row and every `dx/` test pointer resolves to a real home. The verify step (plan 9.5) asserts this table tags every export, that Deno surface is DELETE with no orphaned references, and that each SDK emitter row names its SSE+WS+reconnect parity tests and its formatter post-pass.
