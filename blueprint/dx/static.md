# dx — static files

`staticFiles()` serves files from a directory or asset store (anyrow's cdn uses the response path). KEEP (bit 07 `response/static.ts`), with range (A3) and conditional GET (A4).

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| `staticFiles({ root })` | yes | — | serve files under `root` | path traversal (`..`, encoded separators) must be rejected — scope-bypass corpus [F1] | `response/static.test.ts` |
| content-type | — | by extension | sets `content-type` from the file extension (A1 open media types) | unknown extensions fall back to `application/octet-stream` | `response/static.test.ts` |
| Range / 206 | — | on for sized bodies | honors `Range`, emits `Accept-Ranges` + `Content-Range` (A3) | single range only; a multi-range request is served 200 full-body (no `multipart/byteranges`) | `response/range.test.ts` |
| ETag / Last-Modified | — | on | conditional GET: `If-None-Match` then `If-Modified-Since` (A4) | `Last-Modified` truncates to whole seconds; `If-None-Match` is evaluated before `If-Modified-Since` | `response/etag.test.ts`, `response/cache-control.test.ts` |
| cache-control | no | — | `Cache-Control` directives for static assets | immutable assets want `max-age` + `immutable` | `response/cache-control.test.ts` |
| index / fallthrough | no | — | directory index, SPA fallback | a fallback must not escape `root` | `response/static.test.ts` |
