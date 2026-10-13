# 02 — System

What the running system does, in order, and who owns each part. Verified against `packages/core/src` on v0; v1 keeps the behavior and splits the owners into files under the limits. The last section is the core→codegen seam (the IR).

## Request lifecycle, in order

A honey app is a `fetch(request, env, ctx)` handler. An adapter delivers the request; the pipeline below runs; a `Response` leaves. The pipeline is compiled once at **finalize** into a `FinalTable` and re-run only when registrations change.

1. **Ingress / adapter** — `adapters/{node,bun,workers}` deliver a standard `Request` and the runtime's `env`/`ctx`. Node bridges `node:http` (`node-request.ts`); Bun and Workers pass Fetch natively. `detect-runtime.ts` returns a pure runtime value; no portable-core file branches on globals. *Deno is removed in v1 (H15).*
2. **Trust / proxy** — `trust.ts` resolves the effective client IP and protocol from `X-Forwarded-*` only as far as the configured `trustProxy` allows; `ip.ts` / `ip-restrict.ts` apply IP policy. Owner of "who is the client".
3. **`onRequest` telemetry** — fires exactly once per request; every later exit (redirect, 426, upgrade, miss, preflight, handler, error) pairs with exactly one `onResponse`/`onError`.
4. **Route match** — `pattern.ts` compiles path patterns; `tree.ts` + `matchRoute` resolve method + path to a record, or a catch-all, or a miss. Trailing-slash and prefix handling (`request-path.ts`, `strip-prefix`) run here.
5. **Finalize** — `_finalize()` builds the `FinalTable`: resolved records, the loaded tree, WS plans, and the middleware chain, each wrapped once for telemetry. A builder still waiting for `.handler()`, or a `use()` that never registered a route, is reported here.
6. **Middleware chain** — `middleware.ts` runs `use(mw)` handlers in order, each able to short-circuit. The security/edge middlewares (cors, secure-headers, csrf, rate-limit, compress, request-id, server-timing, timeout, body-limit, powered-by) are composable middleware, not hidden steps.
7. **Input validation** — `validation.ts` asserts the request content-type, enforces body limits (`body-limit.ts`, `body-kind.ts`, `request-limits.ts`), and runs `validateInput` against the standard-schema. The request binary slot (H10) is validated here as bytes with a declared content-type.
8. **Handler** — `invoke-user.ts` calls the user handler with the `HoneyContext` (`context.ts`): typed input, cookies (`cookie.ts` / `cookie-sign.ts`), headers, the response builder.
9. **Output / response finalize** — `response.ts` / `honey-response.ts` build the `Response` from `HoneyRes` helpers (`json`, `text`, `html`, `sse`, `binary`, `raw`, redirect). v1 opens the media-type set and carries declared response headers (H10). `media-type.ts` negotiates `Accept`; `etag.ts` adds conditional 304 (and, v1, `Last-Modified`); `with-headers.ts` applies declared headers.
10. **Streaming** — `producer-stream.ts` drives Web-Streams bodies; `sse` emits `text/event-stream` with the declared event schema (v1 types it). Range/206 (v1, A3) plugs in here and in `static.ts`.
11. **Errors** — `error.ts` / `errors.ts` define `HoneyError`, `defineErrors`, and the error projector that turns any thrown value into a response. `onError` runs, then error telemetry. v1 adds the opt-in problem+json formatter (A7); the honey-native error-key JSON stays the default.

## Realtime and WebSocket

- **Upgrade** — a WS route matches via its own plan in the `FinalTable`; the adapter performs the 101 upgrade. `ws/{node,bun,cloudflare}.ts` are the per-runtime adapters (Deno removed); `ws/shared.ts` and `ws/session.ts` hold the runtime-agnostic session logic.
- **SSE + resume** — `realtime/{bus,route,server}.ts` back the resume client; `Last-Event-ID` resume is opt-in via `.meta({ extensions: { "x-realtime": true } })`. v1 (H8) makes reconnect parity uniform across SDKs and ships a reference resume server as the conformance target.

## OpenAPI + the IR seam (core → codegen)

Core owns description; codegen owns generation. The boundary is the IR.

1. **Collect** — `openapi/collect.ts` walks the finalized routes and their meta (`meta-spec.ts`, `meta-spec-merge.ts`) into operation records. `.meta({ extensions: { "x-*": … } })` is the escape hatch that reaches operation extensions (`x-realtime`, `x-websocket`, `x-mcp`).
2. **IR** — `codegen-ir.ts` (moving to `packages/gen`) builds the intermediate representation: resource tree from dotted operationIds, request/response slots with their declared schemas and content-types, realtime/SSE/WS markers. Every emitter reads only the IR.
3. **Document** — `openapi/document.ts` + `spec-factory.ts` emit the OpenAPI 3.1 document (servers, tags, webhooks in v1 — B1–B3); `openapi/{scalar,swagger,docs-page,serve}.ts` serve human docs.
4. **Emit** — `packages/gen` consumes the IR and emits: TS/Go/Rust/Python/C#/Java SDKs (vendored runtime glue, H9), the Go CLI (H E1), and the MCP server (H D1). Type extraction (`type-extractor.ts`) uses the TS compiler API (H12); code emission uses structured strings + the `codegen-lang` sanitizer + the formatter post-pass.

## Ownership summary

| concern | owner (v0 → v1 split happens in the named bit) | bit |
| --- | --- | --- |
| ingress / adapters | `adapters/{node,bun,workers}`, `detect-runtime`, `node-request` | 03/04 |
| trust / client identity | `trust`, `ip`, `ip-restrict` | 03 |
| route model | `pattern`, `tree`, `request-path`, finalize | 01 |
| middleware + edge security | `middleware`, `cors`, `secure-headers`, `csrf`, `rate-limit`*, `compress`*, `request-id`, `server-timing`, `timeout`, `body-limit`, `powered-by` | 02/07 |
| input / output / response | `validation`, `input`, `response`, `honey-response`, `media-type`, `etag`, `with-headers`, `cacheControl`*, `range`* | 08 |
| streaming | `producer-stream`, `sse` | 05 |
| realtime / ws | `realtime/*`, `ws/*` | 06 |
| errors | `error`, `errors`, problem+json* | 08 |
| schema conversion (standard-schema → JSON Schema, feeds the IR) | `schema/*` (zod/valibot/arktype/yup/effect converters, slots/hoist/dedup, canonicalize, resolve-refs, sanitize-spec) | 09 |
| description | `openapi/*` (collect, generate, manifest, extract-schemas, document), `meta-spec*` | 09/10 |
| generation | `packages/gen` (IR, emitters, CLI, MCP, type-extractor) | 09–18 |

`*` = new in v1.
