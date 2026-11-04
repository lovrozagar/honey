# Migrating from 0.7 to 1.0

Each deliberate break from v0 0.7.x, with what you wrote before and what you write now. A "before" block is v0 and
is shown as it was; an "after" block is v1 and is compiled by the docs' tests. The SDK examples call a client
generated from a small example API (`Kitchen`); yours is named after your document.

The SDK sections cover the four SDKs 0.7.3 shipped: TypeScript, Python, Go and Rust. The C# and Java SDKs are new
in 1.0, so they migrate nothing; their client is documented in [the generated clients page](client.md).

## From 1.0.0-rc.20 to 1.0.0-rc.21

An app already on a 1.0 release candidate starts here. Each row is one break, what rc.20 wrote and what rc.21
writes. Where a section of this guide already shows it, the row names that section, whose "before" block is the
same code an rc.20 app has; the breaks no section shows follow the table, each with its example. A `ts rc.20` or
`sh rc.20` block is rc.20 code, shown as text.

| rc.20                                                                                                                                          | rc.21                                                                                                                                           | Shown in                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `defineMiddleware({ errors, fn })`                                                                                                             | `createMiddleware(fn, { errors, meta })`                                                                                                        | `defineMiddleware` is `createMiddleware(fn, { errors, meta })`                           |
| `DefaultMeta`, `OpenApiMeta`                                                                                                                   | `HoneyMeta`, and `HoneyMeta<RouteMeta>` for your own keys                                                                                       | `DefaultMeta` and `OpenApiMeta` are `HoneyMeta`                                          |
| `app.meta<T>(values)`, one call declaring and setting                                                                                          | `metaType<T>()` declares, `meta(values)` sets                                                                                                   | `meta<T>()` is `metaType<T>()`, and a route need not repeat a meta default               |
| any `x-` key in `meta.extensions`                                                                                                              | the keys your meta type and a strict metaSpec list                                                                                              | `meta.extensions` keys are checked                                                       |
| any `Response` from a handler, `ctx.res.raw` under `.output()`                                                                                 | what `.output()` declares; a stream through the declared type's helper                                                                          | A handler returns only what `.output()` declares                                         |
| `ctx.res.json("ok", body, { status: 201 })`, `ctx.res.redirect(url, { status })`                                                               | the status key alone: `ctx.res.json("created", body)`, `redirect(statusKey, url)`                                                               | A status is a key: no `status` option, and `redirect(statusKey, url)`                    |
| `.input({ params: z.object({...}) })`, read on `ctx.input.params`                                                                              | `.input({ params: { name: schema } })`, read on `ctx.params`                                                                                    | `params` is a schema per path param, onto `ctx.params`                                   |
| `readableStream()`, `ReadableStreamSchema`, on any source; `proxy({ rewriteUrl: (url) => … })`                                                 | `streamed()`, `StreamedSchema`, on a body only; `rewriteUrl: (ctx, url) => …`                                                                   | `readableStream()` is `streamed()`, for a body only                                      |
| `app.routeTree(tree)` loads the tree into `app`, before any route                                                                              | `routeTree(tree)` returns a new app, at any point                                                                                               | `routeTree()` returns a new app, callable at any point                                   |
| `@lovrozagar/honey/errors`: `defineErrors`, `ERROR_META`, `ErrorMetaEntry`, `ErrorFactories`                                                   | the root's `defineErrors`, `ERROR_META`, `ErrorMetaEntry`; `typeof errors` for a factory's type                                                 | One import path per name                                                                 |
| `@lovrozagar/honey/openapi`'s `scalar`, `swagger`, `serveStaticOpenApi` and its types                                                          | `@lovrozagar/honey/openapi/scalar`, `@lovrozagar/honey/openapi/swagger`, `@lovrozagar/honey/openapi/static`                                     | One import path per name                                                                 |
| `@lovrozagar/honey/tree`'s tree builders                                                                                                       | the tree's types only; honey builds the tree                                                                                                    | One import path per name                                                                 |
| `honey()` from `@lovrozagar/honey/plugin` or `@lovrozagar/honey/build`, its config types from `@lovrozagar/honey/build`                        | `honeyPlugin()` and its config types from `@lovrozagar/honey/plugin`                                                                            | The Vite plugin is `honeyPlugin()`                                                       |
| `customErrorFormatter()`, `CustomErrorFormatter`, `createErrorResponse`                                                                        | `payloadErrorFormatter()`, `PayloadErrorFormatter`; an error answers through `throw`                                                            | `customErrorFormatter()` is `payloadErrorFormatter()`, and `createErrorResponse` is gone |
| an output's `securitySchemes`, `sanitize.stripSecurityRequirements`, `sanitize.stripSecuritySchemes`, a YAML twin                              | `codegen.securitySchemes` once, each output's `security`, its `formats`                                                                         | Codegen declares security schemes once; each document lists the ones it shows            |
| `sign`, `verify`, `SignOptions`, `VerifyOptions`, `legacy`                                                                                     | `createCookieSigner({ name, secrets })`, `CookieSignerOptions`                                                                                  | `createCookieSigner({ name, secrets })` signs one cookie                                 |
| `errorI18n(config)`, `ErrorI18nConfig`                                                                                                         | `createErrorTranslator(config)`, `ErrorTranslatorConfig`                                                                                        | `.errorI18n(config)` takes `createErrorTranslator(config)`                               |
| `InferInputMap` from `@lovrozagar/honey/input`                                                                                                 | `InferInputMap` from `@lovrozagar/honey`                                                                                                        | below                                                                                    |
| `memoryStore`, `MemoryStore`, `MemoryStoreOptions`                                                                                             | `memoryRateLimitStore`, `MemoryRateLimitStore`, `MemoryRateLimitStoreOptions`                                                                   | below                                                                                    |
| `@lovrozagar/honey/serve`'s `serve`, `ServeOptions`, `ServeHandle`, `DEFAULT_MAX_REQUEST_BODY`; `detectRuntime`, `ServeRuntime`, `HoneyServer` | `serve` from `@lovrozagar/honey/node` (`NodeServeOptions`) or `@lovrozagar/honey/bun` (`BunServeOptions`, `BunServer`), each with `ServeHandle` | below                                                                                    |
| `RouteTreeV2` from `@lovrozagar/honey-clients`                                                                                                 | `RouteTree`                                                                                                                                     | below                                                                                    |
| `generated()` answering `GeneratedFiles`, each target's files                                                                                  | `generated()` answering `Generated`, each target's `files` and `packages`; `writeTarget(dir, files, packages)`                                  | below                                                                                    |
| any Go or CLI module path                                                                                                                      | one Go would publish: a domain first, and a major suffix only from `/v2`                                                                        | below                                                                                    |
| the Java target's own default group, artifact, package and client                                                                              | `com.example`, `sdk` and `ExampleClient`                                                                                                        | below                                                                                    |

### `memoryStore` is `memoryRateLimitStore`, and `InferInputMap` comes from the root

Both are renamed or moved, nothing else: the store's options and answers are the same.

```ts rc.20
import { type InferInputMap } from "@lovrozagar/honey/input"
import { memoryStore, rateLimit } from "@lovrozagar/honey/rate-limit"
const limited = rateLimit({ limit: 60, store: memoryStore({ windowMs: 60_000 }) })
```

```ts
import type { InferInputMap } from "@lovrozagar/honey"
import { memoryRateLimitStore, rateLimit } from "@lovrozagar/honey/rate-limit"

export type Inputs<T> = InferInputMap<T>
export const limited = rateLimit({ limit: 60, store: memoryRateLimitStore({ windowMs: 60_000 }) })
```

### `@lovrozagar/honey/serve` is gone: serve from your runtime's entry

`serve` comes from `@lovrozagar/honey/node` or `@lovrozagar/honey/bun`, which no longer detect the runtime, and each
answers a `ServeHandle` with the runtime's own server on `server`. `HoneyServer` is that handle, and `detectRuntime`
and `ServeRuntime` go with the detection. A test client's `transport` takes that `serve` instead of `"serve"`.

