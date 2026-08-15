# Honey SDKs

OpenAPI-in, tier-1 SDKs out. One spec is parsed once into a shared IR, then four language printers emit idiomatic, feature-equivalent clients for **TypeScript, Python, Go, and Rust**.

Framework start: [README](../README.md).

## Four-language parity pledge

Every SDK exposes the same capability surface with native bindings. `context.Context` in Go, `AbortSignal` in TS, `asyncio.Task.cancel()` in Python, `tokio_util::sync::CancellationToken` in Rust — all four satisfy "cancellation" without translating each other's syntax. This page is the scannable index of the four-language SDK surface.

Entry points:

- `generateTypeScriptSDK(spec, { name, stem })` — emits `sdk.client.gen.ts`, `sdk.types.gen.ts`, `sdk.index.gen.ts`, `sdk.map.gen.ts`, and (when `x-realtime` is present) `sdk.runtime.gen.ts`.
- `generatePythonSDK(spec)` — emits a `sdk/` package with `client.py`, `_runtime.py`, `_errors.py`, `_realtime.py`, `_transport.py`, `_ws.py`.
- `generateGoSDK(spec, { modulePath })` — emits a Go module importable via a `replace` directive.
- `generateRustSDK(spec, { crateName })` — emits a Cargo crate referenced via `path = "..."`.

The rest of this page is the capability matrix and "how to do X" snippets. All snippets come from `../examples/`.

## Capability matrix

| §   | Capability                                             | TS  | Python | Go  | Rust |
| --- | ------------------------------------------------------ | --- | ------ | --- | ---- |
| 1   | Typed operations (request, response, params, bodies)   | ✓   | ✓      | ✓   | ✓    |
| 2   | Typed error hierarchy + `.data` typed payload          | ✓   | ✓      | ✓   | ✓    |
| 3   | `onAuthExpired` callback + 1x 401 retry                | ✓   | ✓      | ✓   | ✓    |
| 4   | Cancellation (idiomatic per lang)                      | ✓   | ✓      | ✓   | ✓    |
| 5   | Per-call timeout override                              | ✓   | ✓      | ✓   | ✓    |
| 6   | Per-call headers merge                                 | ✓   | ✓      | ✓   | ✓    |
| 7   | `onRequest` / `onResponse` hook chain                  | ✓   | ✓      | ✓   | ✓    |
| 8   | Invalidation + `isStale`                               | ✓   | ✓      | ✓   | ✓    |
| 9   | SSE iteration                                          | ✓   | ✓      | ✓   | ✓    |
| 10  | Realtime (`x-realtime`) + `TransportAdapter` fallback  | ✓   | ✓      | ✓   | ✓    |
| 11  | WebSocket (`x-websocket`) bidi                         | ✓   | ✓      | ✓   | ✓    |
| 12  | Streaming request body                                 | ✓   | ✓      | ✓   | ✓    |
| 13  | Sync runtime                                           | —   | ✓      | —   | ✓    |
| 14  | `onLog` lifecycle hook                                 | ✓   | ✓      | ✓   | ✓    |
| 15  | `x-deprecated`                                         | ✓   | ✓      | ✓   | ✓    |
| 16  | `x-idempotency-key`                                    | ✓   | ✓      | ✓   | ✓    |

Sync runtime is not idiomatic in TS (no sync HTTP in browsers or workerd) or Go (goroutines + `context.Context` are the async model). Python and Rust ship dual async + sync generation.

## How to do X

Each subsection below shows the same capability realized in all four languages. Snippets are trimmed from `../examples/{lang}/example.*` — those files are the source of truth and contain the full frame plus imports.

### §1 — Client init + config

Config is mechanism, not policy. You pick retry, logging, auth refresh, and invalidation strategies; the SDK supplies the hook slots.

```ts
const sdk = new MockSDK({
  baseURL: BASE_URL,
  headers: { Authorization: "Bearer expired-token" },
  onAuthExpired: () => Promise.resolve("valid-token"),
  onLog: (entry) => console.debug(entry.event, entry.operation, entry.duration_ms, entry.status),
  onRequest: [addTrace, addApp],
  onResponse: [inspect5xx],
  throwOnError: true,
  timeout: 10_000,
})
```

