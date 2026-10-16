# Bit 15 — C#/.NET SDK (new)

Closes: H5 · H11 · C1 · C2 · A1/A2
Oracle kept green: a new `tests/integration/csharp-harness` (compile + runtime), added to the polyglot matrix.
Formatter post-pass: `dotnet format`. Runtime: vendored, BCL-only — `HttpClient` + source-generated `System.Text.Json`, zero external deps (H11).

## Scope
A first-class C# SDK emitter + vendored runtime in `gen/emit/csharp/`. Models as `record`; ships a NuGet package with a generated `.csproj`; target-framework floor `net8.0`, CI tests on `net10.0`. Reads only the IR. No server framework.

## Files (from files.tsv — `gen/emit/csharp`, new)
- `gen/emit/csharp/{sdk,models,http,json,sse,ws,errors,csproj}.ts` (+test each) + index.
- `gen/runtime/csharp/*` — vendored BCL runtime template + source-gen JSON contexts.

## Tests (named, written first)
- `gen/emit/csharp/sdk.test.ts` — operations + `record` models from IR.
- `gen/emit/csharp/overrides.test.ts` — per-call overrides + raw response (C2).
- `gen/emit/csharp/sse.test.ts` + `gen/emit/csharp/ws.test.ts` — typed events; `Last-Event-ID` reconnect against the reference server (H8 parity).
- `gen/emit/csharp/binary.test.ts` — `byte[]`/`Stream`; typed headers (A1/A2).
- `gen/emit/csharp/format.test.ts` — output is `dotnet format`-clean; compiles on net8.0 and net10.0.
- `conformance/csharp.test.ts` — the C# client runs the shared conformance matrix against the live reference server.

## Security corpus
- shared string-escape (F2); System.Text.Json source-gen is AOT-safe.
- `gen/emit/csharp/redirect.test.ts` — **`Authorization` (and configured/`onRequest` headers) are dropped on a cross-origin redirect** (H18.10): `HttpClient` resends them by default, so the emitter must set a redirect policy that strips them cross-host. Part of the cross-SDK auth-on-redirect conformance case in the harness.

## Budget
- token: per-operation size within budget.

## Downstream
- On ruling, ping the Anyrow docs (session monorepo-92, or its successor) with the final public API. They drafted against the projection `AnyrowClient` + `ClientConfig`, operationId-named accessors (`client.Row` / `RowListOptions`), the `Async` suffix + `CancellationToken`, exception-based errors, NuGet id `Anyrow`; send any delta from that so the docs can follow.