```ts rc.20
import { serve } from "@lovrozagar/honey/serve"
const server = await serve(app, { port: 3000 })
const client = testClient(app, { env, transport: "serve" })
```

```ts
import { honey } from "@lovrozagar/honey"
import { serve } from "@lovrozagar/honey/node"
import { testClient } from "@lovrozagar/honey/testing"

const app = honey()
const server = await serve(app, { port: 0 })
await server.close()
export const client = testClient(app, { env: {}, transport: serve })
```

### `RouteTreeV2` is `RouteTree`, and `generated()` answers each target's files and packages

`@lovrozagar/honey-clients` names the route tree `RouteTree`, as core does. `generated()` answers `Generated`, a
`GeneratedTarget` per target: its `files` by path, and the `packages` it makes on each registry it publishes to, which
`writeTarget(dir, files, packages)` records in the directory's `.honey-generated.json`. `GeneratedFiles` is gone.

```ts rc.20
import { generated, type GeneratedFiles, type RouteTreeV2, writeTarget } from "@lovrozagar/honey-clients"
const files: GeneratedFiles = await generated(run, document, ctx)
writeTarget("sdk/ts", files.ts ?? {})
```

```ts
import { generated, type GenerateRun, type RouteTree, writeTarget } from "@lovrozagar/honey-clients"

export type Tree = RouteTree
const run: GenerateRun = { options: { ts: { name: "ShopSDK", stem: "shop" } }, targets: ["ts"] }
const document = { info: { title: "Shop", version: "1.0.0" }, openapi: "3.1.0", paths: {} }
const out = await generated(run, document, { env: {}, report: () => undefined })
if (out.ts !== undefined) writeTarget("sdk/ts", out.ts.files, out.ts.packages)
```

### Java defaults to `com.example`, and a Go module path is one Go would publish

The Java target's defaults are the neutral `com.example` group and package, the `sdk` artifact and `ExampleClient`;
pass yours. A Go or CLI module path is checked as Go checks one: a domain first, and a major suffix only from `/v2`.
`--go-version` (and `--cli-version`) is new: from v2 on it adds the suffix to the base path, so a path that already
carries one is refused beside it.

```sh rc.20
npx honey-clients generate --spec openapi.json --target java
```

```sh
npx honey-clients generate --spec openapi.json --target java --java-group-id com.acme --java-artifact-id shop-sdk \
  --java-package-name com.acme.shop --java-client-name ShopClient
npx honey-clients generate --spec openapi.json --target go --go-module-path github.com/acme/shop/sdk --go-version 2.1.0
```

## Code generation moved to `@lovrozagar/honey-clients`

The `@lovrozagar/honey/codegen` export is gone. Its SDK, CLI and MCP generators are the `honey-clients generate` bin
and its module API. Only v0's document-level `mergeSpecs` and `scopeSpec` are removed: several honey services still
combine through `mergeTree` over their route trees, and one merged tree still emits several documents, each with its
own `securitySchemes` and `filterRoutes`. Merging a third-party document is planned after 1.0.

```ts v0
import { generateSdk, mergeSpecs } from "@lovrozagar/honey/codegen"
```

```sh
honey-clients generate --spec openapi.json --target ts --out ./sdk
```

## `--app` takes a module that exports the app

`honey-clients generate --app` and `honey generate --app` import a module that exports the app and binds nothing.
v0's no-bind flag has no counterpart, because v1 never serves on import.

```ts v0
const app = honey()
app.serve({ port: 3000 })
```

```ts
import { honey } from "@lovrozagar/honey"

export const app = honey()
app.get("/health").handler((ctx) => ctx.res.text("ok", "up"))
```

## The TS SDK always throws; its safe mode is `client.safe`, answering a Result

A TS client, the SDK class and the app's `createClient` alike, has no `throwOnError` and no `<true>`: delete both, as
that client is the one every call now uses. It throws a typed error per status. An unconfigured client was safe
before, so a call that read `{ data, error }` now throws; move it to `client.safe`, which holds the same calls, each
answering a `Result` to narrow on `ok`:

- `if (error)` / `if (r.error)` becomes `if (!r.ok)`, and `r.status` becomes `r.response.status`.
- The Err arm's `error` is the error the call would have thrown, by status (`NotFoundError` and so on), never the
  parsed body: the body is `error.body`, and a declared status narrows `error.status` and `error.body` once
  `DecodeError` is ruled out.
- An undecodable 2xx is a `DecodeError` (a `ClientError` holding the raw text and, as `cause`, the parse error): the
  call throws it, and the safe call answers it as an Err.
- A call that cannot be built (a path param that cannot form a path) was a status-0 result; it throws in both now,
  like any call with no answer.
- An event stream's safe call resolves once the stream opens: the Ok arm's data is the stream, and an error status at
  its opening is the Err. A WebSocket or realtime operation is the same connection on `client.safe`.
- `SDKResult`, `ClientResult` and `HTTPClient.requestSafe` are gone, as are `requestAuto`'s mode argument and the
  `<TThrow>` of each config, class and `HoneyClient` type. A root resource named `safe` is reached as `safe_`.

A response type of your own with both a `data` and an `error` field still destructures under the old pattern, so tsc
cannot flag it: search for `.error` reads on your calls by hand if your API answers such a shape.

```ts v0
const client = new Kitchen({ baseURL: "https://api.example.com" })
const { data, error, status } = await client.getApiHealth()
if (error) console.error("answered", status)
else console.log(data)
```

```ts sdk
import { DecodeError, Kitchen } from "./kitchen"

const client = new Kitchen({ baseURL: "https://api.example.com" })
const result = await client.safe.getApiHealth()
if (!result.ok) {
	const why = result.error instanceof DecodeError ? "an unreadable body" : result.error.status
	console.error("answered", result.response.status, why)
} else console.log(result.data)
```

## The Python SDK's `throwOnError` is gone; its safe mode is `client.safe`, answering `Ok` or `Err`

The Python generator has no `throwOnError` option: delete it.
Every client raises, as the default did; the safe mode is `client.safe` on `SDK` and `AsyncSDK`, which holds the same
calls:

- `SDKResult` is gone. A safe call answers `Ok(data, response)` or `Err(error, response)`: replace `r.error` checks
  with `match r` (`case Ok(data): …` / `case Err(error): …`) or `isinstance(r, Err)`, and `r.status` with
  `r.response.status`. Reading `.data` or `.error` off a normal call, or naming `SDKResult`, fails `mypy --strict`.
- `Err.error` is the error the normal call raises: an `APIStatusError` by status, or a `DecodeError`. An undecodable
  2xx decoded to `None` before, silently, whichever mode; it raises a `DecodeError` now, and is the `Err` on
  `client.safe`.
- An event stream's safe call answers once it opens: `Ok`'s data is the `EventStream`, an error status at the opening
  the `Err`. A WebSocket or realtime operation is the same connection on `client.safe`.
- A root resource named `safe` is reached as `safe_`, and the generation names it on stderr.

```text v0
r = client.users.get("u1")   # generated with throwOnError false
if r.error is not None:
    print("answered", r.status)
else:
    print(r.data)
```

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

## The Go SDK's `throwOnError` is gone; its safe mode is `client.Safe()`, answering a `Result`

The Go generator has no `throwOnError` option: delete it. Every
method returns its answer or an error, as the default did; the safe mode is `client.Safe()`, which holds the same
resources, each method a field of its name you call the same way:

- `SDKResult` is gone. A safe method returns `(sdk.Result[T], error)`, `T` what the normal method returns (`*User`,
  `[]byte`, `string`, `struct{}` for no body). `OK()` is `Ok()`, `r.Status` is `r.Response.StatusCode`, and `Data` is
  the zero value on an Err. Naming `sdk.SDKResult`, or calling `.Status()` on `r.Err`, fails `go build`.
