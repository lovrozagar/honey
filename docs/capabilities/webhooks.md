# Webhooks

The requests your API sends out are part of its contract too. Declare them as
`webhooks` when you serve the document, each with its body schema, and they appear under OpenAPI 3.1's `webhooks`.
The generated SDKs carry no webhook code yet.

## Example

```ts
import { honey } from "@lovrozagar/honey"
import { serveOpenApi } from "@lovrozagar/honey/openapi"
import * as z from "zod"

const app = honey()

serveOpenApi(app, {
	title: "Shop",
	version: "1.0.0",
	webhooks: {
		orderShipped: {
			body: z.object({ orderId: z.string(), shippedAt: z.string() }),
			summary: "An order left the warehouse",
		},
	},
})
```

Tested by: `openapi/webhooks.test.ts`

## Sending to the Standard Webhooks scheme

[`signWebhook`](../crypto.md#signing-a-webhook) signs a delivery to the Standard Webhooks scheme, and the receiver
verifies it with a Standard Webhooks library.
