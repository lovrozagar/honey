# Problem+JSON errors

`app.errorFormat("problem+json")` answers every error as RFC 9457
`application/problem+json`: the error key as its `type`, the status's reason phrase as its `title`, the message as
its `detail`, field errors under `errors`, and the request id as `instance`. The default format stays honey's own
error JSON, and the OpenAPI document and SDKs follow the format you choose.

## Example

```ts
import { defineErrors, honey } from "@lovrozagar/honey"

const errors = defineErrors({ out_of_stock: "conflict" })

const app = honey().errorFormat("problem+json")

app
	.post("/orders")
	.errors(errors, "out_of_stock")
	.handler(() => {
		throw errors.out_of_stock()
	})
```

## With your own formatters

`defaultErrorFormatter` gets the Problem Details document as its default body, so what it adds lands in the document
and the answer stays `application/problem+json`. An error `defineErrors` gave a payload schema keeps its declared body
under either format: `payloadErrorFormatter` shapes that body, and it answers `application/json`.

```ts
import { defineErrors, honey } from "@lovrozagar/honey"
import * as z from "zod"

const errors = defineErrors({
	out_of_stock: { schema: z.object({ sku: z.string() }), status: "conflict" },
	sold_out: "gone",
})

const app = honey()
	.errorFactory(errors)
	.errorFormat("problem+json")
	.defaultErrorFormatter((error, problem) => ({ ...problem, retriable: error.status >= 500 }))
	.payloadErrorFormatter((_error, data) => ({ ...data, docs: "https://example.com/errors" }))
```

Tested by: `errors/problem-json.test.ts`, `integration/error-envelope.test.ts`