- `Err` was an `APIError`; it is an `error` now, holding the error the normal method returns for that answer: reach
  `*sdk.ClientError`, its per-status type or `*sdk.DecodeError` with `errors.As`. An undecodable 2xx was the second
  return value in safe mode; it is the `Err` now, with its response. The normal method returns it as a
  `*sdk.DecodeError` (its message unchanged, `honey: decode response: …`; `Unwrap` the parse error).
- A 2xx past `MaxResponseBytes` was the transport error `honey: http do: …ErrResponseTooLarge`; it is a
  `*sdk.DecodeError` in both styles, `errors.Is(err, sdk.ErrResponseTooLarge)` still true. An error status past the cap
  returns its status error, its body empty.
- An event stream that drops after it opened yielded a bare `io.ErrUnexpectedEOF`; it yields the wrapped
  `honey: http do: unexpected EOF` a call's dropped body gives (`errors.Is(err, io.ErrUnexpectedEOF)` still true).
- An event stream's safe twin opens the stream on the call: an error status at the opening is the `Err`, and `Data`
  ranges the opened stream once. A WebSocket or realtime method is the same one on `client.Safe()`.
- A realtime connection's `Send` over SSE or long-poll returned `sse transport is receive-only` (only the WebSocket
  transport sent); both POST on the open connection now, a string as text and any other value as JSON. The POST is
  answered as a call is, so a 2xx past `MaxResponseBytes` is a `*sdk.DecodeError`; a dial's answer past the cap is
  still no answer.
- A root resource or method named `safe` is emitted as `Safe_` (`Safe` is the mirror), and the generation names it on
  stderr.

```text v0
res, err := client.Users.Get(ctx, "u1", nil) // generated with throwOnError false
if err == nil && !res.OK() {
	fmt.Println("answered", res.Status, res.Err.Status())
}
```

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

## The Rust SDK's `throwOnError` is gone; its safe mode is `client.safe()`, answering an `Answer`

The Rust generator has no `throwOnError` option: delete it. Every
method resolves `Result<T, Error>`, as the default did; the safe mode is `client.safe()`, the same client whose calls
resolve `Result<Answer<T>, Error>`:

- `SdkResult` is gone, and with it `data: Option<T>`, `error: Option<E>` (`E` defaulting to `Error`), `status` and
  `ok()`. Match the `Answer`: `Answer::Ok { data, response }`, or `Answer::Err { error, response }` with `error` a
  `SafeError::Api` or `SafeError::Decode`. `r.status` is `response.status`. Naming `sdk::SdkResult`, or reading
  `.error`, `.status` or `.ok()` on what a call resolves, fails `cargo check`.
- An undecodable body was `Error::Json`, the serde error through `From`. It is `Error::Decode(DecodeError)` now on
  the client, and `Answer::Err { error: SafeError::Decode(..), response }` on `client.safe()`: match
  `Error::Decode(e)` and read `e.to_string()`.
- A body past `max_response_bytes` was `Error::Other("response body exceeds N bytes")`; a 2xx past it is
  `Error::Decode` now on the client and `SafeError::Decode` on `client.safe()`. An error status past the cap is its
  `Error::Api`, its body empty.
- `RealtimeError` is gone: a realtime connection's `send`/`send_text` answers `Result<(), Error>`, and the send is a
  POST answered as a call is, so its 2xx past the cap is `Error::Decode`. A dial's answer past the cap is still
  `Error::Transport`, no answer.
- An event stream ignored the mode; on `client.safe()` it resolves `Answer::Ok` with the `EventStream`, an error
  status at the opening its `Answer::Err`. A WebSocket or realtime method is the same `Call` on both clients.
- `Client`, every `<Path>Resource` and `Call` take the style: `Client<S = Throw>`, `<Path>Resource<'a, S = Throw>`,
  `Call<T, S = Throw, H = ()>`. Code naming `Call<T, H>` with typed headers names `Call<T, Throw, H>` now.
- A root resource or method named `safe` is emitted as `safe_` (`safe()` is the mirror), and the generation names it
  on stderr. A component of your document named `S` (the style parameter) or like one of the new runtime types
  (`Answer`, `SafeError`, `DecodeError`, `Style`, `Safe`, `Throw`) is emitted as `<Name>Model`, as every runtime- or
  prelude-named one already was, and the generation names each such rename on stderr.

```text v0
let r = client.users().get("u1", &Default::default()).await?; // generated with throwOnError false
if !r.ok() {
    println!("answered {} {:?}", r.status, r.error);
}
```

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

## The TS SDK's realtime `token?` and `onAuthExpired?` are gone

Neither was ever read. A connection's `headers` may be a function read on every dial, and the client's
`onAuthExpired` is the one refresh hook.

```ts v0
client.chat.connect({ token: "t", onAuthExpired: () => refresh() })
```

```ts sdk
import { Kitchen } from "./kitchen"

const refresh = async () => "new-token"
const client = new Kitchen({ baseURL: "https://api.example.com", onAuthExpired: refresh })
```

## The TS SDK reads the spec's security scheme for its auth header

As every other SDK does: an `apiKey` scheme's header with no prefix, bearer as `Authorization: Bearer`. A caller's
`authHeaderName` alone no longer implies `Bearer `; set `authHeaderPrefix` to keep one.

```ts v0
new Client({ authHeaderName: "x-token" })
```

```ts sdk
import { Kitchen } from "./kitchen"

const client = new Kitchen({
	baseURL: "https://api.example.com",
	authHeaderName: "x-token",
	authHeaderPrefix: "Bearer ",
})
```

## WebSocket keepalive is on by default

Every SDK pings every 20 s and ends the connection when a pong does not come within the interval. Go
`Config.WSKeepalive` and `TransportOpts.KeepAlive`, Rust `ws_keepalive` and Python `ws_keepalive` set it. The bare
TS `createResumableConnection`'s `keepaliveInterval` defaults to 20 s (0 turns it off), while the SDK-built realtime
connection defaults to 0, because a browser WebSocket has no control ping. `keepaliveOf` is exported.

```ts v0
createResumableConnection({ transports, keepaliveInterval: 20_000 })
```

```ts sdk
import { createResumableConnection, type TransportAdapter } from "./live"

declare const transports: TransportAdapter[]
const connection = createResumableConnection({
	url: "https://api.example.com/prices",
	transports,
	keepaliveInterval: 0,
})
```

## A realtime open is terminal when every transport refused it

An open ends when every transport refused it (400, 401 after the one refresh, 403, 404, 405, 410, 422), with the most
specific refusal as the error. A transient failure (408, 429, 5xx, a transport error) still backs off and retries, and
a refused WebSocket upgrade still falls through to SSE and long-poll.

```ts v0
connection.on("error", () => connection.reconnect())
```

```ts sdk
import { RealtimeConnectError, type ResumableConnection } from "./live"

declare const connection: ResumableConnection
try {
	for await (const message of connection) console.log(message)
} catch (error) {
	if (error instanceof RealtimeConnectError) console.error("refused by every transport", error.message)
}
```

## A 401 on any realtime transport refreshes once per open

The token refreshes once per open through the client's one auth hook, and the chain restarts from its first
transport. Rust adapters gain `Transport::refresh`, Python adapters `refresh()`. The TS `RealtimeAuthError` export is
removed: it was never thrown.

```ts v0
import { RealtimeAuthError } from "./sdk"
```

```ts sdk
import { Kitchen } from "./kitchen"

const client = new Kitchen({
	baseURL: "https://api.example.com",
	onAuthExpired: async () => (await fetch("/session/refresh")).text(),
})
```

## A TS realtime operation returns a `ResumableConnection<T>`

The SDK builds it over WebSocket, then SSE, then long-poll, whatever the operation's ws or sse extension. A
non-realtime ws or sse operation still returns its socket or async iterable. The TS WebSocket dial carries no
credential (the platform cannot send headers), so a server that requires auth on the upgrade gets TS clients on SSE
or long-poll; tokens never go in the URL.

