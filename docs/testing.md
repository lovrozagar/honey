# Testing an app

`testClient(app, { env })` from `@lovrozagar/honey/testing` calls your app the way a client would, without a
server: `get`, `post`, `put`, `patch`, `delete`, `head`, `options`, and `request(method, path)` for any other
method. Each takes `json`, `form`, `headers` and `search`, and `ip` sets the peer address `ctx.ip` reads.

- **Cookies:** `cookies: true` keeps each answer's `Set-Cookie` and sends the cookies on later requests, honoring
  `Max-Age` and `Expires`.
- **Real HTTP:** `transport: "serve"` serves the app on a free local port through the runtime's adapter, for what
  only a real socket shows; `close()` stops it.

```ts run
import { honey } from "@lovrozagar/honey"
import { testClient } from "@lovrozagar/honey/testing"

const app = honey()
app.get("/hello").handler((ctx) => ctx.res.json("ok", { hello: ctx.search.name ?? "world", ip: ctx.ip }))

const client = testClient(app, { env: {} })
const answer = await client.get("/hello", { search: { name: "Ada" }, ip: "203.0.113.7" })
console.log(answer.status, JSON.stringify(await answer.json()))
// prints: 200 {"hello":"Ada","ip":"203.0.113.7"}
```

Tested by: `testing/testing.test.ts`
