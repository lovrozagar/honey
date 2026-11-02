# Cron

`@lovrozagar/honey/cron` defines scheduled jobs once. `@lovrozagar/honey/cron/workers` runs them from a Workers cron
trigger, and `@lovrozagar/honey/cron/serve` runs them on a timer in a Node or Bun process.

## Example

```ts
import { defineCron } from "@lovrozagar/honey/cron"

type Env = { readonly DATABASE_URL: string }

declare function pruneSessions(url: string, signal: AbortSignal): Promise<number>

export const cron = defineCron<Env>({
	schedules: {
		"0 3 * * MON": {
			prune: async ({ env, log, signal }) => {
				log.info({ removed: await pruneSessions(env.DATABASE_URL, signal) }, "pruned")
			},
		},
	},
})
```

`defineCron<Env>({ schedules })` takes an optional `logger` beside the schedules, honey's logger by default. A job receives `env`, `log`, `schedule`, `scheduledAt` and `signal`. `scheduledAt` is the minute the run belongs to, not
the moment it started.

## Expressions

An expression is five fields in UTC: minute, hour, day of month, month, weekday. It takes `*`, lists, ranges, steps, and
month and weekday names. `defineCron` throws on anything else, naming the expression.

| refused                               | why                                                 | write instead                      |
| ------------------------------------- | --------------------------------------------------- | ---------------------------------- |
| a numeric weekday, `0 9 * * 1`        | Workers numbers 1 as Sunday, POSIX numbers 0        | `0 9 * * MON`                      |
| both day fields, `0 0 1 * MON`        | POSIX runs on either, other schedulers only on both | one schedule per rule              |
| `L`, `W`, `#` and six fields          | only some schedulers take them                      | five fields and a check in the job |
| `*/0`, a reversed range, `0 0 30 2 *` | they can never fire as written                      | a date that occurs                 |

## On Workers

Export the handler from the entry your build points at. Honey's build moves a `scheduled` or `queue` function onto the Worker's default export,
where workerd calls it.

```ts
import { defineCron } from "@lovrozagar/honey/cron"
import { workersCron } from "@lovrozagar/honey/cron/workers"

const cron = defineCron<{}>({ schedules: { "*/5 * * * *": { ping: async ({ log }) => log.info("ping") } } })

export const scheduled = workersCron(cron)
```

List the same expression, spelled the same way, under `triggers.crons` in your wrangler config. Workers reports the text
of the trigger that fired, and a run for an expression the definition lacks fails.

Every job of the expression runs. If one fails, the others finish, `noRetry()` is called so finished jobs do not run
again, and the run rethrows.

## In a process

`serveCron(cron, options)` shares one timer between Node and Bun. It wakes at each minute and reads the clock, so a suspended laptop or
a clock step corrects itself within a minute.

```ts
import { defineCron } from "@lovrozagar/honey/cron"
import { serveCron } from "@lovrozagar/honey/cron/serve"

declare function report(error: unknown): void

const cron = defineCron<{}>({ schedules: { "* * * * *": { ping: async ({ log }) => log.info("ping") } } })

const running = serveCron(cron, { env: {}, onError: report, singleInstance: true })

process.once("SIGTERM", () => running.close(10_000))
```

Pass exactly one of `singleInstance: true` or `claim`. With several instances, `claim` decides which one runs a tick:

```ts
import { defineCron } from "@lovrozagar/honey/cron"
import { serveCron } from "@lovrozagar/honey/cron/serve"

declare const store: { insertIfAbsent(key: string): Promise<boolean> }
declare function report(error: unknown): void

const cron = defineCron<{}>({ schedules: { "* * * * *": { ping: async ({ log }) => log.info("ping") } } })

serveCron(cron, {
	claim: (key, scheduledAt) => store.insertIfAbsent(`${key} ${scheduledAt.toISOString()}`),
	env: {},
	onError: report,
})
```

`claim(key, scheduledAt)` is asked per job per tick and never released. Its `key` is `<expression> <job>`.

- With a job still running, that job skips its tick: a job still running never runs alongside itself.
- A tick missed while the process was down or suspended is lost. `claim` covers several instances, not downtime.
- A failed job or `claim` reaches `onError`. If `onError` throws, the error is logged.
- `close(timeoutMs)` stops the timer and waits for running jobs. When the timeout passes first it aborts their `signal`
  and resolves without them. With no timeout it waits as long as they take.
- The timer keeps the process alive until `close`.