```ts v0
const socket = client.prices.subscribe()
```

```ts sdk
import type { ResumableConnection } from "./live"

type Price = { eur: number }
declare const prices: ResumableConnection<Price>
for await (const price of prices) console.log(price.eur)
```

## `ResumableConnection` is generic, its `send` returns a promise

`ResumableConnection<T>` is generic over its payload, `send` returns `Promise<void>`, and `RealtimeOptions` is
exported.

```ts v0
connection.send({ text: "hi" })
```

```ts sdk
import type { RealtimeOptions, ResumableConnection } from "./live"

declare const connection: ResumableConnection<{ text: string }>
const options: RealtimeOptions = {}
await connection.send({ text: "hi" })
void options
```

## `lastId: number` becomes `lastEventId: string`

`ResumableConnectionOpts.lastId` becomes `lastEventId`, a string, matching SSE ids and every other SDK's cursor.

```ts v0
createResumableConnection({ transports, lastId: 41 })
```

```ts sdk
import { createResumableConnection, type TransportAdapter } from "./live"

declare const transports: TransportAdapter[]
createResumableConnection({ url: "https://api.example.com/prices", transports, lastEventId: "41" })
```

## A realtime connection sends raw text

Every SDK sends raw text: Rust gains `send_text`, TS `ResumableConnection.sendText` (a text frame on WebSocket, a
`text/plain` POST over SSE and long-poll). `send` still JSON-encodes.

```ts v0
connection.send(JSON.stringify("plain words"))
```

```ts sdk
import type { ResumableConnection } from "./live"

declare const connection: ResumableConnection
await connection.sendText("plain words")
```

## A TS SDK ships only the transports its operations use

An SDK's runtime carries the SSE parser only when the document has an event stream, the WebSocket only when it has
an `x-websocket` or `x-realtime` operation, and the resumable connection only when it has an `x-realtime` one. The
index exports those helpers the same way: `parseSSEStream` and `SSEEvent` with an event stream, `TypedWebSocket` with
a WebSocket, and `createResumableConnection`, `createFallbackChain`, `createKeepaliveLoop`, the `Realtime*Error`
classes and the connection types with a realtime operation. A plain HTTP SDK is about a third smaller once bundled.
The realtime examples on this page import from `./live`, an SDK whose document has an `x-realtime` operation.

```ts v0
import { createResumableConnection } from "./kitchen"
```

```ts sdk
import { createResumableConnection } from "./live"

createResumableConnection({ transports: [], url: "https://api.example.com/feed" })
```

## A TS network failure is `APIConnectionError`

A network failure is `APIConnectionError`, its `cause` the platform's error, not a raw `TypeError`, and the safe
twin (`client.safe`) throws it like every SDK, since no answer exists. An abort or a timeout keeps its own error.

```ts v0
try {
	await client.health()
} catch (error) {
	if (error instanceof TypeError) retry()
}
```

```ts sdk
import { APIConnectionError, Kitchen } from "./kitchen"

const client = new Kitchen({ baseURL: "https://api.example.com" })
try {
	await client.getApiHealth()
} catch (error) {
	if (error instanceof APIConnectionError) console.error("unreachable", error.cause)
}
```

## The MCP server's headers and redirect policy come from the environment

The generated MCP server takes `$<PREFIX>_HEADERS` (a JSON object of string values, validated at start and scrubbed
from every result) and `$<PREFIX>_REDIRECT=same-origin|follow` (default `same-origin`).

```sh v0
SHOP_MCP_TOKEN=t ./shop-mcp
```

```sh
SHOP_HEADERS='{"x-tenant":"acme"}' SHOP_REDIRECT=same-origin ./shop-mcp
```

## A WebSocket route's `.meta()` refuses keys it cannot honor

`deprecated`, `security`, `invalidate` and `mcp` are refused at the type level on a WebSocket route, where the build
dropped them silently.

```ts v0
app.ws("/feed").meta({ deprecated: true })
```

```ts
import { honey } from "@lovrozagar/honey"
import { ws } from "@lovrozagar/honey/ws"

const app = honey()
ws(app, "/feed")
	.meta({ summary: "Live feed" })
	.handler({ onOpen: (_ctx, socket) => socket.send("hello") })
```

## SDK error messages read `HTTP <status>: <message>`

Every target formats them alike, `HTTP <status>: <message>` or `HTTP <status>` with no message: Go and Rust drop the
reason phrase they printed (`404 Not Found: <message>`), and TS adds the prefix. Match the typed error and its
status, never the text.

```ts v0
if (String(error).startsWith("Not Found")) showMissing()
```

```ts sdk
import { Kitchen, NotFoundError } from "./kitchen"

const client = new Kitchen({ baseURL: "https://api.example.com" })
try {
	await client.getApiV1OrganizationsByOrgId({ params: { orgId: "org-404" } })
} catch (error) {
	if (error instanceof NotFoundError) console.error("no such organization")
}
```

## The TS SDK's SSE caps are UTF-8 bytes

`sseMaxBufferChars` is replaced by `sseMaxLineBytes` (1 MiB) and `sseMaxEventBytes` (8 MiB), measured in UTF-8 bytes
like every other SDK.

```ts v0
new Client({ sseMaxBufferChars: 1_000_000 })
```

```ts sdk
import { Kitchen } from "./kitchen"

const client = new Kitchen({ baseURL: "https://api.example.com", sseMaxLineBytes: 1 << 20, sseMaxEventBytes: 8 << 20 })
```

## The TS SDK speaks the HTTP version its `fetch` negotiates

Node 26 may use HTTP/2, and browsers choose their own; every other SDK is pinned to HTTP/1.1. To control it, pass
your own `fetch`.

```text v0
every request over HTTP/1.1
```

```ts sdk
import { Kitchen } from "./kitchen"

const client = new Kitchen({ baseURL: "https://api.example.com", fetch: (input, init) => fetch(input, init) })
```

## The plugin's `codegen.sdk` and `codegen.cli` are removed

The plugin writes the app's own artifacts (the route tree, the manifest, the OpenAPI JSON and YAML, the types), and
`honey-clients generate --app <module>` writes the SDKs, the CLI and MCP. Passing either key is an error naming that
command.

```ts v0
honeyPlugin({ app: "src/app.ts", codegen: { sdk: { out: "sdk" } } })
```

```ts
import { honeyPlugin } from "@lovrozagar/honey/plugin"

export const plugin = honeyPlugin({ app: "src/app.ts" })
```

## `meta<T>()` is `metaType<T>()`, and a route need not repeat a meta default

The meta type and the meta values are two calls now. `metaType<AppMeta>()` declares the type (what route `.meta()`
accepts and what `ctx.meta` holds) and returns the same handle; `meta({ … })` takes values only, keeps their literal
types without `as const`, and makes each key it sets optional on every route under that handle. A key nothing set
**stays required**. 0.7.3's one call, `meta<AppMeta>({ … })`, is gone: it recorded every declared key as set, since
one call cannot know which ones it set.

```ts v0
const app = honey().meta<AppMeta>({ worker: "shop" })
app.get("/items").meta({ summary: "List items", worker: "shop" }).handler(handler)
```

```ts
import { honey } from "@lovrozagar/honey"

type AppMeta = { tenant?: "organization" | "project"; worker: "shop" }

/* declare, then default: a route under this handle need not pass `worker` again */
const app = honey().metaType<AppMeta>().meta({ worker: "shop" })
app
	.get("/items")
	.meta({ summary: "List items" })
	.handler((ctx) => ctx.res.text("ok", ctx.meta.worker))
```

## A hook's `ctx.path` is the document's path template

