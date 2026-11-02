# dx — cron

One schedule definition for Workers and for a Node or Bun process. Five fields in UTC, in the subset every runtime reads the same way.

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| `defineCron<Env>({ schedules })` | `schedules` | — | a checked definition; throws naming the expression | — | `cron/workers.test.ts` |
| `logger` | — | honey's logger | where jobs log, bound to job and schedule | — | `cron/workers.test.ts` |
| an expression | — | — | `*`, lists, ranges, steps, month and weekday names | numeric weekdays, both day fields, `L`, `W`, `#`, six fields, `*/0`, reversed ranges and dates that never occur throw | `cron/expression.test.ts` |
| `workersCron(cron)` | — | — | the `scheduled` handler; every job runs, `noRetry()` before a failed run rethrows | the expression must match the trigger's text; an unknown one fails the run | `cron/workers.test.ts` |
| `scheduled`, `queue` on a Worker's entry | — | — | a function moves onto the default export, where workerd calls it | its name stays as an inert object, since an export list is static | `build/targets.test.ts` |
| `serveCron(cron, options)` | `env`, `onError`, one of `singleInstance` or `claim` | — | one timer on Node and Bun, sleeping at most a minute | missed ticks are lost; the timer keeps the process alive until `close` | `cron/serve.test.ts`, `tests/integration/cron-runtimes.test.ts` |
| `claim(key, scheduledAt)` | — | — | asked per job per tick, never released; a throw reaches `onError` and the job does not run | covers several instances, not downtime | `cron/serve.test.ts` |
| a job still running | — | — | skips its tick | — | `tests/integration/security/cron-adversarial.test.ts` |
| `close(timeoutMs)` | — | waits for running jobs | stops the timer; past the timeout aborts `signal` and resolves | a second call answers the first's promise | `cron/serve.test.ts` |
