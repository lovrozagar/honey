---
name: ci-env-differs-from-local
paths: ["packages/gen/src/**","packages/core/src/**",".github/workflows/ci.yml"]
hits: 1
last-hit: 2026-11-01
evidence: ["plan 21"]
---

# `verify` runs CI's scripts, not CI's environment

1.0.0-rc.10's release run died on five tests after a green local `bun run verify`. CI runs the same

## Mistake
`missingFormatter` read `HONEY_REQUIRE_TOOLCHAINS` to decide whether a missing formatter throws.
`.github/workflows/ci.yml` sets that on six jobs, where it means "this leg's toolchain must be present,
do not skip" — a harness switch, not a product one. So in CI every incidental generation without oxfmt
threw. Locally nothing sets it, so verify took the other branch and passed.

The second half of the same gap: oxfmt is a devDependency here and an optional peer in a packed
tarball, so a report line that never appeared locally appeared in CI's install legs, where the test
asserts stderr exactly.

## Fix
Product code gets its own variable, never one the harness owns, and
`packages/gen/tests/structure/env-ownership.test.ts` now fails if any source under `packages/*/src`
reads `HONEY_REQUIRE_*`. It tells a read from a mention, so a comment naming the variable it avoids is
still legal.

For anything touching generation or a toolchain, run the gate under CI's own environment before
pushing:

    HONEY_REQUIRE_TOOLCHAINS=1 bun run verify

And when a leg asserts exact stderr or stdout, pin what it depends on — `{ PATH: "" }`, or the pinned
binary through `$RUFF`/`$RUSTFMT`/`$GOFMT` — rather than inheriting the machine. A leg whose
expectation changes with what happens to be installed passes here and fails there.
