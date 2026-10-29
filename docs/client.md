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

TypeScript, Python, Go, Rust, C# and Java: all six SDKs.

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

In Python, `client.safe` (on `SDK` and `AsyncSDK` alike) answers `Ok(data, response)` or `Err(error, response)`,
frozen dataclasses to narrow with `match` or `isinstance`. `Err.error` is the instance the normal call raises: an
`APIStatusError` (its subclass by status, the body at `.body`) or a `DecodeError`, and `response` is the call's
`RawResponse`. A 2xx past `max_response_bytes` is a `DecodeError`; an error status past it keeps its status error,
its body unread. What has no answer raises in both styles, as in TS.

```python
async def health(client: AsyncSDK) -> str:
    match await client.safe.get_api_health():
        case Ok(data, response):
            return f"answered {response.status}: {data}"
        case Err(DecodeError() as unreadable, response):
            return f"answered {response.status}, unreadable: {unreadable}"
        case Err(error, response):
            return f"answered {response.status}: {error}"
```

In Go, `client.Safe()` holds the same resources, each method a field of its name (a `Call<n>`, `Stream<n>` or
`Conn<n>` over the normal method value) returning `(sdk.Result[T], error)` where the normal method returns
`(T, error)` (`sdk.Result[struct{}]` for one that answers no body). `Ok()` reports the data;
otherwise `Err` (an `error`) is what the normal method returns for that answer, a `*ClientError` or its per-status
type, or a `*DecodeError` (its `Err` the parse error, or `ErrResponseTooLarge` past `MaxResponseBytes`): read it with
`errors.As`. `Data` is the zero value on an Err. `Response` is the answer's on both. The method's own `error` is for no
answer alone. An event stream's twin opens it on the call (`Data` ranges once), and a WebSocket or realtime method is
the same one.

```go
func listing(ctx context.Context, client *sdk.Client) string {
	r, err := client.Safe().GetApi(ctx, nil)
	if err != nil {
		return fmt.Sprintf("no answer: %v", err) // never sent, refused, dropped, timed out or canceled
	}
	var unreadable *sdk.DecodeError
	var failed *sdk.ClientError
	switch {
	case r.Ok():
		return fmt.Sprintf("answered %d: %v", r.Response.StatusCode, r.Data)
	case errors.As(r.Err, &unreadable):
		return fmt.Sprintf("answered %d, unreadable: %v", r.Response.StatusCode, unreadable.Err)
	case errors.As(r.Err, &failed):
		return fmt.Sprintf("answered %d: %s", failed.StatusCode, failed.Key)
	}
	return r.Err.Error()
}
```

In Rust, `client.safe()` is the same client in the `Safe` style: the same resources and methods (each generic over
the client's style), each call resolving `Result<Answer<T>, Error>` where the normal one resolves `Result<T, Error>`.
`Answer::Ok { data, response }` holds the data; `Answer::Err { error, response }` holds what the normal call returns
as `Err` for that answer, a `SafeError::Api(ApiError)` for any error status (declared or not) or a
`SafeError::Decode(DecodeError)` for a 2xx, or a declared header, that does not read, a 2xx past `max_response_bytes`
included. Both arms carry the `RawResponse`. The outer `Err` is no answer alone. An event stream resolves once it
opens (`Answer::Ok`'s data is the `EventStream`), its error status at the opening the `Answer::Err`; a WebSocket or
realtime method is the same `Call` on both clients. `client.safe()` returns a client by value, so bind it
(`let safe = client.safe();`) to keep a resource of it.

```rust
async fn listing(client: &Client) -> String {
    match client.safe().get_api(&GetApiOpts::default()).await {
        Ok(Answer::Ok { data, response }) => format!("answered {}: {data:?}", response.status),
        Ok(Answer::Err {
            error: SafeError::Api(failed),
            response,
        }) => format!("answered {}: {}", response.status, failed.message()),
        Ok(Answer::Err {
            error: SafeError::Decode(unreadable),
            response,
        }) => format!("answered {}, unreadable: {unreadable}", response.status),
        Err(no_answer) => format!("no answer: {no_answer}"), // never sent, refused, timed out or canceled
    }
}
```

In C#, `client.Safe` mirrors the client (`client.Safe.<Group>.<Op>Async(…)`): each method takes the very parameters
and answers `Task<Result<T>>` where the normal one answers `Task<T>` (`Task<Result>` for one that answers no body),
calling the normal method. `IsOk` reports the answer, `Value` is it, and `Error` is what the normal method throws for
that answer, an `SdkException`: the status's `ApiStatusException` (`UnexpectedStatusException` for one without a class
of its own), or a `DecodeException` for a 2xx, or a declared header, that does not read, a 2xx past
`MaxResponseBytes` included. Reading `Value` on an Err, or `Error` on an Ok, throws `InvalidOperationException`;
`Match(onOk, onErr)` and `TryGetValue(out T)` never do. `Response` is the answer's `RawResponse` on both (the one
`RequestOptions.Raw` holds, when given). No answer still throws. An event stream's twin answers once it opens (`Value`
is the `EventStream<T>`), its error status at the opening the Err; a WebSocket or realtime method is the very method.

```csharp
    public static async Task<string> Listing(HoneySdkClient client, string id)
    {
        var result = await client.Safe.GetApiAsync(id); // no answer (never sent, refused, timed out, canceled) still throws
        return result.Match(
            found => $"answered {result.Response.Status}: {found}",
            error => error switch
            {
                DecodeException unreadable => $"answered {result.Response.Status}, unreadable: {unreadable.Message}",
                ApiStatusException failed => $"answered {failed.Status}: {failed.Key}",
                _ => error.Message,
            });
    }
```

In Java, `client.safe()` mirrors the client (`client.safe().<group>().<op>(…)`): each method takes the very
parameters, every overload of it, and answers `Result<T>` where the normal one answers `T` (`Result<Void>` for one that
answers no body), calling the normal method. `Result` is a sealed interface of two records with only their own
fields: `Result.Ok(data, response)` and `Result.Err(error, response)`. The `error` is what the normal method throws for
that answer, an `SdkException`: the status's `ApiException` subclass (`UnexpectedStatusException` for one without a
class of its own), or a `DecodeException` for a 2xx, or a declared header, that does not read, a 2xx past
`maxResponseBytes` included. The SDK targets Java 17, so narrow with `instanceof` patterns or `fold(onOk, onErr)`;
`isOk()` reports the arm and `orElseThrow()` returns the data or throws the Err's own error. `response()` is the
answer's `RawResponse` on both (the one `RequestOptions.raw` holds, when given). No answer still throws: a
`CancellationException` for the caller's interrupt, an `ApiTimeoutException`, an `ApiConnectionException`. An event
stream's twin answers once it opens (the Ok's data is the `EventStream<T>`), its error status at the opening the Err; a
WebSocket or realtime method is the very method.

```java
  static String listing(KitchenClient client) {
    // no answer (never sent, refused, timed out, canceled) still throws
    Result<ListApiResponse200> result = client.safe().getApi(GetApiParams.builder().build());
    int status = result.response().status();
    return result.fold(
        found -> "answered " + status + ": " + found,
        error ->
            error instanceof ApiException failed
                ? "answered " + status + ": " + failed.key()
                : "answered " + status + ", unreadable: " + error.getMessage());
  }
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
