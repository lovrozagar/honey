# Static files

`staticFiles({ resolve })` from `@lovrozagar/honey/static` serves files from wherever they live: a disk, a
bucket, a Workers asset binding. `resolve(ctx, filePath)` returns a `Response`, a body (`Blob`, bytes or a ranged
source), or `null` to fall through to the next handler. The content type comes from the extension, `Range`
requests get 206 partial answers, and conditional GETs (`If-None-Match`, `If-Modified-Since`) answer 304.
`rewritePath` maps `/` to `/index.html` for a single-page app, and `precompressed` serves a `.br` or `.gz` sibling.

## Example

```ts
import { honey } from "@lovrozagar/honey"
import { cacheControl } from "@lovrozagar/honey/cache-control"
import { staticFiles } from "@lovrozagar/honey/static"

const assets = new Map<string, Blob>([["/app.js", new Blob(["console.log(1)"])]])

const app = honey()
	.use(cacheControl({ public: true, maxAge: 3600 }))
	.use(staticFiles({ prefix: "/assets", resolve: (_ctx, path) => assets.get(path) ?? null }))
```

## Reference

| Value                                                                       | Default             | What it does                                                                                                                                                                                                                                                                                                           | Watch for                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `staticFiles({ resolve, prefix?, headers?, rewritePath?, precompressed? })` | —                   | middleware around `resolve(ctx, filePath)` → a `Response` (passed through) or a body (`Blob`/`RangeSource`/bytes → ranged + typed here). `resolve` is **a callback, not a `root` string**, so it is runtime-agnostic (Workers ASSETS, `Bun.file`, node fs, KV) — a `root` dir would force `node:fs` into portable core | `filePath` is the once-decoded `ctx.path` with no `.`/`..`/empty/NUL/`:`/separator segments, a whole-segment `prefix`, and a `rewritePath` result re-checked — traversal never reaches `resolve` |
| content-type                                                                | by extension        | sets `content-type` from the file extension                                                                                                                                                                                                                                                                            | unknown extensions fall back to `application/octet-stream`                                                                                                                                       |
| Range / 206                                                                 | on for sized bodies | honors `Range`, emits `Accept-Ranges` + `Content-Range`                                                                                                                                                                                                                                                                | single range only; a multi-range request is served 200 full-body (no `multipart/byteranges`)                                                                                                     |
| ETag / Last-Modified                                                        | on                  | conditional GET: `If-None-Match` then `If-Modified-Since`                                                                                                                                                                                                                                                              | `Last-Modified` truncates to whole seconds; `If-None-Match` is evaluated before `If-Modified-Since`                                                                                              |
| cache-control                                                               | —                   | `Cache-Control` directives for static assets                                                                                                                                                                                                                                                                           | immutable assets want `max-age` + `immutable`                                                                                                                                                    |
| index / fallthrough                                                         | —                   | directory index, SPA fallback                                                                                                                                                                                                                                                                                          | a fallback must not escape `root`                                                                                                                                                                |
