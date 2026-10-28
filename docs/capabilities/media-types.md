# Open media types and response headers

A route may answer any media type, not only
JSON and text: `image/png`, `font/woff2`, `application/zip`, `video/*`. Declare it in `.output()` and answer with
`ctx.res.binary()`. A status may also declare its response headers; they reach the OpenAPI document and the SDKs'
typed response-header accessors, and an undeclared header is not typed.

## Example

```ts
import { honey } from "@lovrozagar/honey"
import * as z from "zod"

const app = honey()

app
	.get("/avatar/:id")
	.output({
		"image/png": { ok: z.instanceof(Uint8Array) },
		headers: { ok: z.object({ etag: z.string() }) },
	})
	.handler((ctx) =>
		ctx.res.binary("ok", new Uint8Array([137, 80, 78, 71]), { contentType: "image/png", headers: { etag: '"v1"' } }),
	)
```

Tested by: `response/media-type.test.ts`, `integration/security/media-type.fuzz.test.ts`
