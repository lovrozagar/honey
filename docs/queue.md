# Queue

`@lovrozagar/honey/queue` defines a typed queue. `@lovrozagar/honey/queue/workers` consumes it from a Workers Queue
binding, and `@lovrozagar/honey/queue/serve` consumes it in a Node or Bun process from a `QueueStore`.

## Example

A sender imports only the contract.

```ts
import { queueContract, queueMessage, type QueueTarget } from "@lovrozagar/honey/queue"

export const jobs = queueContract({ welcome: queueMessage<{ userId: string }>() })

declare const JOBS: QueueTarget

await jobs.send(JOBS, "welcome", { userId: "u1" })
await jobs.send(JOBS, "welcome", { userId: "u2" }, { delaySeconds: 60 })
```

`queueContract({ [type]: schema })` takes any Standard Schema, which the consumer runs on every body, or
`queueMessage<T>()`, which declares a type with no check, for a queue only your own code sends to. `send` runs no schema.
`sendBatch` sends several messages, nothing for an empty list, and does not split a batch past Workers' limits.

A consumer handles each type.

```ts
import { deadLetter, defineConsumer, queueContract, queueMessage } from "@lovrozagar/honey/queue"

type Env = { readonly RESEND_KEY: string }

declare function sendWelcome(key: string, userId: string): Promise<boolean>

const jobs = queueContract({ welcome: queueMessage<{ userId: string }>() })

export const consumer = defineConsumer<Env>()(jobs, {
	handlers: {
		welcome: async ({ data, env }) => {
			if (!(await sendWelcome(env.RESEND_KEY, data.userId))) throw deadLetter("no such user")
		},
	},
	onDeadLetter: async (letter) => {
		console.error(letter.reason, letter.body)
	},
	retryDelay: () => 30,
})
```

`defineConsumer<Env>()(contract, options)` is called twice so you can write `Env` while the contract's types are inferred.
`logger` is optional, honey's logger by default.

Delivery is at-least-once, so a handler must be safe to run twice.

## Settling a message

A handler receives `data`, `env`, `log`, `traceId`, `background(promise)` and `message`, which holds `id`, `attempts`,
`ack()` and `retry({ delaySeconds })`.

| the handler                | the message                                |
| -------------------------- | ------------------------------------------ |
| returns                    | acks                                       |
| throws                     | retries                                    |
| `throw deadLetter(reason)` | goes to `onDeadLetter`, with no more tries |
| calls `ack()` or `retry()` | the first call wins over everything after  |

`retryDelay(error)` answers seconds to hold a retry back. A handler's throw retries at once by default.

Each throw that retries is logged at warn, `queue: message retrying`, with the error, `attempts` and `delaySeconds`, so
every failed attempt shows its stack; a letter keeps only the last attempt's reason.

`background(promise)` keeps the runtime alive for work past the message, and logs a rejection.

## A body past its contract

A body with no type, a type the contract lacks, or data its schema refuses is a body past its contract: it never reaches a handler and is never acked. It
retries, after 60 s by default, because it fails the same way until something deploys, and it reaches the dead-letter
path with its body. `retryDelay` receives a `QueueBodyError` for these.

A letter holds `id`, `attempts`, `queue`, `reason`, `type`, `body` and `kept`: whether the message still exists on the
platform after the report.

## On Workers

```ts
import { defineConsumer, queueContract, queueMessage } from "@lovrozagar/honey/queue"
import { workersQueue } from "@lovrozagar/honey/queue/workers"

const jobs = queueContract({ ping: queueMessage<number>() })
const consumer = defineConsumer<{}>()(jobs, { handlers: { ping: async () => {} } })

export const queue = workersQueue(consumer, { maxRetries: 5 })
```

Export `queue` from the entry your build points at, and honey's build moves it onto the Worker's default export.

Configure a dead-letter queue. Without one, **Workers deletes a message past `max_retries`**, and the body honey kept
retrying is gone.

```json
{
	"queues": {
		"producers": [{ "binding": "JOBS", "queue": "jobs" }],
		"consumers": [{ "queue": "jobs", "max_retries": 5, "dead_letter_queue": "jobs-dead" }]
	}
}
```

`workersQueue(consumer, { deadLetterQueues, maxRetries })` takes either option, or both.

Name the consumer's `max_retries` as `maxRetries`. Workers counts attempts but does not hand that number to the
consumer, so keep the two equal: a test that reads your Workers config and the option holds them. A failed delivery on
the attempt past it, the last, is reported to `onDeadLetter` with `kept: true`, then retried, so the platform moves it
to `dead_letter_queue`, where it stays for a redrive. A failed report still retries.

To consume the dead-letter queue instead, add it as a second consumer and name it in `deadLetterQueues`:
`workersQueue(consumer, { deadLetterQueues: ["jobs-dead"] })` reports what lands there to `onDeadLetter` with
`kept: false` and acks it. If the report throws, that message retries after 60 s, bounded by the dead-letter consumer's
own `max_retries`, past which Workers drops it.

`throw deadLetter` reports, then acks, even when the report fails: the handler already gave up, and the letter is logged.

Messages of a batch run at once, and one message cannot fail the batch.

## In a process

```ts
import { defineConsumer, queueContract, queueMessage } from "@lovrozagar/honey/queue"
import { memoryQueueStore, serveQueue } from "@lovrozagar/honey/queue/serve"

const jobs = queueContract({ ping: queueMessage<number>() })
const consumer = defineConsumer<{}>()(jobs, { handlers: { ping: async () => {} } })

const store = memoryQueueStore()
await jobs.send(store, "ping", 1)

const running = serveQueue(consumer, { env: {}, store })

process.once("SIGTERM", () => running.close(10_000))
```

`serveQueue(consumer, options)` takes:

| option         | default     | what it does                                                    |
| -------------- | ----------- | --------------------------------------------------------------- |
| `env`          | required    | what handlers receive                                           |
| `store`        | required    | where messages wait                                             |
| `concurrency`  | 10          | the most messages running at once                               |
| `leaseSeconds` | 30          | how long a lease holds, extended every half lease while it runs |
| `maxAttempts`  | 5           | the delivery after which a retry dead-letters                   |
| `pollMs`       | 1,000       | the wait after an empty or failed claim                         |
| `queue`        | `"default"` | the name a letter carries                                       |
| `onError`      | logs        | receives a failed store call                                    |

A crash loses nothing: leases expire and the messages redeliver. A message whose lease kept expiring past `maxAttempts`
dead-letters without running, so a message that kills the process cannot loop forever.

`close(timeoutMs)` stops claiming and waits for running messages and their background work. When the timeout passes
first it resolves, and those messages redeliver. With no timeout it waits as long as they take, so a handler closing its
own consumer calls `void close()`.

### A store of your own

`memoryQueueStore()` lives in this process's memory: it is for development and tests. Production needs a `QueueStore`:

| method                             | what it must do                                                  |
| ---------------------------------- | ---------------------------------------------------------------- |
| `send`, `sendBatch`                | store messages, honouring `delaySeconds`                         |
| `claim({ limit, leaseSeconds })`   | lease deliverable messages in order, counting an attempt on each |
| `extend(receipt, seconds)`         | hold a lease `seconds` from now                                  |
| `ack(receipt)`                     | finish a message                                                 |
| `retry(receipt, { delaySeconds })` | make it deliverable after the delay                              |
| `deadLetter(receipt, reason)`      | keep it from redelivering                                        |

A claim answers `[{ id, body, attempts, receipt }]`, with `attempts` from 1. An expired lease is claimable again, and a
stale receipt must change nothing.