```py
sdk = AsyncSDK(ClientConfig(
    base_url=BASE_URL,
    headers={"Authorization": "Bearer expired-token"},
    on_auth_expired=refresh_token,
    on_log=on_log,
    on_request=[add_trace_hook, add_app_hook],
    on_response=[inspect_response_hook],
    invalidation=InvalidationConfig(stale_time=5.0),
    timeout=10.0,
))
```

```go
client := sdk.NewClient(sdk.Config{
    BaseURL:       baseURL,
    Headers:       map[string]string{"Authorization": "Bearer expired-token"},
    OnAuthExpired: func(ctx context.Context) (string, error) { return "valid-token", nil },
    OnRequest:     []func(*sdk.RequestContext) error{addTrace, addApp},
    OnResponse:    []func(*sdk.ResponseContext) error{inspect5xx},
    OnLog:         func(e sdk.LogEntry) { fmt.Println(e.Event, e.Operation, e.DurationMs, e.Status) },
    Invalidation:  sdk.InvalidationConfig{StaleTime: 5 * time.Second},
    Timeout:       10 * time.Second,
})
```

```rust
let client = Client::new(ClientConfig {
    base_url,
    bearer_token: Some("expired-token".into()),
    on_auth_expired: Some(Arc::new(|| Box::pin(async { Ok(Some("valid-token".into())) }))),
    on_log: Some(Arc::new(|e: LogEntry| println!("{} {} {}", e.event, e.operation, e.duration_ms))),
    on_request: vec![trace_hook, app_hook],
    on_response: vec![inspect_hook],
    invalidation: InvalidationConfig { stale_time_ms: 5_000 },
    timeout: Some(Duration::from_secs(10)),
    ..Default::default()
});
```

### §2 — Typed operation call

Every OpenAPI operation becomes a typed method. Path / query / header params are typed per operation; request and response bodies are typed from the declared schemas.

```ts
const user = await sdk.createUser({ json: { email: "a@b.com", name: "Alice" } })
console.log(user.id, user.name)
```

```py
user = await sdk.createUser(body={"name": "Alice", "email": "a@b.com"})
print(user["id"], user["name"])
```

```go
user, err := client.CreateUser(ctx, sdk.UserCreate{Name: "Alice", Email: "a@b.com"}, nil)
if err == nil {
    fmt.Println(user.Id, user.Name)
}
```

```rust
let user = client
    .create_user(
        &UserCreate { name: "Alice".into(), email: "a@b.com".into() },
        &CreateUserOpts::default(),
    )
    .await?;
println!("{} {}", user.id, user.name);
```

### §3 — Typed error catch

Every SDK emits the unified taxonomy: `BadRequestError`, `UnauthorizedError`, `NotFoundError`, `RateLimitError`, `InternalServerError`, and a `ClientError` / `Error` base. Each carries `status`, `body`, and (§4) a typed `data` payload.

```ts
try {
  await sdk.createUser({ json: input })
} catch (e) {
  if (e instanceof BadRequestError) console.error("400", e.status)
  else if (e instanceof UnauthorizedError) console.error("401")
  else if (e instanceof NotFoundError) console.error("404")
  else if (e instanceof RateLimitError) console.error("429")
  else if (e instanceof InternalServerError) console.error("500")
  else if (isClientError(e)) console.error("unknown:", e.status)
  else throw e
}
```

```py
try:
    await sdk.createUser(body=input)
except BadRequestError as e:
    print("400", e.status)
except UnauthorizedError:
    print("401")
except NotFoundError:
    print("404")
except RateLimitError:
    print("429")
except InternalServerError:
    print("500")
except ClientError as e:
    print("unknown:", e.status)
```

```go
user, err := client.CreateUser(ctx, input, nil)
if err != nil {
    var bre *sdk.BadRequestError
    var ue  *sdk.UnauthorizedError
    var nfe *sdk.NotFoundError
    switch {
    case errors.As(err, &bre): fmt.Println("400", bre.Status())
    case errors.As(err, &ue):  fmt.Println("401")
    case errors.As(err, &nfe): fmt.Println("404")
    default:                   fmt.Println("unknown:", err)
    }
}
```

