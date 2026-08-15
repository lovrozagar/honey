# Honey SDK — Examples

End-to-end usage demos across TypeScript, Python, Go, and Rust. One file per language, each showing the full cross-lang parity surface defined in `.workerc/specs/honey-sdk-parity-master.md`.

## Important

These files are **documentation**, not compile targets. The referenced `./sdk/` directory (TS/Python/Go) and `../mock-sdk/` crate (Rust) are produced by running the codegen helpers against a consumer's OpenAPI spec. Without codegen output in place, the imports will not resolve — and that is by design. The examples exist to eyeball capability equivalence across langs side-by-side.

## Files

- `typescript/example.ts` — async TS, assumes `generateTypeScriptSDK(spec, { name: "MockSDK", stem: "sdk" })`.
- `python/example.py` — async + sync, assumes `generatePythonSDK(spec)` written as a `sdk` package.
- `go/example.go` — `context.Context`-driven, assumes `generateGoSDK(spec, { modulePath: "example.com/mock-sdk" })` with a `replace` directive.
- `rust/example.rs` — `#[tokio::main]`, assumes `generateRustSDK(spec, { crateName: "mock-sdk" })`.

## Parity surface (§ numbers anchor every example)

```
 §    Capability                         TS file          Python file        Go file             Rust file
 1    Client init + config              MockSDK ctor     AsyncSDK(Config)   sdk.NewClient       Client::new
 2    Typed operation call              sdk.createUser   sdk.createUser     client.CreateUser   client.create_user
 3    Typed error hierarchy             instanceof       except FooError    errors.As           downcast_ref
 4    Declared error payload            err.data         e.data             bre.Data            bre.data
 5    onAuthExpired + 1x 401 retry      config hook      on_auth_expired    OnAuthExpired       on_auth_expired
 6    onRequest / onResponse chain      arrays           callable lists     []func              Vec<Arc<...>>
 7    onLog lifecycle                   onLog            on_log             OnLog               on_log
 8    Per-call timeout override         opts.timeout     timeout= kwarg     Opts.Timeout        opts.timeout
 9    Per-call headers merge            opts.headers     headers= kwarg     Opts.Headers        opts.headers
10    Invalidation + isStale            sdk.isStale      sdk.is_stale       client.IsStale      client.is_stale
11    SSE iteration                     for await        async for          for ev := range    stream.next()
12    WebSocket bidi + close            ws.on / ws.close async with ws:     ws.Send/ws.Close    ws.send/ws.close
13    Realtime + TransportAdapter       TransportAdapter TransportAdapter   Transport iface     Transport trait
14    Streaming upload                  ReadableStream   AsyncIterator      io.Reader           Stream<Bytes>
15    x-idempotency-key                 opts + headers   kwarg + headers    Opts + Headers      opts + headers
16    Cancellation                      AbortSignal      asyncio cancel     context.Context     CancellationToken
```

## Related

- Master spec: `.workerc/specs/honey-sdk-parity-master.md`
- Behavioral harnesses (verify what these examples document):
  - `public/honey/core/tests/integration/sdk-harness/ts-harness.test.ts`
  - `public/honey/core/tests/integration/sdk-harness/python-harness.test.ts`
  - `public/honey/core/tests/integration/sdk-harness/go-harness.test.ts`
  - `public/honey/core/tests/integration/sdk-harness/rust-harness.test.ts`
