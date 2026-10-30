# dx — client (generated SDK consumer config)

Every generated SDK (TS/Go/Rust/Python/C#/Java) exposes the same consumer contract. Values below are uniform across languages (idiomatic spelling per language). Runtime glue is vendored (H9).

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| base url | no | the spec's `servers[0]` (B1) | where requests go | an env-specific base url overrides the default | `integration/ts-harness.test.ts` (+ per-lang harness) |
| auth (api key / bearer / custom) | no | — | sets the auth header from the spec's security scheme | the key must not be logged; redaction is on by default | `emit/*/http.auth.test.ts`, `emit/ts/auth-scheme.test.ts` |
| timeout | no | — | per-request deadline | a streaming/SSE call's timeout bounds its open (up to the headers, bit 19 b2), never the stream once open | per-lang harness |
| per-call overrides (base/timeout/headers) | — | inherit client | **[C2]** override per call | uniform across all SDKs in v1 | per-lang harness |
| raw response accessor | — | — | **[C2]** the underlying response (status, headers, body) | uniform across all SDKs in v1 | per-lang harness |
| typed response headers | — | — | **[A2]** declared headers typed on the response | only declared headers are typed | `response/response-headers.test.ts` |
| binary response | — | — | **[A1]** bytes/stream (`Uint8Array`/`[]byte`/`bytes`/`Stream`); sets `Accept` to the declared type | — | `emit/*/binary.test.ts` |
| SSE / WS client | — | — | typed event stream + WebSocket with `Last-Event-ID` reconnect [H8] | reconnect parity is uniform across SDKs | `integration/realtime.test.ts` |
| hooks (request/response) | — | — | observe/modify a call | they run on every HTTP call, SSE and long-poll opens included; no SDK's WebSocket dial runs one or refreshes on a 401 (auth goes in the client's credential or the call's headers) | per-lang harness, `emit/shared/runtime-docs.test.ts` |
| `client.safe` (the safe mirror) | — | always emitted | **[bit 21 i]** every op twice, in all six SDKs: the normal client throws on any failure, and the safe mirror answers a Result whose Ok carries the data and the response and whose Err carries the error (a declared error, an undeclared status, or a `DecodeError` for an undecodable or over-cap 2xx, a realtime send's answer included) and the response. TS `client.safe.<group>.<op>` → `{ ok: true, data, response } \| { ok: false, error, response }` with `error` an instance; Python `client.safe` → `Ok` / `Err` for `match`; Go `client.Safe()` → `Result[T]`, its Err an `error` (`errors.As`); Rust `client.safe()` → `Client<Safe>`, `Answer` / `SafeError<E>` (`Api(E)` or `Decode(DecodeError)`); C# `client.Safe` → `Result<T>` (`Value` on an Err throws); Java `client.safe()` → `Result` with `fold` / `orElseThrow`. A call with no answer (never sent, the connection, a timeout, a cancel, a stream dropped after it opened) throws in both styles (f2) | the old safe modes, `throwOnError` and TS's `TThrow` are gone, and code written for them fails to compile; a root resource named `safe` is emitted as `safe_` (`Safe_` in Go and C#) and a colliding Rust model as `<Name>Model`, each with one generation notice | `integration/conformance/safe.test.ts`, `emit/ts/error.safe.test.ts`, `emit/ts/types.safe.test.ts`, `emit/python/errors.safe.test.ts`, `emit/rust/errors.safe.test.ts`, `emit/csharp/errors.safe.test.ts`, `emit/java/errors.safe.test.ts` |

## Per-target behavior (bit 19 k1)

The contract above is uniform. These are the places a target does it its own way, each a decision, not a gap. A sentence
a user acts on is pinned in the runtime the SDK ships (`emit/shared/runtime-docs.test.ts`, `emit/java/sse.api.test.ts`).

### Ending a stream and freeing its connection (items 23, 24, 28)

| target | cancel carrier | what frees the connection |
| --- | --- | --- |
| TypeScript | `signal` (`AbortSignal`), merged with the client's and the timeout | leaving the `for await` early (a break, return or throw) cancels the body's reader |
| Go | `ctx` (`context.Context`) | the iterator closes the response body when its range ends, a break included |
| Rust | `cancel_on(future)`, and dropping the future | dropping the stream closes the connection |
| Python | `options["cancel"]` (an `asyncio.Event`), and task cancellation (`CancelledError`) | `async with`, or `aclose()`; a dropped stream frees it only when collected (CPython at once, PyPy or a cycle later) |
| C# | the method's `CancellationToken`, and each read's own | `await using`, leaving the loop, or reading to the end |
| Java | interrupting the reading thread (`CancellationException`); `close()` from any thread | try-with-resources: a for-each break without one keeps the connection |
| Java realtime | an interrupt drops the transport and reconnects from the cursor; `close()` ends it | `close()` |

### Wire and surface differences

| item | what differs | why it stands |
| --- | --- | --- |
| 3, close event | TS `on("close", (code, reason))`; Go the reason to the handler, the code in `Read`'s error (`websocket.CloseStatus`); Rust the reason plus `closed_by()`; Python `WsClose(code, reason)`; C# `Closed` with a `WsClose`; Java `onClosed(WsClose)` | each is the platform's own close shape; the code and reason reach every target |
| 13, C# response drain | the SDK's handler drains nothing (`MaxResponseDrainSize = 0`); a caller's own `HttpMessageHandler` passes through untouched | a caller's handler is the caller's to configure |
| 15 and 30, non-ASCII on the wire | Go's `json.Marshal` escapes `<`, `>`, `&`; C#'s System.Text.Json escapes non-ASCII and `<`, `>`, `&`, `'`, `+` and the backtick; the others send raw UTF-8, in a request body and a realtime send alike | all of it is valid JSON that decodes to the same value; the grid asserts the decoded value (`post-non-ascii`, `realtime-send-non-ascii`) |
| 21, Java restricted headers | `Connection`, `Content-Length`, `Expect`, `Host` and `Upgrade` belong to the JDK: naming one, in the client's or a call's headers, throws `ConfigException` | the JDK refuses them; failing by name beats a header silently not sent |
| 27, Java WebSocket handshake | the raw handshake a Java caller sees is the 101 with no headers; a 101 the JDK refused surfaces as its error | `java.net.http` exposes no handshake response |
| 29, Java realtime open | an open is bounded at 30 s (`ApiTimeoutException`, "no transport opened within"); a close is `CancellationException` | the realtime loop runs on its own thread, with no call deadline to borrow |
| Rust `default_headers` (Q9) | a caller-built `reqwest::Client`'s `default_headers` go on every hop, a cross-origin redirect included; credentials belong in `bearer_token`, `api_key` and `headers` | accepting a prebuilt client is kept; the lack is documented, never a credential leak by default |
| Java message cap | a message over 16 MiB closes 1008 ("Message too big") where the others close 1009 | the JDK lets a client send only 1000, 1001, 1008, 1011 and 3000–4999 |
