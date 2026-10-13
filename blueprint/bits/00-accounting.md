# Bit 00 — accounting

Closes: F1 (gate setup) · Deno purge (H15) · test reorg (H13) · `_v0` + cutover scaffolding (H21)
Oracle kept green: the whole v0 suite runs through `_v0` (every subpath still points into `_v0/src`); this bit moves files and turns on gates, it changes no behavior.

The first construction act. No feature code changes, **no gen split** (that is bits 09–18, H3): v0 is parked in `_v0`, every `package.json` subpath points into `_v0/src`, and the v1 folder skeleton + gates are created empty.

## Scope
- **Park v0 in `_v0` (H21):** `git mv` `packages/core/src` → `packages/core/_v0/src` and `packages/core/tests` → `packages/core/_v0/tests` (one root over both — preserves all ~1,068 `../../src/…` relative imports). Point every `package.json` subpath at `_v0/src`. `_v0/**` is outside the `src/**` coverage/tree/lint globs and the published `files`.
- **Create the v1 skeleton** from `04-tree.md`/`files.tsv`: the empty `packages/core/src/**` folders and `packages/gen` skeleton **only** (manifest, tsconfig, vitest, `_tokenizer/`, the oxlint-plugin wiring). No v1 source yet; no gen emitters (bits 09–18).
- **Purge Deno (H15):** delete `_v0/src/ws/deno.ts` + the `./ws/deno` export, `e2e/deno/`, `test:e2e:deno`, Deno build targets, and the Deno branches in detect-runtime/feature-detect/peer/serve/fetch-request/context/request-path/feature-slots/build-index/proxy/node-request/ws-shared/client-http (inside `_v0`). The oracle steps to **6767 − N** (N = the deleted Deno cases, measured) with a reason line in `oracle-baseline.txt`.
- **Relocate e2e apps + runner** under `packages/core/tests/e2e/` (these drive `_v0` until cutover, then the v1 modules as subpaths flip).
- **Test reorg (H13):** redistribute only the R15 session-dump files (bug-hunt/edge-cases/client-edge-cases/type-emitter-debug/sdk-r\*/audit/unit-core) into feature-named suites **inside `_v0/tests`** at the same import depth, gated by `reorg-coverage-diff`. **Colocation of v1 unit tests happens per-file as each v1 file is born in later bits — not here** (no v1 source exists yet).

## Tests (named, written first)
- `structure/check-tree.test.ts` — the on-disk tree matches `files.tsv` exactly (missing/extra file fails).
- `structure/no-deno.test.ts` — no `deno` token, `ws/deno`, or `./ws/deno` export remains; node/bun/cf detection still resolves.
- `structure/reorg-coverage-diff.test.ts` — case count after redistribution ≥ v0 case count per feature (the lose-nothing gate).
- `lint/boundaries.test.ts` — the `honey/boundaries` oxlint JS-plugin rule: import arrows hold; no `gen` file imports `@lovrozagar/honey` internals; no core file imports an adapter; rules exclude `_v0/**`.

## Files (from files.tsv)
- the v1 folder skeleton (empty `packages/core/src/**` dirs, `tests/**`), plus the `packages/gen` **skeleton only** (manifest, tsconfig, vitest, `_tokenizer/`) — no gen emitters (bits 09–18).
- `packages/core/_v0/` (the parked v0, one row); `package.json` subpaths all pointing at `_v0/src`.
- the oxlint JS-plugin rules `lint/{index,no-v8-ignore,boundaries,no-console,no-module-state,no-module-side-effects,content-type-exact-essence,no-header-mode}.js` (+ each `.test.ts`), wired via `.oxlintrc.json` `jsPlugins` (plugin name `honey`); `structure/{check-tree,no-deno,reorg-coverage-diff,oracle-count}.test.ts` + `mutation-harness.ts`; `tests/integration/security/adversarial.ts` scaffold.

## Gates turned on here (from the first file)
- `bun run typecheck`, `bun run lint` (oxlint), `bun run fmt:check` (oxfmt), `bun run test`, coverage thresholds 100/file (exclude `packages/gen/src/runtime/**` + type-only files), the **phase-aware** tree check (`--complete <bit>`, H19.4), the boundary lint, and the lint rules `no-v8-ignore`/`no-console`/`no-module-state`/`no-module-side-effects`/`content-type-exact-essence`/`no-header-mode`.
- the in-process `app.fetch` adversarial suite scaffold (F1) that later middleware bits extend; the mutation-check harness (each guard disabled → suite goes red) so failing-input-first is enforced, not convention.

## Capture acts owned here (make the measured gates enforceable — previously unassigned)
- **Token:** vendor the pinned `o200k_base` tokenizer (`packages/gen/src/_tokenizer/`), `scripts/capture-token-budget.ts` runs it over v0's current MCP/SDK/CLI output → `blueprint/baselines/tokens.json` (max per op + 15–20% headroom; MCP ceiling enforced in bit 18).
- **Perf:** add `bench/src/significance.ts` (median + sample-CI decision, +test) and wire `hotpath.ts` to it (replacing the 0.25 median tripwire); add `bench/src/finalize.ts` (the `_resolve` O(routes×scopes) bench); capture all 11 scenarios to `blueprint/baselines/hotpath.json`; flip `HOTPATH_THRESHOLD` 0.25→0.10. **Environment (D8):** record the baseline on **this machine, named as such** (`bun 1.4` — 1.4.3 active, 1.4.2 also present but same minor, so one `bun 1.4` baseline; no 1.3.x — the user runs newest + 1.4.3); no pinned CI runner yet (later infra decision); `taskset` is used, turbo-off is best-effort (the `boost` toggle is root-owned — the user flips it if wanted, not a blocker).
- **Oracle:** `tests/structure/oracle-count.test.ts` asserts the stepped count (6767 − N) vs the committed baseline (fails on drift incl. silent skips). The 30-cell e2e expected set (D9): commit the **25 locally-capturable cells** (node/bun × dev/prod + cf-dev); the **5 cf-prod cells are CI-captured** (need a deployed worker + CF creds — infra, flagged to the user).

## Security corpus
- none yet (scaffold only); the adversarial harness file is created here for later bits to add cases.

## Budget
- perf: n/a (no runtime change). token: n/a.