An `onRequest` or `onResponse` hook used to be handed honey's own route spelling, with a colon before each
parameter. It is handed the operation's path template now, as the document writes it, and `onLog`'s
`operation` is `METHOD` plus that same path. The URL the call actually sent is `ctx.url`, with the
parameters filled in, and `ctx.request` on the way back.

A 1.0 client is generated from a document, and a document has no colon form — a third party's least of all —
so the template is the only spelling every client can agree on. Anything that keys a table by route changes
with it, and nothing warns you: a lookup simply misses.

```ts v0
/* a hook keyed its table on the colon form */
const fresh: Record<string, string> = { "GET /items/:id": "x-fresh" }
onRequest: [(ctx) => void ctx.headers.set(fresh[`${ctx.method} ${ctx.path}`] ?? "x-none", "1")]
```

```ts
import { honey } from "@lovrozagar/honey"

/* the template, which is what the document says and what onLog reports */
const fresh: Record<string, string> = { "GET /items/{id}": "x-fresh" }
const header = (method: string, path: string) => fresh[`${method} ${path}`]
```

A route's own `meta.invalidate` is still written by hand, so it may name its targets either way; normalize
both to the template before you look one up.

## The generated `RouteCtx` is the route's ctx; its meta is what the app declares

`types.gen.d.ts` types each route's ctx, and a service outside the app module takes it:
`RouteCtx<"/items", "get">`. Its `meta` is the meta type the app declares with `metaType<AppMeta>()` plus the OpenAPI
keys a route may add — not the route's configured values, which are narrower than what the handler holds (a
route's `operationId` is `string` there, not `"items.list"`). Read a route's values from the sibling
`RouteMeta<"/items", "get">`, which still types them as literals. Its `params` are the path's strings, except where
`.input({ params })` gives a key a schema: then that key is the schema's output, as the handler has it.

`InferRouteCtx<typeof app, …>` is the same ctx read off the app type, for a module the app does **not** import; a
service the app imports would be a cycle, and the generic then resolves to `never`.

```ts v0
import type { RouteCtx } from "./_gen/types.gen.d.ts"
```

```ts
import { honey, type InferRouteCtx } from "@lovrozagar/honey"

const routed = honey()
	.get("/items")
	.handler((ctx) => ctx.res.text("ok", "items"))

/* a module the app does not import reads the ctx off the app type; one it imports takes RouteCtx from _gen */
function items(ctx: InferRouteCtx<typeof routed, "/items", "get">): string {
	return ctx.routePattern
}
void items
```

## `@lovrozagar/honey/logger`: `LoggerInstance` is `Logger`, and `logger()` is the `requestLog` setting

The logger type is `Logger`, and the per-request line the `logger()` middleware wrote is the `requestLog`
setting — the one place that decides whether a request is logged. `LogData` and `LoggerOptions` go with it: a
record is `Record<string, unknown>`, and the options are `CreateLoggerOptions`. The default logger is quieter in a
test and writes through the console on Workers, both below.

| v0                                                             | v1                                                              |
| -------------------------------------------------------------- | --------------------------------------------------------------- |
| `import type { LoggerInstance }`                               | `import type { Logger }`                                        |
| `app.use(logger({ instance: log }))`                           | `app.requestLog(true)`, or `.requestLog({ skip })`              |
| `logger({ instance: log, skip: (d) => d.path === "/health" })` | `app.requestLog({ skip: (entry) => entry.path === "/health" })` |
| `LogData`                                                      | `Record<string, unknown>`                                       |
| `LoggerOptions`                                                | `CreateLoggerOptions`                                           |

```ts v0
import { logger, type LoggerInstance } from "@lovrozagar/honey/logger"
app.use(logger({ instance: log }))
```

```ts
import { honey } from "@lovrozagar/honey"
import { createLogger, type Logger } from "@lovrozagar/honey/logger"

const log: Logger = createLogger({ base: { service: "shop" } })
const app = honey()
app.logger(log).requestLog({ skip: (entry) => entry.path === "/health" })
```

## The default logger writes through the console on Workers, and only errors under `NODE_ENV=test`

Two defaults of `createLogger()`, each deciding whether you see a line at all:

- the sink follows the runtime. On Workers it is `console.log`, which is what Workers Logs captures;
  `nodejs_compat` also gives a worker a `process.stdout`, and honey does **not** write there. On Node and Bun it
  is `process.stdout.write`.
- `NODE_ENV=test` — which vitest and jest set, not you — floors the level at `error`. An info line is dropped in a
  test run and an incident is not. Pass `level` to override it, and `write` to take the lines yourself.

```ts v0
createLogger({ base: { service: "shop" } }) // always console.log, always level info
```

```ts
import { createLogger } from "@lovrozagar/honey/logger"

const lines: string[] = []
const log = createLogger({ base: { service: "shop" }, level: "info", write: (line) => lines.push(line) })
log.info("a line a test can read")
```

## `curlLogger({ instance })` is gone: it writes through the app's logger

A `curlLogger()` wrote its lines through the `instance` it was given; it writes through the app's logger now, or
through a `log` callback that takes each record.

```ts v0
app.use(curlLogger({ instance: log }))
```

```ts
import { honey } from "@lovrozagar/honey"
import { curlLogger } from "@lovrozagar/honey/curl-logger"

const app = honey()
app.use(curlLogger({ body: { maxBytes: 16_384 } }))
```

## `.errorI18n(config)` takes `createErrorTranslator(config)`

The setting carries the translator `createErrorTranslator()` builds, not a raw config, and v0's `enableI18n()` — the
import that turned the feature on — goes with every other enabler (`enableServe`, `enableOpenApi`): a feature is the
plain import that uses it. The setter rejects a raw config at startup, naming the fix.

```ts v0
import { enableI18n } from "@lovrozagar/honey/i18n"
app.errorI18n({ errors: { en: errorsEn }, resolveLocale: (c) => c.search["locale"] })
```

```ts
import { honey } from "@lovrozagar/honey"
import { createErrorTranslator } from "@lovrozagar/honey/i18n"

const app = honey()
app.errorI18n(
	createErrorTranslator({
		errors: { en: { not_found: "Nothing here" } },
		resolveLocale: (ctx) => ctx.search["locale"] ?? "en",
	}),
)
```

## `createCookieSigner({ name, secrets })` signs one cookie; `sign`, `verify` and `legacy` are gone

`@lovrozagar/honey/cookie-sign` exports only `createCookieSigner`. The signer takes the cookie's name with its
secrets and binds that name into every signature, so its `sign(value)` and `verify(signed)` take nothing else. The
one-shot `sign` and `verify`, their `SignOptions` and `VerifyOptions`, and the `legacy` option are gone: a v1
signature, the HMAC of the value alone, never verifies, so a value signed for one cookie cannot pass as another. A
value the signer signed before keeps verifying under the same name and secrets.

```ts v0
import { sign, verify } from "@lovrozagar/honey/cookie-sign"
const token = await sign("user-42", secret, { name: "sid" })
const user = await verify(token, [secret, oldSecret], { legacy: false, name: "sid" })
```

```ts
import { createCookieSigner } from "@lovrozagar/honey/cookie-sign"

const sid = createCookieSigner({ name: "sid", secrets: ["current-secret", "previous-secret"] })
const token = await sid.sign("user-42")
const user = await sid.verify(token)
```

## One removed name per subpath, and what it is now

The rest of what 0.7.3 exported and 1.0 does not. Everything else it exported was its own internals — an
adapter's socket wrapper, the plugin's resolved config, the tree's matcher — and no app wrote them.

