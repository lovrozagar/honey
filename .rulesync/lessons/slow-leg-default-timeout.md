---
name: slow-leg-default-timeout
paths: ["packages/gen/src/**/*.test.ts","packages/gen/scripts/*.test.ts","packages/core/tests/**/*.test.ts"]
hits: 1
last-hit: 2026-11-01
evidence: ["plan 21"]
---

# A heavy leg without an explicit timeout reds only under load

`packages/gen/src/emit/mcp/server.test.ts`'s compiled-twin leg passed on its own and timed out at

## Mistake
Judging "is this leg mine?" by whether it fails, instead of by whether it fails *alone*. A leg that
passes alone and reds in the suite is almost never a correctness break; it is a budget.

The leg also deserved the bound and did not have it: it jiti-erases types over every emitted source
file, which is seconds of CPU, and no leg in that file set a timeout.

## Fix
Give every leg that spawns a process, drives a toolchain, or does heavy in-process work
`{ timeout: SPAWN_TIMEOUT }` from `packages/gen/src/gen/__fixtures__/spawn-timeout.ts` (60 s). Core
keeps its twin, held equal by `packages/core/tests/structure/spawn-timeout-twins.test.ts`.

When a leg reds in a suite run, re-run that one file before touching anything:

    bun vitest run <that file>

Green alone plus red in the suite means a timeout or a shared-resource clash, not the change under
test. The grep that finds unbounded heavy legs is `grep -c SPAWN_TIMEOUT <file>` returning 0 in a file
that spawns or transforms.
