# Honey v1 blueprint

> **honey v0 was validated and runs in production** (anyrow's gateway/extract/growth/saas/cdn services are live on it). v1 is the **optimal rewrite** of that proven framework — the best version it can be, however much work or time it takes. **No shortcuts.** Every decision here is made for the optimal end state, not for speed of getting there; where the optimal needs more work than a patch, the optimal wins.

This is the rewrite from v0 to v1. v0 was validated: the reviews executed the real server, the real adapters (Node, Bun, Workers), the real generators, and a live SDK harness, and the findings are in `TODO.md` / `TODO_V1.md` (313 findings across 14 workstreams against `3ab88ce`) with every fix proven by `packages/core/docs/regression-matrix/`. v1 is not a patch on those files. It is the optimal framework written from zero, in two packages. The work is whatever that optimality takes.

Every behavior is test-driven. The test is written first and seen failing. Then the code is written. Then the test is green. A behavior with no named test does not exist. A prop, field, option, or mode that `dx/` does not list does not exist. An agent does not add one because v0 had something like it, and does not drop one because a bit forgot to repeat it. `dx/` is the user contract. The bits say when the code is born. When a bit and `dx/` disagree, `dx/` wins and the bit is updated in the same change.

v0's 6,764 e2e/integration tests are the oracle: v1 must pass them identically. Unit tests are re-homed and split as files split; a bug or inefficiency spotted along the way earns a TDD fix, not a workaround. No behavior regresses silently — the oracle baseline in `00-rules.md` is the number v1 is held to.

v1 source stays easy to read. A file does one job, stays under the limits in `00-rules.md`, and is split before it becomes a pile of branches. v0's long files (`codegen.ts` 5,089 lines, `index.ts` 3,829, the `Honey` class ~2,600) are not a pattern to copy. A comment says why, or names a pitfall. It does not narrate the next line.

Historical evidence stays where it is: `TODO.md`, `TODO_V1.md` (finding ids, 14 workstreams, decisions, against `3ab88ce`), `packages/core/docs/regression-matrix/` (ws1-3, ws4-8, ws9-12, review), and the pre-start deep dive `.tmp/grunt/1-v1-prestart-deep-dive-20261012T192436Z.md` (gaps A1–G1). When this directory and those files disagree, this directory wins.

Nothing in `packages/` has been moved or rewritten by this directory. `_v0/` does not exist yet. Bit 00 is the first construction act.

## Two packages

| package | dir | job |
| --- | --- | --- |
| `@lovrozagar/honey` | `packages/core` | the server framework you write your API in; it emits the OpenAPI document and the IR |
| `@lovrozagar/honey-clients` | `packages/gen` | takes an `openapi.json` (any 3.x, not just honey's) and generates SDKs (TS/Go/Rust/Python/C#/Java), the CLI, and the MCP server |

The IR is the seam: core emits OpenAPI + IR; codegen consumes the IR and never reaches into core internals.

## Reading order

| file | what it settles |
| --- | --- |
| `00-rules.md` | How code is written: TDD, colocated tests, 100% coverage, limits, environments, the formatter post-pass, the oracle |
| `01-decisions.md` | Every product decision, including the ones the old plan left open, and every deep-dive gap A1–G1 |
| `02-system.md` | What the running system does, in order, and who owns each part, and the core→codegen IR seam |
| `03-surface.md` | Every public export of both packages, tagged KEEP / MODIFY / DELETE / ADD |
| `dx/` | Every value a user passes. Required, default, outcome, pitfall, test |
| `04-tree.md` | What each directory is for. The exhaustive file list is `files.tsv` |
| `files.tsv` | Every file, both packages. Normative. Plus the v0→v1 test-home mapping |
| `bits/00-accounting.md` | Move to `_v0/`, Deno purge, core→codegen move, test reorg, tree + lint + coverage gates |
| `bits/01-core-route-model.md` … `bits/20-docs.md` | The sequential construction units |

## Rules for changing the blueprint

- Add a file by adding a row to `files.tsv` and a case to the bit that creates it, in the same change, before the file exists on disk.
- Do not add a behavior in a bit without a test name and the file that holds the test.
- Do not leave an open item. A question that blocks a file is a decision in `01-decisions.md`.
- Bits are sequential. Bit N may add cases to a file born in an earlier bit. It does not create a second copy of that file.
- A new capability (rate-limit, range, compression, webhooks) is not real until it has a `dx/` entry and an oracle note, or it drifts back into undocumented surface the way the gif response path did in v0.
