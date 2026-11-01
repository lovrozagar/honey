---
name: consumer-e2e-test-costs
paths: ["blueprint/baselines/e2e-expected.json","packages/core/tests/e2e/run.ts","packages/core/tests/e2e/apps/*/tests/e2e/*.test.ts"]
hits: 1
last-hit: 2026-11-01
evidence: ["plan 19"]
---

# A new consumer e2e test reds test:e2e twice

A Playwright test added to a `tests/e2e/apps/*` app failed verify for two reasons at once, neither of

## Mistake
It asserted honey's own envelope (`error_key: "internal_server_error"`) where the kitchen app answers
`api_error`: that app sets `.defaultBoundary("api_error")`, so a HoneyError whose key it does not
declare reaches the client under the app's key, not honey's.

And it moved six cells in `blueprint/baselines/e2e-expected.json`, not the one that was run.
`run.ts` holds every cell to its committed pass/skip/fail lists, so a test that merely appears fails
the run by the cell's name. `verify` runs `--env bun` alone, and the node and cf cells are CI's, so a
locally green re-record still reds CI.

## Fix
Assert what is true of that app: read its error factory and `.defaultBoundary(...)` first, and state
in a comment that the key is the app's own.

Then re-record the cell you can run (`bun packages/core/tests/e2e/run.ts --env bun --app <app>
--record blueprint/baselines/e2e-expected.json`) and write the cells you cannot by the same rule, one
per env and mode. A `test.skip` gated on `HONEY_E2E_ENV` lands in `skipped` on the envs it skips and
`passed` on the one it runs, so each env's cell moves differently. Re-record with Bun's own writer or
dump JSON with `ensure_ascii=False`: Python's default escaping rewrites every `→` in the file.