```rust
match client.create_user(&input, &CreateUserOpts::default()).await {
    Ok(user) => println!("{}", user.id),
    Err(Error::Api(api_err)) => {
        let dyn_err: &(dyn std::error::Error + 'static) = api_err.as_ref();
        if let Some(bre) = dyn_err.downcast_ref::<BadRequestError>() {
            println!("400 {}", bre.status_code);
        } else if dyn_err.downcast_ref::<UnauthorizedError>().is_some() {
            println!("401");
        }
    }
    Err(e) => eprintln!("{}", e),
}
```

### §4 — Declared error payload (`err.data`)

When an operation declares a `4xx` response schema in OpenAPI, the parsed payload is eagerly populated on the error object at response time. `err.body` remains the raw bytes; `err.data` is typed.

```ts
try {
  await sdk.createUser({ json: bad })
} catch (e) {
  if (e instanceof BadRequestError) {
    console.error("400 data:", e.data, "body:", e.body)
  }
}
```

```py
try:
    await sdk.createUser(body=bad)
except BadRequestError as e:
    print("400 data:", e.data, "body:", e.body)
```

```go
var bre *sdk.BadRequestError
if errors.As(err, &bre) {
    fmt.Println("400 data:", bre.Data, "body:", string(bre.Body))
}
```

```rust
if let Some(bre) = dyn_err.downcast_ref::<BadRequestError>() {
    println!("400 data: {:?} body_len: {}", bre.data, bre.body.len());
}
```

### §5 — `onAuthExpired` callback

Exactly **one** retry on 401 with a freshly-fetched token. The callback owns storage; the SDK never writes to disk or env. Retry beyond 401 is a non-goal — wire 5xx / 429 retry via `onResponse`.

```ts
onAuthExpired: () => Promise.resolve("valid-token"),
```

```py
async def refresh_token() -> str:
    return "valid-token"

ClientConfig(on_auth_expired=refresh_token, ...)
```

```go
OnAuthExpired: func(ctx context.Context) (string, error) {
    return "valid-token", nil
},
```

```rust
on_auth_expired: Some(Arc::new(|| Box::pin(async {
    Ok(Some("valid-token".into()))
}))),
```

### §6 — Cancellation

Each SDK uses the language's native cancellation primitive. Cancellation propagates into HTTP, SSE, WS, and `ResumableConnection` — never silently dropped.

```ts
const ctrl = new AbortController()
setTimeout(() => ctrl.abort(), 25)
try {
  await sdk.slow({ search: { ms: 500 }, signal: ctrl.signal })
} catch (e) {
  console.error("cancelled:", (e as Error).name)
}
```

```py
task = asyncio.create_task(sdk.slow(ms=500))
await asyncio.sleep(0.01)
task.cancel()
try:
    await task
except asyncio.CancelledError:
    print("cancelled async")
```

```go
cancelCtx, cancel := context.WithTimeout(ctx, 25*time.Millisecond)
defer cancel()
_, err := client.Slow(cancelCtx, &sdk.SlowOpts{Ms: 500})
if err != nil {
    fmt.Println("cancelled:", err)
}
```

```rust
let token = CancellationToken::new();
let token_clone = token.clone();
tokio::spawn(async move {
    tokio::time::sleep(Duration::from_millis(25)).await;
    token_clone.cancel();
});
let _ = client
    .slow(&SlowOpts { ms: Some(500), cancel_token: Some(token), ..Default::default() })
    .await;
```

### §7 — Per-call timeout

Config timeout is the default. Per-call `timeout` on any op is a hard override. Distinct from cancellation — timeout is a deadline, cancellation is an external signal.

```ts
await sdk.slow({ search: { ms: 200 }, timeout: 50 })
```

```py
await sdk.slow(ms=200, timeout=0.05)
```

```go
_, err := client.Slow(ctx, &sdk.SlowOpts{Ms: 200, Timeout: 50 * time.Millisecond})
```

```rust
client
    .slow(&SlowOpts {
        ms: Some(200),
        timeout: Some(Duration::from_millis(50)),
        ..Default::default()
    })
    .await?;
```

### §8 — Per-call headers

Per-call headers merge over config headers; per-call wins per key. Useful for request-scoped tracing IDs, idempotency keys, or one-off auth overrides.

```ts
await sdk.getUser({
  headers: { "X-Both": "call-wins" },
  params: { id: "u1" },
})
```

```py
await sdk.getUser("u1", headers={"X-Both": "call-wins"})
```

