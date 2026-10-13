# Bit 00 — accounting

Closes: F1 (gate setup) · Deno purge (H15) · test reorg (H13) · `_v0` + cutover scaffolding (H21)
Oracle kept green: the whole v0 suite runs through `_v0` (every subpath still points into `_v0/src`); this bit moves files and turns on gates, it changes no behavior.

The first construction act. No feature code changes, **no gen split** (that is bits 09–18, H3): v0 is parked in `_v0`, every `package.json` subpath points into `_v0/src`, and the v1 folder skeleton + gates are created empty.

## Scope
- **Park v0 as a complete package at root `/_v0/` (H21 / Option Z):** `git mv` the whole v0 package into `/_v0/` — `src`, `tests`, **and** `bin`, `scripts`, `docs`, `examples`, `README.md`, `tsconfig.{build,src,types}.json`, `vitest.{all,harness,harness.rust}.config.ts`, plus a `_v0/package.json` named `@lovrozagar/honey` carrying the v0 `exports`/`bin`/`scripts`. `_v0` **stays a root-`workspaces` member**, so every consumer resolves v0 with zero edits and the full oracle (vitest + e2e + consumers + bundle + packaging + bench) stays green. Rewrite the 15 `@lovrozagar/honey` imports in `_v0/tests` to relative (self-contained). `_v0/**` is outside v1's `src/**` globs + published `files`.
- **`packages/core` = pure v1, left OUT of root `workspaces`** until cutover: it holds only v1 `src`/`tests`/`lint`/configs. Root `test`/`typecheck` run both trees (v1 as a vitest project + tsc include, not a resolvable package yet). Clean the v0 cruft out of `packages/core`: the gitignored `.tmp*`/`.ruff_cache` (rm) and the **tracked** `.claude/{progress,specs,lessons.md}` (`git rm` — scratch goes in `.tmp/grunt/`, not committed).
- **Create the v1 skeleton** from `04-tree.md`/`files.tsv`: empty `packages/core/src/**` folders + `packages/gen` skeleton **only** (manifest, tsconfig, vitest, `_tokenizer/`, oxlint-plugin wiring). No v1 source yet; no gen emitters. The **cutover** (packages/core joins workspaces as `@lovrozagar/honey`, `_v0` leaves) is one atomic swap after gen lands (end of bit 18), not bit 00.
- **Purge Deno (H15):** delete `_v0/src/ws/deno.ts` + the `./ws/deno` export, `e2e/deno/`, `test:e2e:deno`, Deno build targets, and the Deno branches in detect-runtime/feature-detect/peer/serve/fetch-request/context/request-path/feature-slots/build-index/proxy/node-request/ws-shared/client-http (inside `_v0`). The oracle steps to **6767 − N** (N = the deleted Deno cases, measured) with a reason line in `oracle-baseline.txt`.
- **Relocate e2e apps + runner** under `packages/core/tests/e2e/` (these drive `_v0` until cutover, then the v1 modules as subpaths flip).
- **Test inventory (H13 — not a reshuffle):** `v0-inventory.ts` parses every `_v0/tests` file (oxc-parser), classifies each case by feature → committed `blueprint/baselines/v0-cases.json`. `_v0/tests` stays **byte-frozen** (no hoist/helper/`vi.mock` surgery on soon-deleted files). The lose-nothing gate is `reorg-coverage-diff`: each later bit must **port** (a v1 test tagged `// v0: <id>`) or **retire** (reason in the inventory) every v0 case of the features it owns; unaccounted must be 0 before `_v0` is deleted at bit 20. **Colocation of v1 unit tests happens per-file as each v1 file is born in later bits — not here** (no v1 source exists yet).

## Tests (named, written first)
- `structure/check-tree.test.ts` — the on-disk tree matches `files.tsv` exactly (missing/extra file fails).
- `structure/no-deno.test.ts` — no `deno` token, `ws/deno`, or `./ws/deno` export remains; node/bun/cf detection still resolves.
- `structure/v0-inventory.test.ts` — the pure classifier over fixtures (case extraction + feature assignment stable); drives `v0-inventory.ts` to regenerate `v0-cases.json` and asserts it matches the committed baseline (drift fails).
- `structure/reorg-coverage-diff.test.ts` — the lose-nothing gate: every v0 case of a feature whose bit has completed is ported (a v1 test tagged `// v0: <id>`) or retired (reason in the inventory); unaccounted for a completed feature fails, and the global unaccounted count must be 0 before bit-20 `_v0` deletion.
- `lint/boundaries.test.ts` — the `honey/boundaries` oxlint JS-plugin rule: import arrows hold; no `gen` file imports `@lovrozagar/honey` internals; no core file imports an adapter; rules exclude `_v0/**`.

## Files (from files.tsv)
- the v1 folder skeleton (empty `packages/core/src/**` dirs, `tests/**`), plus the `packages/gen` **skeleton only** (manifest, tsconfig, vitest, `_tokenizer/`) — no gen emitters (bits 09–18).
- `packages/core/_v0/` (the parked v0, one row); `package.json` subpaths all pointing at `_v0/src`.
- the oxlint JS-plugin rules `lint/{index,no-v8-ignore,boundaries,no-console,no-module-state,no-module-side-effects,content-type-exact-essence,no-header-mode}.js` (+ each `.test.ts`), wired via `.oxlintrc.json` `jsPlugins` (plugin name `honey`); `structure/{check-tree,no-deno,v0-inventory,reorg-coverage-diff,oracle-count}.test.ts` + `v0-inventory.ts`/`mutation-harness.ts`; `blueprint/baselines/v0-cases.json`; `tests/integration/security/adversarial.ts` scaffold.

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
