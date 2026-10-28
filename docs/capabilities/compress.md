# Compression

`compress()` from `@lovrozagar/honey/compress` gzips an answer when the client
accepts it and the body is compressible (text, JSON, XML, JavaScript, SVG) and over `threshold` bytes (1024 by
default). It leaves alone a body already encoded, a streamed one and an image or archive. To stay safe from BREACH,
it skips answers to credentialed requests and answers that set a cookie, unless `credentialed: true`. Serve brotli
from precompressed static files (`staticFiles({ precompressed: true })`) rather than on the request path.

## Example

```ts
import { honey } from "@lovrozagar/honey"
import { compress } from "@lovrozagar/honey/compress"

const app = honey().use(compress({ threshold: 2048 }))

app.get("/report").handler((ctx) => ctx.res.text("ok", "row\n".repeat(5000)))
```

Tested by: `middleware/compress.test.ts`
