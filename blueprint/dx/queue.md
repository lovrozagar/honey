# dx — queue

One typed contract and consumer for Workers and for a Node or Bun process. Delivery is at-least-once.

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| `queueContract({ [type]: schema })` | — | — | `send` and `sendBatch` to any `{ send, sendBatch }` | `send` runs no schema; the consumer checks every body | `queue/define.test.ts` |
| `queueMessage<T>()` | — | — | declares a type with no check | its data is not validated | `queue/define.test.ts` |
| `defineConsumer<Env>()(contract, options)` | `handlers` | — | a consumer; a type with no handler throws | called twice so `Env` can be written | `queue/define.test.ts` |
| `logger` | — | honey's logger | where the consumer logs | — | `queue/define.test.ts` |
| `retryDelay(error)` | — | at once for a throw, 60 s for a bad body | seconds to hold a retry back, capped at 43,200 | receives a `QueueBodyError` for a body past its contract | `queue/deliver.test.ts` |
| `onDeadLetter` | — | logs | receives a letter with its body | a throwing report is logged and the message still settles, except in a dead-letter queue | `queue/deliver.test.ts` |
| `throw deadLetter(reason)` | — | — | gives up on a message with no more tries | — | `queue/deliver.test.ts` |
| a body past its contract | — | — | retries and reaches the dead-letter path with its body; never acked | — | `tests/integration/security/queue-adversarial.test.ts` |
| `workersQueue(consumer, { deadLetterQueues })` | — | — | the `queue` handler; a named queue's messages are reported and acked | Workers deletes a message past `max_retries` with no dead-letter queue | `queue/workers.test.ts` |
| `serveQueue(consumer, options)` | `env`, `store` | — | one claim loop on Node and Bun, with leases extended while a message runs | delivery is at-least-once | `queue/serve.test.ts`, `tests/integration/queue-runtimes.test.ts` |
| `concurrency` | — | 10 | the most messages running at once | — | `queue/serve.test.ts` |
| `leaseSeconds` | — | 30 | how long a lease holds | — | `queue/serve.test.ts` |
| `maxAttempts` | — | 5 | the delivery after which a retry dead-letters; a claim past it dead-letters without running | — | `queue/serve.test.ts` |
| `pollMs` | — | 1,000 | the wait after an empty or failed claim | — | `queue/serve.test.ts` |
| `close(timeoutMs)` | — | waits for running work | stops claiming; past the timeout resolves and messages redeliver | a handler closing its own consumer calls `void close()` | `queue/serve.test.ts` |
| `memoryQueueStore()` | — | — | a store for development and tests | nothing survives a restart | `queue/memory-store.test.ts` |
