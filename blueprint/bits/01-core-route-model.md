# Bit 01 — core route model

Closes: A8 (decision only) · splits v0 `index.ts` 3,829 + `tree.ts` 558 + `types.ts` 756
Oracle kept green: `tests/integration/routing.test.ts`, the ws1-route-model regression, the typetests.

## Scope
Split the v0 `Honey` class (~2,600 lines) and the route tree into `src/routing/`: route model, pattern matching, tree, request-path/canonicalization, finalize (the `FinalTable`), dispatch, registration. Types move to `src/routing/types.ts` (kind=types, split under the limit). Decide A8 (typed/constrained path params) — recommended **not** now; input validation covers values.

## Files (from files.tsv — `routing` folder)
- `src/routing/route-builder.ts` (+test) — the builder up to `.handler()`.
- `src/routing/finalize.ts` (+test) — compile the `FinalTable` once; report dangling builders / unused `use()`.
- `src/routing/dispatch.ts` (+test) — match → middleware → validate → handler → finalize response.
- `src/routing/pattern.ts` (+test), `src/routing/tree.ts` (+test), `src/routing/request-path.ts` (+test), `src/routing/invoke-user.ts` (+test), `src/routing/invalidate-check.ts` (+test).
- `src/routing/types.ts` (kind=types) — the `Infer*`/record types split from v0 `types.ts`.

## Tests (named, written first)
- `routing/route-builder.test.ts` — registration per method, dangling-builder report, `mergeTree` mount.
- `routing/pattern.test.ts` — named params, trailing slash, catch-all, stale-tree marking.
- `routing/finalize.test.ts` — finalize runs once; re-runs when registrations move.
- `routing/dispatch.test.ts` — `onRequest` fires once; every exit pairs one `onResponse`/`onError`.
- `tests/types/*.typetest.ts` — the infer ladder, params→input, verbs→client (ported from v0 typetest).

## Perf (v1 improvements — from the blueprint audit; targets, not just no-regression)
- Static lookup as a nested map `statics[method]?.[path]` instead of building `` `${method} ${path}` `` (and a second `` `GET ${path}` `` for HEAD) per request (v0 `index.ts:2574` — on the hottest path).
- Precompute the default 404 Response at finalize when the miss chain is empty and telemetry is off (v0 `_handleMiss` builds a full ctx + runs the miss plan — `index.ts:2749`; worst ratio 12.49×).
- Gate `performance.now()` at dispatch start on `telemetry !== null` (v0 `index.ts:2501` runs it unconditionally though the default is telemetry off — H17 "cost nothing unconfigured").
- Avoid the per-request throwaway: the `getUrl` closure built even for routes that never parse the URL (`index.ts:2508`), the discarded ctx-options literal (`index.ts:2659`), the second `ContextRes` alloc (`context.ts:211`) — pass positionally, parse URL lazily.
- Keep dispatch monomorphic: the split into `routing/{dispatch,match,middleware-chain,...}` must not introduce megamorphic call sites — keep one ctx shape and resist over-splitting the dispatch spine; the `mw-stack`/`many-routes` bench scenarios guard it.

## Security corpus
- path-normalization scope-bypass cases in the adversarial suite (`//`, `..`, encoded separators) — a match must not escape its mount.

## Budget
- perf: the hot-path match+dispatch benchmark ratio vs v0 within threshold (bit defines the ratio).
- token: n/a.
