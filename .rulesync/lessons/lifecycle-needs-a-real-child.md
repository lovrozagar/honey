---
name: lifecycle-needs-a-real-child
paths: ["packages/core/src/cron/**","packages/core/src/queue/**","packages/core/src/adapters/**"]
hits: 1
last-hit: 2026-11-02
evidence: ["roadmap 2"]
---

# A timer loop's shutdown is proven only by a process that has to exit

Plan 30's `serveCron` passed every fake-timer test, yet `close()` called from inside a running job was

## Mistake
Treating fake timers as proof of lifecycle. They prove the order of callbacks, not that nothing keeps
the event loop alive after `close`.

## Fix
Any loop that arms a timer, a poll or a listener gets one leg per runtime that spawns that runtime,
runs the loop, closes it from inside its own callback and from outside, and asserts the child exits
within an explicit bound (`SPAWN_TIMEOUT`). See `packages/core/tests/integration/cron-runtimes.test.ts`.
A mutant that removes the exit makes that leg hang, so a mutation proof needs its own timeout and a
recheck of orphaned child PIDs afterward.
