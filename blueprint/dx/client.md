# dx — client (generated SDK consumer config)

Every generated SDK (TS/Go/Rust/Python/C#/Java) exposes the same consumer contract. Values below are uniform across languages (idiomatic spelling per language). Runtime glue is vendored (H9).

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| base url | no | the spec's `servers[0]` (B1) | where requests go | an env-specific base url overrides the default | `integration/ts-harness.test.ts` (+ per-lang harness) |
| auth (api key / bearer / custom) | no | — | sets the auth header from the spec's security scheme | the key must not be logged; redaction is on by default | `integration/sdk-harness/*-harness.test.ts` |
| timeout | no | — | per-request deadline | a streaming/SSE call has no timeout | per-lang harness |
| per-call overrides (base/timeout/headers) | — | inherit client | **[C2]** override per call | uniform across all SDKs in v1 | per-lang harness |
| raw response accessor | — | — | **[C2]** the underlying response (status, headers, body) | uniform across all SDKs in v1 | per-lang harness |
| typed response headers | — | — | **[A2]** declared headers typed on the response | only declared headers are typed | `response/response-headers.test.ts` |
| binary response | — | — | **[A1]** bytes/stream (`Uint8Array`/`[]byte`/`bytes`/`Stream`); sets `Accept` to the declared type | — | `integration/sdk-harness/*` |
| SSE / WS client | — | — | typed event stream + WebSocket with `Last-Event-ID` reconnect [H8] | reconnect parity is uniform across SDKs | `integration/realtime.test.ts` |
| hooks (request/response) | — | — | observe/modify a call | parity confirmed across SDKs | per-lang harness |
