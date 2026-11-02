# Webhooks

The requests your API sends out are part of its contract too. Declare the events once with `webhookContract` from
`@lovrozagar/honey/webhook`, each type with the schema of its `data`, and pass the contract as `webhooks` when you
serve the document. Each event appears under OpenAPI 3.1's `webhooks` as one
[Standard Webhooks](https://www.standardwebhooks.com) delivery: a POST of `{ type, timestamp, data }` with the
`webhook-id`, `webhook-timestamp` and `webhook-signature` headers. A TypeScript SDK generated from that document
verifies a delivery into a typed event; the other languages' SDKs follow.

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

## Receiving

A TypeScript SDK generated from a document with these events writes `<stem>.webhook.gen.ts`, which exports
`verifyWebhook(body, headers, secret)`. Pass
the raw body, before any parse, and the request's headers. It checks a `v1` signature on WebCrypto, in constant time,
under the secret or, while you rotate, under either of two. It refuses a timestamp more than five minutes from now in
either direction. It returns the event: check `known` first, then switch on `type`, and `data` is typed by the event.
An event type your SDK predates comes back with `known: false` and its data as sent, so a newer API never breaks an
older receiver. A forged, tampered, stale or malformed delivery throws `WebhookVerificationError`, and a secret that
is not a `whsec_` key throws `TypeError`.

Import everything a receiver needs from that one file: `verifyWebhook`, `WebhookVerificationError`, `WebhookHeaders`,
`WebhookEvent` and each event's type. It holds the whole verifier and imports nothing at run time, so a receiver bundles
no client and needs no credentials. An SDK published as a package maps it to its own subpath, beside `"."`:

```json
{ "exports": { ".": "./src/index.ts", "./webhook": "./src/_gen/ts/shop.webhook.gen.ts" } }
```

```ts sdk
import { type WebhookEvent, verifyWebhook, WebhookVerificationError } from "./shop.webhook.gen"

export function describe(event: WebhookEvent): string {
	return event.known ? `${event.type} ${event.id}` : `unknown ${event.type}`
}

export async function receive(request: Request): Promise<Response> {
	try {
		const event = await verifyWebhook(
			await request.text(),
			request.headers,
			"whsec_a2tra2tra2tra2tra2tra2tra2tra2tra2tra2tra2s=",
		)
		if (!event.known) return new Response(null, { status: 204 })
		switch (event.type) {
			case "order.shipped":
				console.log(event.data.orderId, event.data.shippedAt)
				return new Response(null, { status: 204 })
		}
	} catch (e) {
		if (e instanceof WebhookVerificationError) return new Response(null, { status: 401 })
		throw e
	}
}
```

Tested by: `emit/ts/webhooks.test.ts`, `emit/ts/runtime-features.test.ts`, kitchen's `tests/e2e/webhook.test.ts`
