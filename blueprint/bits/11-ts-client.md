# Bit 11 — TypeScript SDK

Closes: C2 (raw response + per-call overrides) · A1/A2 (binary + typed headers)
Oracle kept green: `tests/integration/ts-harness`, the client behavior spec (ported from v0 `unit/client/*`).
Formatter post-pass: oxfmt (the repo's formatter and an optional peer of honey-codegen; valid-but-unformatted fallback when absent). Runtime: vendored, depends on `fetch` (H9).

## Scope
The TS SDK emitter and its vendored runtime (split v0 `client/http.ts` 737, `client/sdk.ts` 351 into `gen/emit/ts/`). Reads only the IR.

**Client architecture (F1, recorded here — undocumented before bit 11).** One vendored runtime (`gen/runtime/ts/*`) with two thin typed fronts, both dispatching through a `Proxy` — no per-method emitted code:
- the **SDK front**, emitted from the IR alone: `serviceMap` data (method, path, stream/body kind, per-op error statuses, from `IR.tree` + sdk-model) plus types via `irToTs`, Proxy-dispatched over the service map;
- the **app-typed front** `createClient<typeof app>`, vendored into the app's `_gen` beside `routes.gen.ts`, a `Proxy` over HTTP **methods** with a typed path argument — v0's shape, unchanged (H4): `api.get("/users/:id", { params })`, `.post`/`.put`/`.patch`/`.delete`, `.$url`/`.$path`, `.ws`, `.$isClientError`. Its type surface declares `InferRoutes<T> = T extends { readonly $routes: infer R } ? R : never` **structurally in the template**, so the emitted `client.gen.ts` imports nothing from core — stronger than H2, no emitted `import type` either; the app's `$routes` phantom rides the consumer's `typeof app`. The SDK front's emitted files keep v0's `${stem}.{client,index,map,runtime,types}.gen.ts` naming (stem defaults to the kebab-cased SDK name — H4), so sibling SDKs coexist in one dir.
Core no longer ships `./client` — it moves to gen, vendored per-app, not a published runtime (H9, 03-surface MOVE→gen); the `./client` export row moves core→gen.

## Files (from files.tsv — `gen/emit/ts`)
- `gen/emit/ts/{sdk,http,path,types,error,defaults,redirect-policy,sse,ws}.ts` (+test each) + `gen/emit/ts/index.ts`.
- `gen/runtime/ts/*` — the vendored fetch runtime template.
- **route-tree serializer obligation (from bit 10 / F17).** `gen/emit/ts/route-tree.ts` (`generateRouteTree`) must write `RouteEntry.es` (`Record<errorKey, StatusKey>`, additive, ROUTE_TREE_VERSION stays 2) alongside `bek`/`ek`/`mt` (and `i`). It is written at snapshot time from the resolving error factory via `ERROR_META`, so it carries a delegated leaf's downstream error statuses across the data-only gateway tree; dropping it regresses the gateway document's downstream error responses to suffix-inference-or-unknown. **The emitted tree never writes `iv`/`out`** — those hold live validator objects in the snapshot, not serializable data, and v0 pins never-emitting them (5eb9c55499 + siblings; F2/Q1).

## Tests (named, written first)
- `gen/emit/ts/sdk.test.ts` — operations typed from IR; status-keyed results narrow.
- `gen/emit/ts/overrides.test.ts` — per-call base/timeout/headers; raw-response accessor (C2).
- `gen/emit/ts/sse.test.ts` + `gen/emit/ts/ws.test.ts` — typed SSE events; WebSocket; `Last-Event-ID` reconnect against the reference server (H8 parity).
- `gen/emit/ts/binary.test.ts` — binary response → `Uint8Array`/stream; `Accept` set; typed response headers (A1/A2).
- `gen/emit/ts/format.test.ts` — output is oxfmt-clean.
- establishes the **conformance matrix** infra (`dx/conformance.md`): `tests/integration/conformance/{app,matrix}.ts` (the reference app exposing every feature + the feature×target grid) and `conformance/ts.test.ts` — the TS client drives the shared scenarios against the live reference server; bits 12–18 add their target's runner against the same grid.

## Security corpus
- the shared string-escape layer (F2); auth header never logged.

## Budget
- token: per-operation SDK + help size within the budget.
