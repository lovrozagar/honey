---
name: run-the-gates-that-read-your-source
paths: ["packages/gen/src/**","packages/core/src/**","packages/core/lint/**","packages/gen/tests/structure/**","blueprint/files.tsv"]
hits: 4
last-hit: 2026-11-02
evidence: ["plan 21","roadmap 2","plan 32","plan 33"]
---

# Changed source reds the gates that read it, not only its own tests

Plan 21 took four `bun run verify` passes. Every pass found a real defect, and none of them was in a

## Mistake
After each edit I ran the suites of the files I touched, saw green, and called it done. The gates that
read those files kept failing afterwards:

- `packages/core/lint/spawners.test.ts` derives which exports reach a spawn by walking named calls.
  Moving the formatters into `gen/formatters.ts` meant `generated` no longer *proved* it spawns, so a
  test calling it would have lost its timeout bound. Listing the new helper then made the rule demand
  bounds on the tests that call it.
- `packages/gen/tests/structure/{python,rust}-toolchain.test.ts` hold the pinned ruff and rustfmt paths
  to named sinks; a new leg handing one to `generated()` tripped them.
- The gen project's coverage floor wants 100% on a new `src` file, which end-to-end tests do not give.
- `blueprint/files.tsv` needs a row per new file, or `check-tree` reds `unlisted`.
- Plan 39: this lesson's own command ran gen's structure tests from the repo root, where no vitest
  config applies: vitest's 5 s default and every toolchain file at once, not gen's 30 s bound and one
  toolchain group at a time. Overlapping runs then timed out cases that pass alone.

## Fix
After changing anything under `packages/*/src`, run the readers before verify, each package under its
own config:

    bun vitest run --root packages/core lint tests/structure
    bun vitest run --root packages/gen tests/structure
    bun run test:gen            # the coverage floor lives here

A new file also needs its `blueprint/files.tsv` row at `COMPLETE + 1`, read from
`packages/core/tests/structure/check-tree.ts` at edit time. Extracting a module is the case most likely
to trip a derivation: a lint rule that follows named calls cannot see through a closure stored in a
table.