| v0                                                                                 | v1                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `startHoneyServer`, `enableServe`, `HoneyServeOptions` (`@lovrozagar/honey/serve`) | `serve(app, options)` from `@lovrozagar/honey/node` or `@lovrozagar/honey/bun`, its options inline, `ServeHandle` for what it answers |
| `HoneyServer` (`@lovrozagar/honey/node`), its `shutdown(timeout)`                  | `ServeHandle`: Node's own `http.Server` on `server`, and `close(timeout)`                                                             |
| `detectRuntime` (`@lovrozagar/honey`)                                              | nothing: a server imports its runtime's `serve`, and a Worker exports the app                                                         |
| `enableOpenApi`, `spec` (`@lovrozagar/honey/openapi`)                              | `serveOpenApi(app, options)`                                                                                                          |
| `createProxyHandler` (`@lovrozagar/honey/proxy`)                                   | `proxy({ destination })`, a handler you pass to `.handler()`                                                                          |
| `RealtimeRouteOpts` (`@lovrozagar/honey/realtime`)                                 | `RealtimeLimits` and `ConnContext`                                                                                                    |
| `ClientInfo`, `clientInfo`, `TrustProxy` (`@lovrozagar/honey/trust`)               | nothing: `ctx.ip` is the platform's peer, and a proxy header is yours to read                                                         |

```ts v0
import { startHoneyServer } from "@lovrozagar/honey/serve"
await startHoneyServer(app, { port: 3000 })
```

```ts
import { honey } from "@lovrozagar/honey"
import { serve } from "@lovrozagar/honey/node"

const app = honey()
const server = await serve(app, { port: 3000 })
await server.close()
```

## A client over several documents: a merged tree's document replaces `mergeSpecs`

A v0 consumer that generated one client from several documents (the plugin's `codegen.sdk.specs`) generates from
the document of a merged tree instead: a gateway that merges its services with `codegen.mergeTree` emits one
document over all of them, and `honey-clients generate --spec` takes it. Merging two documents that no tree
relates is planned after 1.0.

```ts v0
honeyPlugin({ codegen: { sdk: { name: "ShopSDK", specs: ["../a/openapi.json", "../b/openapi.json"] } } })
```

```sh
honey-clients generate --spec src/_gen/openapi.gen.json --target ts --ts-name ShopSDK --out sdk
```

## `honey-clients` generates from its own entry too

The bin writes each target under `<out>/<target>/`. A consumer that writes the files itself — a flat layout, or a
document patched in memory — calls `generated()` from the package entry, which answers each target's files by path
and the package they make, and writes nothing. `writeTarget()` writes one target's files into a directory you pick,
and `writeGenerated()` is the bin's own writer; both keep the stale-file handling.

```ts v0
import { generateSDK } from "@lovrozagar/honey/codegen"
```

```ts
import { generated, type GenerateRun } from "@lovrozagar/honey-clients"

const run: GenerateRun = { options: { ts: { name: "ShopSDK", stem: "shop" } }, targets: ["ts"] }
const document = { info: { title: "Shop", version: "1.0.0" }, openapi: "3.1.0", paths: {} }
const files = await generated(run, document, { env: {}, report: () => undefined })
export const names = Object.keys(files.ts?.files ?? {})
```

## A gateway config works unchanged

`app` plus `codegen.mergeTree` (a gateway over several services) is unchanged. The tree written is the services'
merged routes plus the gateway's own, and the documents, manifest and types come from the served `app` with the
services' schemas. A first run bootstraps the merged tree.

```ts v0
honeyPlugin({ app: "src/gateway.ts", codegen: { mergeTree: { users: "../users", billing: "../billing" } } })
```

```ts
import { honeyPlugin } from "@lovrozagar/honey/plugin"

export const plugin = honeyPlugin({ app: "src/gateway.ts", codegen: { mergeTree: "src/merge.ts" } })
```

## A gateway with its own routes exports its app built without its tree

A gateway that adds a route its generated tree lacks cannot be imported over that tree: export the gateway's app,
built without its tree, from the merge entry as `app`, and generation builds the tree from it before importing the
served app. v0's codegen-process tolerance has no v1 counterpart; the error names both fixes.

```ts v0
export default createGateway({ routeTree })
```

```ts
import { honey } from "@lovrozagar/honey"

/* the merge entry: the gateway's own routes, without the generated tree it would otherwise load */
export const app = honey()
app.get("/status").handler((ctx) => ctx.res.json("ok", { up: true }))
```

## `honey()` transforms no module

v0 injected feature entries into the build. Each feature is now a plain import, so a bundle holds only what you use.

```ts v0
app.realtime("/rt", handler)
```

```ts
import { honey } from "@lovrozagar/honey"
import { realtime } from "@lovrozagar/honey/realtime"

const app = honey()
realtime(app, "/rt", { handler: (_ctx, conn) => conn.send({ hello: true }) })
```

## `trust` and `trustProxy` are cut

`ctx.ip` is the platform's peer: `CF-Connecting-IP` on Workers, the socket on Node and Bun, never an
`X-Forwarded-*` value. Behind your own proxy, read the header your proxy sets in your own code.

```ts v0
import { trustProxy } from "@lovrozagar/honey/trust"
app.use(trustProxy(1))
```

```ts
import { honey } from "@lovrozagar/honey"

const app = honey()
app.get("/whoami").handler((ctx) => {
	/* behind your own proxy only: the header your proxy sets, read by you */
	const client = ctx.req.headers.get("x-real-ip") ?? ctx.ip
	return ctx.res.json("ok", { client })
})
```

## `@lovrozagar/honey/openapi/spec` is removed

v0's `spec()` handler is `serveOpenApi` from `@lovrozagar/honey/openapi`, which mounts the JSON and YAML documents (and
a docs page with `docs`) rather than returning a handler.

```ts v0
import { spec } from "@lovrozagar/honey/openapi/spec"
app.get("/openapi.json").handler(spec(app))
```

```ts
import { honey } from "@lovrozagar/honey"
import { serveOpenApi } from "@lovrozagar/honey/openapi"
import { scalar } from "@lovrozagar/honey/openapi/scalar"

const app = honey()
serveOpenApi(app, { title: "Shop", version: "1.0.0", docs: { "/docs": scalar } })
```

## `docs: "scalar"` becomes `docs: { "/docs": scalar }`

`docs` maps each path to its page now, the page itself imported from its own subpath, in `serveOpenApi` and
`serveStaticOpenApi` alike. Importing the page keeps the one you do not show out of the bundle: a string meant both
pages were reachable, so both shipped. The path is the map's key, so `docsPath` is gone, and one document can have
several pages. A string or a page without its path is a type error, and at runtime it throws showing the map.

```ts v0
serveOpenApi(app, { title: "Shop", version: "1.0.0", docs: "scalar" })
```

```ts
import { honey } from "@lovrozagar/honey"
import { serveOpenApi } from "@lovrozagar/honey/openapi"
import { scalar } from "@lovrozagar/honey/openapi/scalar"

const app = honey()
serveOpenApi(app, { title: "Shop", version: "1.0.0", docs: { "/docs": scalar } })
```

Swagger UI is `import { swagger } from "@lovrozagar/honey/openapi/swagger"`, then `docs: { "/docs": swagger }`.

## Names that said `cloudflare` say `workers`

The runtime is named for the product. Nothing else changed.

| 0.7                                           | 1.0                                        |
| --------------------------------------------- | ------------------------------------------ |
| `@lovrozagar/honey/ws/cloudflare`             | `@lovrozagar/honey/ws/workers`             |
| `cfWebSocket()`                               | `workersWebSocket()`                       |
| `createBuildPlugin({ target: "cloudflare" })` | `createBuildPlugin({ target: "workers" })` |
| `detectRuntime()` answering `"cloudflare"`    | removed: import the runtime's `serve`      |
| `honey init --cf`, `honey init --cloudflare`  | `honey init --workers`                     |
| `runtime: "cloudflare"` in the request log    | `runtime: "workers"`                       |

## `app.ws(path)` becomes `ws(app, path)`

`import { ws } from "@lovrozagar/honey/ws"`, the same shape as `realtime(app, path)`. It takes any handle `.ws()` was
a method of (the app, a `.basePath()` handle, a chain) and types the route exactly as before. An app that opens no
socket then bundles no WebSocket route code, about 1.1 KB gzipped.

