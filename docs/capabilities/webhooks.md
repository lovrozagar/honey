# Webhooks

The requests your API sends out are part of its contract too. Declare the events once with `webhookContract` from
`@lovrozagar/honey/webhook`, each type with the schema of its `data`, and pass the contract as `webhooks` when you
serve the document. Each event appears under OpenAPI 3.1's `webhooks` as one
[Standard Webhooks](https://www.standardwebhooks.com) delivery: a POST of `{ type, timestamp, data }` with the
`webhook-id`, `webhook-timestamp` and `webhook-signature` headers. The generated SDKs carry no webhook code yet.

## Example

```ts
import { honey } from "@lovrozagar/honey"
import { serveOpenApi } from "@lovrozagar/honey/openapi"
import { webhookContract } from "@lovrozagar/honey/webhook"
import * as z from "zod"

const events = webhookContract({
	"order.shipped": z.object({ orderId: z.string(), shippedAt: z.string() }),
})

const app = honey()

serveOpenApi(app, { title: "Shop", version: "1.0.0", webhooks: events })

const { body, headers } = await events.sign(
	"order.shipped",
	{ orderId: "ord_1", shippedAt: "2026-11-02T12:00:00Z" },
	{ id: "msg_1", occurredAt: new Date(), secrets: "whsec_a2tra2tra2tra2tra2tra2tra2tra2tra2tra2tra2s=" },
)
await fetch("https://example.com/hook", { body, headers, method: "POST" })
```

Tested by: `openapi/webhooks.test.ts`, `security/webhook-contract.test.ts`

## Sending

`sign` returns one attempt, ready to POST: the JSON body and its headers, `content-type` included. Delivery, retries
and their log stay yours, for example in a queue consumer. Keep `id` and `occurredAt` across retries: the body stays
the same, and each attempt is signed when it is sent, so a retry hours later still passes a receiver's five-minute
window. `data` is typed as the schema's output, what the document states, and no schema runs when you sign.

For a body outside a contract, [`signWebhook`](../crypto.md#signing-a-webhook) signs it to the same scheme.
