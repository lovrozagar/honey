---
name: run-the-gates-that-read-your-source
paths: ["packages/gen/src/**","packages/core/src/**","packages/core/lint/**","packages/gen/tests/structure/**","blueprint/files.tsv"]
hits: 3
last-hit: 2026-11-02
evidence: ["plan 21","roadmap 2","plan 32"]
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

## Fix
After changing anything under `packages/*/src`, run the readers before verify:

    bun vitest run packages/core/lint packages/gen/tests/structure packages/core/tests/structure
    bun run test:gen            # the coverage floor lives here

A new file also needs its `blueprint/files.tsv` row at `COMPLETE + 1`, read from
`packages/core/tests/structure/check-tree.ts` at edit time. Extracting a module is the case most likely
to trip a derivation: a lint rule that follows named calls cannot see through a closure stored in a
table.
