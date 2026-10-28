# Rate limiting

`rateLimit({ limit, windowMs })` from `@lovrozagar/honey/rate-limit` is a
fixed-window limiter keyed by `ctx.ip`, the platform's peer address. Over the limit it answers 429 with
`Retry-After`, and every answer carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`. The
default store is in memory, per process and bounded, so a spray of keys cannot exhaust memory; behind several
instances, pass a shared `store`. A custom `key` limits by user or API key instead.

## Example

```ts
import { honey } from "@lovrozagar/honey"
import { rateLimit } from "@lovrozagar/honey/rate-limit"

const app = honey().use(rateLimit({ limit: 60, windowMs: 60_000 }))

app.get("/search").handler((ctx) => ctx.res.json("ok", { results: [] }))
```

Tested by: `middleware/rate-limit.test.ts`
