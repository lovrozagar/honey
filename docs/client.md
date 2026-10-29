# Generated clients

Every generated SDK takes the same configuration: a base URL, the auth the spec's security scheme names,
a timeout, retries, hooks around each HTTP call, and per-call overrides. A failed call throws a typed error by
status; the client's safe mirror answers the same calls as a result instead (below). The SDK recipes page shows
each language's client in a compiled example.

## Example

```sh
honey-codegen generate --spec openapi.json --target ts --out sdk
```

## Errors and the safe mirror

TypeScript today; the other SDKs as their phases land.

- **The normal call** answers its value and throws on any failure: an error status as its typed error
  (`NotFoundError` and so on, each a `ClientError`), and an undecodable or over-cap 2xx as a `DecodeError`.
- **`client.safe`** holds the same calls (`client.safe.<group>.<op>`), each answering a `Result`. On `ok` it is
  `{ ok: true, data, response }`, with the declared response headers as `headers` when the operation has any. Otherwise
  it is `{ ok: false, error, response }`: the error is the instance the normal call would throw, the parsed body at
  `error.body`. A declared status narrows `error.status` and `error.body`; any other status is the base `ClientError`,
  its body `unknown`; a `DecodeError` holds the raw text as its body (null past the size cap) and the parse error as
  its `cause`.
- **No answer throws in both styles** (f2): a call never sent (a path param that cannot form a path), a refused or
  dropped connection (`APIConnectionError`), a timeout, a cancel, and a stream that drops after it opened. An event
  stream's safe call resolves once it opens, its error status at the opening the `Err`; a WebSocket or realtime
  operation is the same connection on `client.safe`.

```ts sdk
import { DecodeError, Kitchen } from "./kitchen"

const client = new Kitchen({ baseURL: "https://api.example.com" })
const result = await client.safe.getApiV1OrganizationsByOrgId({ params: { orgId: "org-1" } })
if (result.ok) console.log(result.data, result.response.status)
else if (result.error instanceof DecodeError) console.error("unreadable answer", result.error.body)
else if (result.error.status === 404) console.error("no such organization", result.error.body)
else console.error("answered", result.error.status)
```

## Reference

| Value                                     | Default                      | What it does                                                                              | Watch for                                                                                                                                                                          |
| ----------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| base url                                  | the spec's `servers[0]` (B1) | where requests go                                                                         | an env-specific base url overrides the default                                                                                                                                     |
| auth (api key / bearer / custom)          | —                            | sets the auth header from the spec's security scheme                                      | the key must not be logged; redaction is on by default                                                                                                                             |
| timeout                                   | —                            | per-request deadline                                                                      | a streaming/SSE call's timeout bounds its open (up to the headers, bit 19 b2), never the stream once open                                                                          |
| per-call overrides (base/timeout/headers) | inherit client               | override per call                                                                         | uniform across all SDKs in v1                                                                                                                                                      |
| raw response accessor                     | —                            | the underlying response (status, headers, body)                                           | uniform across all SDKs in v1                                                                                                                                                      |
| typed response headers                    | —                            | declared headers typed on the response                                                    | only declared headers are typed                                                                                                                                                    |
| binary response                           | —                            | bytes/stream (`Uint8Array`/`[]byte`/`bytes`/`Stream`); sets `Accept` to the declared type | —                                                                                                                                                                                  |
| SSE / WS client                           | —                            | typed event stream + WebSocket with `Last-Event-ID` reconnect                             | reconnect parity is uniform across SDKs                                                                                                                                            |
| hooks (request/response)                  | —                            | observe/modify a call                                                                     | they run on every HTTP call, SSE and long-poll opens included; no SDK's WebSocket dial runs one or refreshes on a 401 (auth goes in the client's credential or the call's headers) |
