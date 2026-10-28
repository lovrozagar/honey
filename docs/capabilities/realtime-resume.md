# Realtime resume

A realtime connection survives a dropped network. The client
reconnects over WebSocket, then SSE, then long-poll, and sends the id of the last message it saw; the server
replays what it missed. A refused transport falls through to the next, an open that every transport refuses ends
with the most specific refusal, and a 401 refreshes the token once through the client's auth hook. Every generated
SDK speaks the same protocol.

## Example

```ts
import { honey } from "@lovrozagar/honey"
import { realtime } from "@lovrozagar/honey/realtime"

const app = honey()

const prices = realtime(app, "/prices", {
	namespace: "prices",
	handler: (_ctx, conn) => {
		conn.join("ticker")
	},
})

setInterval(() => prices.publish("ticker", { eur: 1.08, at: Date.now() }), 1000)
```

Tested by: `integration/realtime.test.ts`