```go
_, _ = client.GetUser(ctx, "u1", &sdk.GetUserOpts{
    Headers: map[string]string{"X-Both": "call-wins"},
})
```

```rust
let _ = client
    .get_user(
        "u1",
        &GetUserOpts {
            headers: Some([("X-Both".into(), "call-wins".into())].into_iter().collect()),
            ..Default::default()
        },
    )
    .await;
```

### §9 — `onRequest` / `onResponse` hooks

Hook chains run in declaration order, awaited in order, and may mutate the context (headers pre-send, status inspection post-receive). They are the only built-in retry primitive beyond the 401 path — 5xx backoff, circuit breakers, tracing all live here.

```ts
onRequest: [
  (ctx) => { ctx.headers["X-Trace-Id"] = crypto.randomUUID(); return Promise.resolve() },
  (ctx) => { ctx.headers["X-App"] = "example"; return Promise.resolve() },
],
onResponse: [
  (ctx) => { if (ctx.status >= 500) console.warn("5xx:", ctx.status); return Promise.resolve() },
],
```

```py
async def add_trace_hook(ctx):
    ctx.headers["X-Trace-Id"] = "trace-123"

async def inspect_response_hook(rctx):
    if rctx.response.status_code >= 500:
        print("5xx:", rctx.response.status_code)

ClientConfig(on_request=[add_trace_hook], on_response=[inspect_response_hook], ...)
```

```go
OnRequest: []func(*sdk.RequestContext) error{
    func(c *sdk.RequestContext) error { c.Headers.Set("X-Trace-Id", "trace-123"); return nil },
    func(c *sdk.RequestContext) error { c.Headers.Set("X-App", "example"); return nil },
},
OnResponse: []func(*sdk.ResponseContext) error{
    func(c *sdk.ResponseContext) error {
        if c.Status >= 500 { fmt.Println("5xx:", c.Status) }
        return nil
    },
},
```

```rust
let trace_hook: OnRequestHook = Arc::new(|ctx| {
    Box::pin(async move {
        ctx.headers.insert("X-Trace-Id".into(), "trace-123".into());
        Ok(())
    })
});
let inspect_hook: OnResponseHook = Arc::new(|ctx| {
    let status = ctx.status;
    Box::pin(async move {
        if status >= 500 { eprintln!("5xx: {}", status); }
        Ok(())
    })
});
```

### §10 — `onLog`

A single pluggable sink. `LogEntry` carries `{ level, event, operation, duration_ms, status?, error? }`. This is not a logger framework — wire it into whatever leveled logger the consumer already has.

```ts
onLog: (entry) => console.debug(entry.event, entry.operation, entry.duration_ms, entry.status),
```

```py
def on_log(entry: LogEntry) -> None:
    print(entry.event, entry.operation, entry.duration_ms, entry.status)
```

```go
OnLog: func(e sdk.LogEntry) {
    fmt.Println(e.Event, e.Operation, e.DurationMs, e.Status)
},
```

```rust
on_log: Some(Arc::new(|e: LogEntry| {
    println!("{} {} {} {:?}", e.event, e.operation, e.duration_ms, e.status);
})),
```

### §11 — Invalidation + `isStale`

An `x-invalidate: ["GET /resource/:id"]` extension on a mutating op marks matching GET paths stale. Two-tier lookup (exact → pattern regex, cached). TTL config governs the stale window. The SDK stores staleness only — never cached bodies — so consumer code picks the refetch moment.

```ts
await sdk.updateUser({ json: { name: "Alice2" }, params: { id: "u1" } })
const stale = sdk.isStale("GET", "/users/u1")
console.log("users/u1 stale?", stale)
```

```py
await sdk.updateUser("u1", body={"name": "Alice2"})
print("users/u1 stale?", await sdk.is_stale("GET", "/users/u1"))
```

```go
_, _ = client.UpdateUser(ctx, "u1", sdk.UserUpdate{Name: "Alice2"}, nil)
fmt.Println("users/u1 stale?", client.IsStale("GET", "/users/u1"))
```

```rust
let _ = client
    .update_user(
        "u1",
        &UserUpdate { name: Some("Alice2".into()), ..Default::default() },
        &UpdateUserOpts::default(),
    )
    .await;
println!("users/u1 stale? {}", client.is_stale("GET", "/users/u1"));
```

