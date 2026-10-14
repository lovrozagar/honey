# dx — input / output

`.input()` declares the request contract; `.output()` declares the per-status response contract. Both are standard-schema (zod/valibot/arktype/effect/yup). v1 opens the response media types and adds typed response headers (H10).

## Input

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| `.input({ params })` | no | — | typed, validated path params | validation runs after match; a bad value is a 4xx, not a miss | `input/params.test.ts` |
| `.input({ query })` | no | — | typed, validated query | arrays/coercion follow the schema, not ad-hoc parsing | `input/query.test.ts` |
| `.input({ headers })` | no | — | typed, validated request headers | header names are case-insensitive | `input/headers.test.ts` |
| `.input({ json })` | no | — | validated JSON body; asserts content-type | a wrong content-type is a 415 before validation | `input/json.test.ts` |
| `.input({ form })` | no | — | multipart / urlencoded body | file parts follow the body-limit | `input/form.test.ts` |
| `.input({ binary })` | no | off | **[A1]** raw bytes body with a declared content-type | bytes are not structurally validated; size/limit metadata may apply | `input/binary.test.ts` |
| body limit | no | app default | caps body size (`body-limit.ts`) | an unbounded stream without a limit is a DoS vector [F1] | `input/body-limit.test.ts` |

## Output

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| `.output({ "application/json": { [status]: schema } })` | no | — | typed, validated JSON response per status — **media type is the OUTER key, status the INNER** (matches v0; DX unchanged) | the inner status key is the SDK's return-type discriminator | `response/response.test.ts` |
| `.output` known media types (text/html, text/csv, text/xml, text/plain, application/pdf, application/cbor, application/msgpack, octet-stream, text/event-stream, redirect) | no | — | keep helper affinity (stringify / stream / binary / redirect) | the 11 keep their helpers; everything else is a bytes body | `response/media-type.test.ts` |
| `.output` open media type `` `${string}/${string}` `` | no | — | **[A1]** any media type (image/gif, font/woff2, video/\*, application/zip) as a typed bytes body `{ format: binary }` carrying its content-type to OpenAPI/SDKs/CLI/MCP | multiple types per status negotiate via `Accept` | `response/media-type.test.ts`, `integration/streaming.test.ts` |
| `.output` per-status `headers` schema | no | — | **[A2]** declared, typed response headers → OpenAPI response `headers` → SDK `response.headers` accessors (ETag, Location, Retry-After, X-RateLimit-\*, Link) | an undeclared header is not in the contract | `response/response-headers.test.ts` |
| `ctx.res.json/text/html/redirect` | — | — | build the response with helper affinity | — | `response/response.test.ts` |
| `ctx.res.binary(statusKey, bytes, opts?)` | — | `application/octet-stream`; `opts.contentType` names any other declared type, required by the types unless octet-stream is declared | **[A1]** typed bytes response, the bytes kept as the raw body | bytes are a type contract, never validated; the content type still counts for the mismatch check | `response/binary.test.ts` |
| `ctx.res.sse(...)` | — | — | `text/event-stream`; v1 types the declared event schema [H8] | reconnect uses `Last-Event-ID` | `response/sse.test.ts`, `integration/streaming.test.ts` |
| `ctx.res.raw(response)` | — | — | untyped escape hatch; passes any `Response` | invisible to OpenAPI/SDKs — prefer a declared type | `response/response.test.ts` |
| range / 206 | no | off | **[A3]** `Accept-Ranges` + honored `Range` for binary/stream + static | partial content needs the body to be seekable/sized | `response/range.test.ts` |
| `Last-Modified` / `If-Modified-Since` | no | off | **[A4]** time-based conditional GET beside ETag | weak vs strong validator semantics | `response/cache-control.test.ts` |

## Errors

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| `defineErrors({...})` / `HoneyError` | — | — | typed error factory; serialized as honey error-key JSON | the error key is the SDK's typed error discriminator | `errors/errors.test.ts`, `integration/errors.test.ts` |
| problem+json formatter | no | off | **[A7]** opt-in RFC 9457 `application/problem+json` | native model stays the default; opt in per app | `errors/problem-json.test.ts` |