```ts v0
app.ws("/echo").handler({ onMessage: (_ctx, socket, data) => socket.send(data) })
```

```ts
import { honey } from "@lovrozagar/honey"
import { ws } from "@lovrozagar/honey/ws"

const app = honey()
ws(app, "/echo").handler({ onMessage: (_ctx, socket, data) => socket.send(data) })
```

## `testClient` moved, and `transport: "node"` is `transport: serve`

`testClient` comes from `@lovrozagar/honey/testing`. `transport` takes the runtime's `serve` itself, from
`@lovrozagar/honey/node` or `@lovrozagar/honey/bun`: the app is served with it on a free port through that runtime's
own adapter, so it is no longer Node-only.

```ts v0
const client = testClient(app, { transport: "node" })
```

```ts
import { honey } from "@lovrozagar/honey"
import { serve } from "@lovrozagar/honey/node"
import { testClient } from "@lovrozagar/honey/testing"

const app = honey()
const client = testClient(app, { env: {}, transport: serve })
await client.close()
```

## `app.serve(...)` is removed

Import `serve` from your runtime's entry, `@lovrozagar/honey/node` or `@lovrozagar/honey/bun`, and pass the app. On
Cloudflare Workers, export the app itself.

```ts v0
app.serve({ port: 3000 })
```

```ts
import { honey } from "@lovrozagar/honey"
import { serve } from "@lovrozagar/honey/node"

const app = honey()
const server = await serve(app, { hostname: "0.0.0.0", port: 3000 })
await server.close()
```

## Installed packages run their compiled `dist/`

An installed `@lovrozagar/honey` and `@lovrozagar/honey-clients` run their compiled `dist/` on every runtime, Bun
included; v0's `bun` export condition to the TypeScript source is gone. Nothing to change in your code; a tool that
read honey's source from `node_modules` reads `dist/` now.

```text v0
bun resolved "@lovrozagar/honey" to src/index.ts
```

```sh
bun add @lovrozagar/honey@next @lovrozagar/honey-clients@next
```

## `defineMiddleware` is `createMiddleware(fn, { errors, meta })`

One factory makes every middleware. `createMiddleware` infers what each `next({...})` call adds, and its options name
the error keys the middleware answers with (each route that mounts it declares them) and the meta it gives those
routes, checked against the meta type its ctx reads. `defineMiddleware` typed only the first `next()` it saw.

```ts v0
import { defineMiddleware } from "@lovrozagar/honey"
const withAuth = defineMiddleware({ errors: [errors, "unauthorized"], fn: (ctx: AuthCtx, next) => next({ user }) })
```

```ts
import { createMiddleware, defineErrors } from "@lovrozagar/honey"

const errors = defineErrors({ unauthorized: "unauthorized" })
const withAuth = createMiddleware((_ctx: { req: Request }, next) => next({ user: { id: "u1" } }), {
	errors: [errors, "unauthorized"],
})
```

## `DefaultMeta` and `OpenApiMeta` are `HoneyMeta`

One type names route meta: `HoneyMeta` is the built-in keys, and `HoneyMeta<RouteMeta>` adds your own; a built-in key
`RouteMeta` declares (`security`, `extensions`) takes your type. A middleware types the meta it reads with
`HoneyCtx<Env, RouteMeta>`, and a metaSpec `map` or `expand` gets `MetaSpecContext<RouteMeta>`.

```ts v0
import type { DefaultMeta, OpenApiMeta } from "@lovrozagar/honey"
type Summary = OpenApiMeta["summary"]
```

```ts
import { createMiddleware, type HoneyCtx, type HoneyMeta } from "@lovrozagar/honey"

type RouteMeta = { worker?: "extract" | "saas" }
type Summary = HoneyMeta["summary"]
const withWorker = createMiddleware((ctx: HoneyCtx<{}, RouteMeta>, next) => next({ worker: ctx.meta.worker ?? "saas" }))
```

## `defineErrors` carries honey's own keys

Every factory now holds honey's framework keys (`not_found`, `validation_failed`, `malformed_body`, `too_many_requests`
and the rest) at the status honey answers them with, so a route declares and documents them without the app listing
them. Drop the entries that repeat them; an entry you keep replaces honey's.

```ts v0
const errors = defineErrors({
	not_found: "not_found",
	org_limit_reached: "forbidden",
	validation_failed: "bad_request",
})
```

```ts
import { defineErrors } from "@lovrozagar/honey"

const errors = defineErrors({ org_limit_reached: "forbidden" })
```

## `meta.extensions` keys are checked

A meta type that declares `extensions` now replaces honey's open `Record<\`x-${string}\`, unknown>`, so a misspelled
key fails to compile on a route or a chain `.meta()`. At generate time a strict metaSpec (the default once you declare
one) reports an `x-`key that neither its new`extensions`list nor one of its entries names. List the keys your routes
set, or set`strict: "warn"` while you migrate.

```ts v0
app.metaSpec({ meta: { worker: "x-worker" } })
app.get("/tables/:id").meta({ extensions: { "x-befor": "table.delete" } })
```

```ts
import { honey } from "@lovrozagar/honey"

type RouteMeta = { extensions?: { "x-before"?: string }; worker?: string }

const app = honey().metaType<RouteMeta>()
app.metaSpec({ extensions: ["x-before"], meta: { worker: "x-worker" } })
app
	.delete("/tables/:id")
	.meta({ extensions: { "x-before": "table.delete" } })
	.handler((ctx) => ctx.res.text("ok", "deleted"))
```

## A handler returns only what `.output()` declares

On a route with `.output()` the handler's return is narrowed to a declared media type at one of its status keys, or a
bodiless answer (`noContent`, `redirect`). `ctx.res.raw` is gone there, since a raw `Response` declares nothing; it
stays on a route without `.output()`. To stream a declared type, pass a `ReadableStream` to its helper (`text`,
`html`, `csv`, `xml`, `binary`, `json`, `sse`). To pass on a `Response` whose status is decided elsewhere, such as a
stored file's 206 or 304, use `ctx.res.forward(response)`: its status and media type must be declared. To refuse a
request, throw a `HoneyError`, `headers` included.

```ts v0
app
	.get("/assets/:id")
	.output({ "application/json": { ok: asset } })
	.handler(async (ctx) => ctx.res.raw(await readAsset(ctx)))
```

```ts
import { honey } from "@lovrozagar/honey"

const app = honey()
app
	.get("/assets/:id")
	.output({ "application/octet-stream": { ok: true } })
	.handler((ctx) => ctx.res.binary("ok", new Blob(["bytes"]).stream()))
```

## A handler may return the body, and `{ ok: schema }` declares JSON

Status keys alone are the shorthand for the `application/json` form. With one 2xx status under one media type (not an
event stream, and no headers declared for it), the handler may return the body and honey answers it at that status.
Routes with two success statuses or two media types still build the answer with `ctx.res`.

```ts v0
app
	.get("/tables")
	.output({ "application/json": { ok: tables } })
	.handler(async (ctx) => ctx.res.json("ok", await listTables(ctx)))
```

```ts
import { honey } from "@lovrozagar/honey"
import * as z from "zod"

const tables = z.object({ id: z.string() }).array()

const app = honey()
app
	.get("/tables")
	.output({ ok: tables })
	.handler(async () => [{ id: "t-1" }])
```

## A status is a key: no `status` option, and `redirect(statusKey, url)`

`ResponseOptions` has no numeric `status` anymore. The status key a helper takes is the one the document names, so a
number beside it could only contradict the contract. `redirect` takes its 3xx key first. Under `.output()` it takes
only the keys the `redirect` entry declares, and a route that declares an output but no `redirect` has no
`ctx.res.redirect`. `stream`, `generate` and `sse` answer 200.

```ts v0
app.get("/created").handler((ctx) => ctx.res.json("ok", { id: "1" }, { status: 201 }))
app.get("/old").handler((ctx) => ctx.res.redirect("/new", { status: 301 }))
```