### §12 — SSE iteration

Operations with `produces: text/event-stream` return a typed async iterable of events. Reconnect on drop is consumer-driven for basic SSE (use `x-realtime` in §13 for auto-reconnect).

```ts
for await (const ev of sdk.streamEvents()) {
  console.log("sse event:", ev)
  break
}
```

```py
async for ev in sdk.streamEvents():
    print("sse event:", ev)
    break
```

```go
stream, err := client.StreamEvents(ctx, nil)
if err == nil {
    for ev := range stream.Events() {
        fmt.Println("sse event:", ev)
        break
    }
    stream.Close()
}
```

```rust
let mut sse = client.stream_events(&StreamEventsOpts::default()).await?;
if let Some(ev) = sse.next().await {
    println!("sse event: {:?}", ev);
}
```

### §13 — WebSocket bidi

Operations with `x-websocket: true` yield a typed bidirectional channel: `Send` / `Recv` types come from the schema. Client close returns code 1000; server-initiated close surfaces a reason.

```ts
const ws = sdk.connectWs()
await new Promise<void>((resolve) => { ws.on("open", () => resolve()) })
ws.on("message", (data: string) => {
  console.log("ws recv:", data)
  ws.close(1000, "done")
})
ws.send("hello")
```

```py
async with sdk.connectWs() as ws:
    await ws.send("hello")
    async for msg in ws:
        print("ws recv:", msg)
        break
    await ws.close(1000, "done")
```

```go
ws, err := client.ConnectWs(ctx, nil)
if err == nil {
    _ = ws.Send("hello")
    msg, _ := ws.Recv()
    fmt.Println("ws recv:", msg)
    _ = ws.Close(1000, "done")
}
```

```rust
let mut ws = client.connect_ws(&ConnectWsOpts::default()).await?;
ws.send("hello".to_string()).await?;
if let Some(msg) = ws.recv().await {
    println!("ws recv: {:?}", msg);
}
ws.close(1000, "done").await?;
```

### §14 — Realtime with custom adapter

`x-realtime: true` opens a `ResumableConnection` with a pluggable `TransportAdapter`, an auto fallback chain (`[ws, sse, longpoll]` by default), and hidden proven-transport memoization. Consumers can reorder, drop, or inject entirely custom transports — browser WS, node `ws`, workerd sockets, `tokio-tungstenite`, `gorilla/websocket`, whatever.

```ts
function makeCustomAdapter(): TransportAdapter {
  return {
    connect(_url, _opts): TransportConnection {
      let onFrame: (f: ServerFrame) => void = () => {}
      const conn: TransportConnection = {
        close() {},
        onClose: () => {}, onError: () => {},
        get onFrame() { return onFrame }, set onFrame(cb) { onFrame = cb },
        send(_data) {},
      }
      queueMicrotask(() => onFrame({ data: { kind: "tick" }, id: 1, t: "msg" }))
      return conn
    },
  }
}
const rc = createResumableConnection({
  maxReconnectAttempts: 5,
  reconnectDelayMs: 100,
  transports: [makeCustomAdapter()],
  url: `${BASE_URL}/rt`,
})
for await (const ev of rc) { console.log("rt:", ev); break }
rc.close()
```

```py
class TickAdapter:
    def name(self): return "tick"
    def kind(self): return TransportKind.WS

    async def connect(self, _url, _opts):
        return TickConn()

rc = ResumableConnection(f"{BASE_URL}/rt", [TickAdapter()], TransportOpts())
await rc.connect()
async for ev in rc:
    print("rt event:", ev)
    break
await rc.close()
```

```go
rc, err := client.ConnectRealtime(ctx, &sdk.ConnectRealtimeOpts{
    Transports:           []sdk.Transport{&tickTransport{}},
    MaxReconnectAttempts: 5,
    ReconnectDelayMs:     100,
})
if err == nil {
    for ev := range rc.Events() {
        fmt.Println("rt event:", ev)
        break
    }
    rc.Close()
}
```

```rust
let tick_adapter: Arc<dyn Transport + Send + Sync> = Arc::new(TickAdapter);
let mut rc = client
    .connect_realtime(&ConnectRealtimeOpts {
        transports: vec![tick_adapter],
        max_reconnect_attempts: 5,
        reconnect_delay_ms: 100,
        ..Default::default()
    })
    .await?;
if let Some(ev) = rc.next().await {
    println!("rt event: {:?}", ev);
}
rc.close().await;
```

