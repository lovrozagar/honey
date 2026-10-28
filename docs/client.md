# Generated clients

Every generated SDK takes the same configuration: a base URL, the auth the spec's security scheme names,
a timeout, retries, hooks around each HTTP call, and per-call overrides. A failed call throws a typed error by
status, or, in safe mode, returns a result to inspect. The SDK recipes page shows each language's client in a
compiled example.

## Example

```sh
honey-codegen generate --spec openapi.json --target ts --out sdk
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
