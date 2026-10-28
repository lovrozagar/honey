# Streaming

Three helpers stream an answer. `ctx.res.stream(producer)` writes bytes, `ctx.res.generate(iterable)` sends what an
iterable yields, and `ctx.res.sse(producer, options)` sends server-sent events. Each one is pulled by the client: a
send waits until the client reads, so a producer never runs further ahead than the connection's buffers, and a
client that stops reading holds the producer back.

When the client leaves, the stream closes, `stream.closed` turns true, a waiting send rejects, and the producer's
`finally` runs. Put cleanup there: a subscription, a timer, a database cursor.

## A producer that does no I/O should yield per send

A producer that never awaits anything but `send` keeps the event loop busy until the connection's buffers fill.
Its first event reaches the client only then: about 0.7 s for small events on Node, longer under load. A producer
that awaits real work (a query, a queue, a timer) yields on its own. One that only computes should yield a turn per
send, with `await new Promise((resolve) => setImmediate(resolve))` on Node and Bun, or a `setTimeout(resolve, 0)`
anywhere.

## Example: an SSE producer that cleans up when the client leaves

`defaultRetry` tells the client how long to wait before reconnecting, and the `finally` runs whether the producer
ends on its own or the client goes away. This block runs as part of the docs' tests.

```ts run
import { honey } from "@lovrozagar/honey"
import { serve } from "@lovrozagar/honey/serve"

let ended = (_: string) => {}
const cleanedUp = new Promise<string>((resolve) => (ended = resolve))

const app = honey()

app.get("/ticks").handler((ctx) =>
	ctx.res.sse(
		async (stream) => {
			try {
				for (let tick = 1; !stream.closed; tick++) {
					await stream.send({ data: String(tick), event: "tick", id: String(tick) })
					await new Promise((resolve) => setTimeout(resolve, 50))
				}
			} finally {
				stream.close()
				ended("cleaned up")
			}
		},
		{ defaultRetry: 3000 },
	),
)

const server = await serve(app, { hostname: "127.0.0.1", port: 0 })
const leave = new AbortController()
const response = await fetch(`${server.url}/ticks`, { signal: leave.signal })
const reader = (response.body as ReadableStream<Uint8Array>).getReader()
const first = new TextDecoder().decode((await reader.read()).value)
console.log(first.includes("retry: 3000") ? "retry sent" : "no retry")
leave.abort()
console.log(await cleanedUp)
await server.close()
// prints: retry sent
// prints: cleaned up
```