### §15 — Streaming upload

Binary or multipart uploads flow as a stream. No buffering — the SDK pipes the source directly into the underlying HTTP client. Critical on memory-bounded runtimes like CF Workers.

```ts
const stream = new ReadableStream<Uint8Array>({
  pull(controller) {
    if (sent >= TOTAL) { controller.close(); return }
    const chunk = new Uint8Array(Math.min(CHUNK, TOTAL - sent))
    sent += chunk.length
    controller.enqueue(chunk)
  },
})
const uploaded = await sdk.uploadBlob({ body: stream })
console.log("uploaded:", uploaded.size, uploaded.hash)
```

```py
async def gen() -> AsyncIterator[bytes]:
    for off in range(0, TOTAL, CHUNK):
        yield buf[off:off + CHUNK]

uploaded = await sdk.uploadBlob(gen())
print("uploaded:", uploaded["size"], uploaded["hash"])
```

```go
uploaded, err := client.UploadBlob(ctx, bytes.NewReader(buf), nil)
if err == nil {
    fmt.Println("uploaded:", uploaded.Size, uploaded.Hash)
}
```

```rust
let chunks: Vec<Bytes> = buf.chunks(CHUNK).map(|c| Bytes::copy_from_slice(c)).collect();
let body_stream = stream::iter(chunks.into_iter().map(Ok::<_, std::io::Error>));
let uploaded = client.upload_blob(body_stream, &UploadBlobOpts::default()).await?;
println!("uploaded: {} {}", uploaded.size, uploaded.hash);
```

### §16 — `x-idempotency-key`

Operations marked `x-idempotency-key: true` auto-send an `Idempotency-Key` header with a UUID when the caller doesn't supply one. Precedence: `headers["Idempotency-Key"]` wins over the explicit opts field, which wins over the auto UUID.

```ts
const auto      = await sdk.idempotentCreate()
const explicit  = await sdk.idempotentCreate({ idempotencyKey: "user-supplied-123" })
const viaHeader = await sdk.idempotentCreate({ headers: { "Idempotency-Key": "header-wins-456" } })
```

```py
auto       = await sdk.idempotentCreate()
explicit   = await sdk.idempotentCreate(idempotency_key="user-supplied-123")
via_header = await sdk.idempotentCreate(headers={"Idempotency-Key": "header-wins-456"})
```

```go
auto,      _ := client.IdempotentCreate(ctx, nil)
explicit,  _ := client.IdempotentCreate(ctx, &sdk.IdempotentCreateOpts{IdempotencyKey: "user-supplied-123"})
viaHeader, _ := client.IdempotentCreate(ctx, &sdk.IdempotentCreateOpts{
    Headers: map[string]string{"Idempotency-Key": "header-wins-456"},
})
```

```rust
let auto     = client.idempotent_create(&IdempotentCreateOpts::default()).await?;
let explicit = client
    .idempotent_create(&IdempotentCreateOpts {
        idempotency_key: Some("user-supplied-123".into()),
        ..Default::default()
    })
    .await?;
let via_header = client
    .idempotent_create(&IdempotentCreateOpts {
        headers: Some([("Idempotency-Key".into(), "header-wins-456".into())].into_iter().collect()),
        ..Default::default()
    })
    .await?;
```

## Links

- **End-to-end examples** — full per-lang files with every capability §1–16 in context:
  - `../examples/typescript/example.ts`
  - `../examples/python/example.py`
  - `../examples/go/example.go`
  - `../examples/rust/example.rs`
  - `../examples/README.md` — examples index + parity surface map.
- **Master spec** — full capability surface lived in the iterating monorepo workerc specs; this page plus `./api-ref/` are the in-repo index.
- **Behavioral harnesses** — the tier-4 tests that verify what this page documents:
  - `../tests/integration/sdk-harness/ts-harness.test.ts`
  - `../tests/integration/sdk-harness/python-harness.test.ts`
  - `../tests/integration/sdk-harness/go-harness.test.ts`
  - `../tests/integration/sdk-harness/rust-harness.test.ts`
