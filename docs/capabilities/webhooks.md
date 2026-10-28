# Webhooks

The requests your API sends out are part of its contract too. Declare them as
`webhooks` when you serve the document: each one's body schema and, when you sign deliveries, its signature
(`hmac-sha256` in a header, hex or base64, with an optional prefix). They appear under OpenAPI 3.1's `webhooks`, and
the generated SDKs carry a typed payload parser and a signature check for the receiving side.

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
			signature: { algorithm: "hmac-sha256", encoding: "hex", header: "x-signature", prefix: "sha256=" },
			summary: "An order left the warehouse",
		},
	},
})
```

Tested by: `openapi/webhooks.test.ts`
