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

Tested by: `errors/problem-json.test.ts`