```ts
import { honey } from "@lovrozagar/honey"

const app = honey()
app.get("/created").handler((ctx) => ctx.res.json("created", { id: "1" }))
app
	.get("/old")
	.output({ redirect: { moved_permanently: true } })
	.handler((ctx) => ctx.res.redirect("moved_permanently", "/new"))
```

## `params` is a schema per path param, onto `ctx.params`

Path params are strings without any schema. `.input({ params })` takes a schema per param that needs one, keyed by
the path's own names, and puts the validated values on `ctx.params` beside the undeclared ones; `ctx.input.params` is
gone. A name the path does not have is a type error and throws at registration, so a typo can no longer pass.

```ts v0
app
	.get("/oauth/:provider/authorize")
	.input({ params: z.object({ provider: z.enum(["github", "google"]) }) })
	.handler((ctx) => ctx.res.text("ok", ctx.input.params.provider))
```

```ts
import { honey } from "@lovrozagar/honey"
import * as z from "zod"

const app = honey()
app
	.get("/oauth/:provider/authorize")
	.input({ params: { provider: z.enum(["github", "google"]) } })
	.handler((ctx) => ctx.res.text("ok", ctx.params.provider))
```

## `readableStream()` is `streamed()`, for a body only

`readableStream()` and `ReadableStreamSchema` are `streamed()` and `StreamedSchema`. The wrapper leaves a json or form
body unread for the handler to stream from `ctx.req`, and the schema still documents it. `search`, `headers` and
`cookies` take a schema only, which always runs: a wrapper there no longer hands on the raw record, and is a type
error. Read `ctx.searchAll`, `ctx.headers` or `ctx.cookies` for the unvalidated values. `proxy`'s `rewriteUrl` takes
`(ctx, url)`, ctx first like `destination`, `onResponse` and `requestHeaders`.

```ts v0
app
	.post("/ingest")
	.input({ json: readableStream(manifest), search: readableStream(filters) })
	.handler((ctx) => ctx.res.json("accepted", { search: ctx.input.search }))
app.all("/api/*rest").handler(proxy({ destination, rewriteUrl: (url) => url.slice("/api".length) }))
```

```ts
import { honey } from "@lovrozagar/honey"
import { streamed } from "@lovrozagar/honey/input"
import { proxy } from "@lovrozagar/honey/proxy"
import * as z from "zod"

const manifest = z.object({ chunks: z.number(), fileName: z.string() })
const app = honey()
app
	.post("/ingest")
	.input({ json: streamed(manifest) })
	.handler((ctx) => ctx.res.json("accepted", { search: ctx.searchAll }))
app.all("/api/*rest").handler(
	proxy({
		destination: (_ctx, url) => fetch(`https://upstream.test${url}`),
		rewriteUrl: (_ctx, url) => url.slice(4),
	}),
)
```

## `routeTree()` returns a new app, callable at any point

`app.routeTree(tree)` no longer loads the tree into `app`. It returns a new app with `app`'s settings, middleware,
scopes and routes on the tree, and `app` stays treeless. It can be called after routes register, so a gateway needs no
factory that loads the tree before its first route: generation reads the app as built, and the runtime serves the one
`routeTree()` returns. Keep the return value; a bare `app.routeTree(tree)` statement now serves nothing.

```ts v0
export function createApp(tree?: RouteTree) {
	const app = honey()
	if (tree !== undefined) app.routeTree(tree) // before the first route, or it throws
	app.all("/*").handler(proxy({ destination }))
	return app
}
```

```ts
import { honey } from "@lovrozagar/honey"
import { proxy } from "@lovrozagar/honey/proxy"
import type { RouteTree } from "@lovrozagar/honey/tree"

declare const routeTree: RouteTree
export const app = honey()
app.all("/*").handler(proxy({ destination: (_ctx, url, init) => fetch(`https://upstream.test${url}`, init) }))
export const served = app.routeTree(routeTree)
```

## One import path per name

`@lovrozagar/honey/errors` is gone: `defineErrors`, `ERROR_META` and `ErrorMetaEntry` come from the root. `./openapi`
no longer re-exports the docs pages or the static document server: `scalar` comes from `./openapi/scalar`, `swagger`
from `./openapi/swagger`, and `serveStaticOpenApi` and its types from `./openapi/static`. `./tree` exports the route
tree's types only. When two paths reach one name, a codebase ends up importing both.

```ts v0
import { defineErrors } from "@lovrozagar/honey/errors"
import { scalar, serveOpenApi } from "@lovrozagar/honey/openapi"
```

```ts
import { defineErrors } from "@lovrozagar/honey"
import { scalar } from "@lovrozagar/honey/openapi/scalar"

export const errors = defineErrors({ not_found: "not_found" })
export const docs = { "/docs": scalar }
```

## The Vite plugin is `honeyPlugin()`

`@lovrozagar/honey/plugin` exports the plugin as `honeyPlugin`, so it no longer shares a name with the app factory, and
`@lovrozagar/honey/build` exports the build target plugin alone: the plugin and its config types come from `./plugin`
only. The CLI's messages name `honeyPlugin()` too.

```ts v0
import { honey } from "@lovrozagar/honey/plugin"
import { type HoneyVitePluginConfig } from "@lovrozagar/honey/build"
```

```ts
import { honeyPlugin, type HoneyVitePluginConfig } from "@lovrozagar/honey/plugin"

const config: HoneyVitePluginConfig = { app: "src/app.ts" }
export default { plugins: [honeyPlugin(config)] }
```

## `customErrorFormatter()` is `payloadErrorFormatter()`, and `createErrorResponse` is gone

The formatter for errors `defineErrors` gave a payload schema is `payloadErrorFormatter()`, and its type is
`PayloadErrorFormatter`: the name says what it formats. `createErrorResponse` was the router's own answer builder
and leaves the root; an error answers through `throw`, `ctx.jsonFromError(error)` or a test request to the app.

```ts v0
import { createErrorResponse, type CustomErrorFormatter } from "@lovrozagar/honey"

app.customErrorFormatter((error, data) => ({ ...data, trace: "t" }))
```

```ts
import { honey, type PayloadErrorFormatter } from "@lovrozagar/honey"

const withTrace: PayloadErrorFormatter = (_error, data) => ({ ...data, trace: "t" })
export const app = honey().payloadErrorFormatter(withTrace)
```

## Codegen declares security schemes once; each document lists the ones it shows

`codegen.securitySchemes` holds every scheme, and an OpenAPI output's `securitySchemes` and an MCP output's are gone.
A document shows the schemes its `security` lists, else the ones its routes name, so `sanitize.stripSecurityRequirements`
and `sanitize.stripSecuritySchemes` are gone too: `sanitize` keeps `stripXExtensions`. An output writes the formats
its `formats` names, JSON alone by default, where it used to write a YAML twin beside every JSON file: add `"yaml"` to
keep one. Declared tags are listed in the order given.

```ts v0
codegen: {
	openApi: {
		path: "assets/openapi.public.json",
		sanitize: { stripSecurityRequirements: ["jwt"], stripSecuritySchemes: ["staffKey"] },
		securitySchemes: { apiKey, jwt, staffKey },
		title: "Shop",
		version: "1.0.0",
	},
}
```

```ts
import { honeyPlugin } from "@lovrozagar/honey/plugin"

const apiKey = { in: "header", name: "Authorization", type: "apiKey" }
const jwt = { scheme: "bearer", type: "http" }
const staffKey = { in: "header", name: "x-staff-key", type: "apiKey" }

export default {
	plugins: [
		honeyPlugin({
			app: "src/app.ts",
			codegen: {
				openApi: {
					formats: ["json", "yaml"],
					path: "assets/openapi.public.json",
					security: ["apiKey"],
					title: "Shop",
					version: "1.0.0",
				},
				securitySchemes: { apiKey, jwt, staffKey },
			},
		}),
	],
}
```
