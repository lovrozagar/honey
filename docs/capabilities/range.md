# Range requests

`rangeResponse(request, body)` from `@lovrozagar/honey/range` answers a `Range`
request with `206 Partial Content` and the slice it asked for, and every other request with the whole body and
`Accept-Ranges: bytes`. An unsatisfiable range answers 416, and an absurd one (a huge number, thousands of ranges)
falls back to the whole body at once. `staticFiles` uses it for every sized file.

## Example

```ts
import { honey } from "@lovrozagar/honey"
import { rangeResponse } from "@lovrozagar/honey/range"

const video = new Blob([new Uint8Array(1024)], { type: "video/mp4" })

const app = honey()

app.get("/video").handler((ctx) => ctx.res.raw(rangeResponse(ctx.req, video)))
```

Tested by: `response/range.test.ts`
