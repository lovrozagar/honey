# Bit 11 — TypeScript SDK

Closes: C2 (raw response + per-call overrides) · A1/A2 (binary + typed headers)
Oracle kept green: `tests/integration/ts-harness`, the client behavior spec (ported from v0 `unit/client/*`).
Formatter post-pass: oxfmt (the repo's formatter and an optional peer of honey-clients; valid-but-unformatted fallback when absent). Runtime: vendored, depends on `fetch` (H9).

## Scope
The TS SDK emitter and its vendored runtime (split v0 `client/http.ts` 737, `client/sdk.ts` 351 into `gen/emit/ts/`). Reads only the IR.

**Client architecture (F1, recorded here — undocumented before bit 11).** One vendored runtime (`gen/runtime/ts/*`) with two thin typed fronts, both dispatching through a `Proxy` — no per-method emitted code:
- the **SDK front**, emitted from the IR alone: `serviceMap` data (method, path, stream/body kind, per-op error statuses, from `IR.tree` + sdk-model) plus types via `irToTs`, Proxy-dispatched over the service map;
- the **app-typed front** `createClient<typeof app>`, vendored into the app's `_gen` beside `routes.gen.ts`, a `Proxy` over HTTP **methods** with a typed path argument — v0's shape, unchanged (H4): `api.get("/users/:id", { params })`, `.post`/`.put`/`.patch`/`.delete`, `.$url`/`.$path`, `.ws`, `.$isClientError`. Its type surface declares `InferRoutes<T> = T extends { readonly $routes: infer R } ? R : never` **structurally in the template**, so the emitted `client.gen.ts` imports nothing from core — stronger than H2, no emitted `import type` either; the app's `$routes` phantom rides the consumer's `typeof app`. The SDK front's emitted files keep v0's `${stem}.{client,index,map,runtime,types}.gen.ts` naming (stem defaults to the kebab-cased SDK name — H4), so sibling SDKs coexist in one dir.
Core no longer ships `./client` — it moves to gen, vendored per-app, not a published runtime (H9, 03-surface MOVE→gen); the `./client` export row moves core→gen.

## Phase-b runtime contract (ruled)
The 586 phase-b reds (SDK emit + runtime) pin v0's `client/http.ts` behavior; where v0's two fronts disagree, the reds follow the **client** (the contract ports `client/http.ts`). The emitters read only the IR. Type checks in gen tests use **ts-morph's bundled TS (v6) in an in-memory project** — TS 7.0.2 ships no in-process compiler API (no `createProgram`); the emit-adversarial / extract precedent.

- **a.** SDK `invalidation: { staleTime, staleMaxEntries?, maxSourcesPerTarget? }` (v0 SDK). The hook ctx carries `isStale`/`invalidatedBy`/`selector` only when invalidation is on.
- **b.** SDK class exposes a public `state` and `dispose()` (aborts in-flight calls, rejects later ones) — both v0.
- **c.** `maxErrorMessageChars?` (default 512) on `ClientConfig`, both fronts (v0 SDK).
- **d.** Stream input `body`; a path-param or JSON-serialize failure resolves in safe mode as a status-0 `ClientError` on `Response.error()`. v0 crashed with a `RangeError` on the serialize case — **V0BUG-fixed** (crash → typed error).
- **e.** C2: per-call `raw: true` returns the unread `Response` (overload typed `Promise<Response>`); per-call `baseURL` applies to that call only.
- **f.** A1: binary bodies are `Uint8Array<ArrayBuffer>`, `Accept` set to the declared type; the stream is `(await call({ raw: true })).body`.
- **g.** A2: the safe result gains `headers` (declared headers only, case-insensitive). This needs **`IRResponse.headers`** — bit-09 `slots.ts responsesOf` drops them today; adding the slot + field is an **additive edit to closed bit 09** (H13), feeding every target, not just TS.
- **h.** `retry()` on the retry pass returns the current response, one retry per call (v0 `client/http.ts`). v0's SDK threw "Max 1 retry" — the losing front; the reds pin the client's rule.
- **i.** Two-fronts disagreements follow the client: a non-JSON error body keeps its text; an empty or invalid 2xx JSON body gives `null` or a 200 `ClientError`.
- **j.** `serviceMapOf` keys are the renamed members (`state_`); entry flags (sse/ws/realtime/invalidate/params) appear only when set (`gen/emit/ts/service-map.ts`).

### Rulings (R1–R3)
- **R1 — readableStream / structured request input (ported, additive core).** v0 pins 6 type cases where the client types a stream body or structured query/header input. Core records only `input` (the server's parsed `ctx.input`), which drops a `readableStream` json/form body and wraps query/header sources as string records — the client can't recover the schema. **Fix (not cut):** `RouteRecord`/`MergeRoute` gain a sibling `request: InferRequestMap<TSchemas>` (each source's schema **input** type, `readableStream` unwrapped); the template's `InputFor` reads `request`. Additive, type-only, to `routing/app-types.ts` (H13). Retiring the 6 would regress a v0 feature and break the A1 binary-request conformance row.
- **R2 — a42bc08c59 "printable and not thenable" (ported, not cut).** The case asserts two live behaviors on the client/SDK objects, independent of the `createSDK` factory (which v1 drops — the SDK front is the generated class, F1). **Printable:** the generated class and the app client carry a readable `Symbol.toStringTag` → `[object <SdkName>]`. **Not thenable:** the method `Proxy`'s get trap returns `undefined` for `then` (and other thenable probes) so `await client` can't mistake it for a promise — an essential guard for a Proxy dispatch. Both port to `sdk.class.test.ts` + `app-client.test.ts`.
- **R3 — ee7fbfbf7f void→null (type ports; runtime V0BUG-fixed, scoped).** The type case ports: a void (no-body) operation's method returns `Promise<null>`. v0's runtime contradicted the type by resolving an empty `ArrayBuffer`; v1 resolves **by the declared result type** — `null` for a void op (and empty/invalid JSON, per **i**), but `""` for a declared text body and empty bytes for a declared binary body. The null shortcut is scoped to no-declared-body / JSON, never a legitimately-empty typed body.

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
