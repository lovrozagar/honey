# Bit 01 — core route model

Closes: A8 (decision only) · splits v0 `index.ts` 3,829 + `tree.ts` 558 + `types.ts` 756 (the route-model half; the request-execution half splits at bit 02)
Oracle kept green: `tests/integration/routing.test.ts`, the ws1-route-model regression, the typetests.

## Scope
The **pure route model** — the side-effect-free routing data structures, with no request execution: pattern compile+match, the route tree + `mergeTree`, `matchRoute`, `RouteRecord`, request-path canonicalization/strip-prefix, the `RouteBuilder` up to `.handler()`, per-method registration, app settings/defaults, invalidation meta, and the route-level types. Types move to `src/routing/types.ts` (kind=types, split under the limit).

**Re-cut by dependency (ruled from the implementer's bit-01 sequencing report).** Request execution — `app.ts` (`honey()`), `dispatch.ts`, `finalize.ts` (the `FinalTable`), `middleware-chain.ts`, `invoke-user.ts` — **moved to bit 02**: they can't be built or tested without the request context + middleware (bit 02) and the response/error core (moved 08→02), and v1 can't import `_v0` (`honey/boundaries`), so a stand-in would be a forbidden placeholder. Bit 01 is everything that stands alone and is unit-testable with no `app.fetch`. The v0 cases classified `01-core-route-model` that assert through `app.fetch`/`c.res`/`createMiddleware` are reassigned to their real feature (02, 08, or a gen bit) in `v0-cases.json` with a per-id reason, as part of this bit.

Decide A8 (typed/constrained path params in the grammar) — **not now**: `.input({ params })` validates values already; constrained params (`:id(\d+)`) buy only match-time disambiguation (numeric-vs-slug) at a real match-path cost. Decision recorded; stays a bit-01 (route-grammar) call.

**Re-cut part 2 (one layer up, same dependency).** `route-builder.ts`, `register.ts`, `settings.ts` **moved to bit 02** with `app.ts`: v0's `RouteBuilder` (`index.ts:3214`) is 17 type-parameters whose every method returns `BuilderChain<…>` and whose `.handler()` returns `HandlerReturn<…> = Honey<…>` — the app type. The builder's whole value is that typed DX, so it can't be typed honestly without `app.ts`; `register.ts`'s observable cases (dangling builder, mount, duplicate) assert through `app.get(...)`; `settings.ts` is the app's settings object. A builder generic over a placeholder app would change its public type shape twice — a placeholder by another name. The `Infer*` ladder + `HoneyCtx` (they read the app's phantom `$routes`/`$ctx`/`$meta`) also move to bit 02. Bit 01 keeps only what stands alone and is unit-testable with no `app.fetch`.

## Files (from files.tsv — `routing` folder)
- `src/routing/match.ts` (+test), `src/routing/record.ts` (+test) — `matchRoute`, `RouteRecord` + leaf types.
- `src/routing/tree.ts` (+test), `src/routing/tree-merge.ts` (+test) — the route tree + `mergeTree`.
- `src/routing/pattern.ts` (+test), `src/routing/request-path.ts` (+test), `src/routing/invalidate-check.ts` (+test).
- `src/routing/types.ts` (kind=types) — **route-level types only**: `HttpMethod`, `ParamKeys`/`ParamsFromPath`, `MergePath`, `PrefixRoutes` (no app reference; the `Infer*` ladder + `HoneyCtx` are bit 02).

## Tests (named, written first)
- `routing/pattern.test.ts` — named params, trailing slash, catch-all, stale-tree marking.
- `routing/tree.test.ts` / `routing/match.test.ts` — tree insert/lookup, method/path resolution, backtracking.
- `routing/tree-merge.test.ts` — `mergeTree` sub-app mount at a prefix.
- `routing/request-path.test.ts` — canonicalization, strip-prefix, trailing slash.
- `routing/invalidate-check.test.ts` — the missing-invalidate report (v1 returns the report; only `telemetry/logger.ts` owns `console`).
- `tests/types/route-model.typetest.ts` — `ParamKeys`/`ParamsFromPath`, `MergePath`, `PrefixRoutes` (ported from v0 `param-types` + `basepath-types`). (The app-level infer-ladder typetest is bit 02.)

(Builder/register/settings and dispatch/finalize/`onRequest`-pairing tests move to bit 02 with the modules they exercise.)

## Perf
Bit 01 has no `app.fetch` path, so the 11-scenario hot-path gate does not run here — it activates at **bit 02** when `dispatch`/`app`/response land (the `match+dispatch` ratio and all dispatch-level targets — nested-static map, precomputed 404, telemetry-gated `performance.now()`, lazy URL, monomorphic dispatch — move to bit 02). Bit 01's only perf concern is the pure match/tree cost; a `match`-only microbench may guard it, but there is no v0-ratio gate until dispatch exists.

## Security corpus
- path-normalization scope-bypass cases in the adversarial suite (`//`, `..`, encoded separators) — a canonicalized path must not escape its mount (asserted at the `request-path`/`match` level here; the full `app.fetch` bypass cases join at bit 02).

## Budget
- perf: n/a at the `app.fetch` level (gate activates bit 02); pure match/tree cost only.
- token: n/a.
