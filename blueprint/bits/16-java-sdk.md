# Bit 16 — Java SDK (new)

Closes: H5 · H11 · C1 · C2 · A1/A2
Oracle kept green: a new `tests/integration/java-harness` (compile + runtime), added to the polyglot matrix.
Formatter post-pass: google-java-format. Runtime: vendored, JDK `java.net.http.HttpClient` + Jackson (H11).

## Scope
A first-class Java SDK emitter + vendored runtime in `gen/emit/java/`. Java source only; ships to Maven Central with a generated Gradle build; compiled `--release 17`, CI tests on 17/21/25. Reads only the IR. No server framework.

## Files (from files.tsv — `gen/emit/java`, new)
- `gen/emit/java/{sdk,models,http,json,sse,ws,errors,gradle}.ts` (+test each) + index.
- `gen/runtime/java/*` — vendored HttpClient + Jackson runtime template.

## Tests (named, written first)
- `gen/emit/java/sdk.test.ts` — operations + `record` models from IR.
- `gen/emit/java/overrides.test.ts` — per-call overrides + raw response (C2).
- `gen/emit/java/sse.test.ts` + `gen/emit/java/ws.test.ts` — typed events; `Last-Event-ID` reconnect against the reference server (H8 parity).
- `gen/emit/java/binary.test.ts` — `byte[]`/`InputStream`; typed headers (A1/A2).
- `gen/emit/java/format.test.ts` — output is google-java-format-clean; compiles on 17/21/25.
- `conformance/java.test.ts` — the Java client runs the shared conformance matrix against the live reference server.

## Security corpus
- shared string-escape (F2); Jackson configured without polymorphic-deserialization gadgets.
- `gen/emit/java/redirect.test.ts` — **`Authorization` (and configured headers) are dropped on a cross-origin redirect** (H18.10): `java.net.http.HttpClient` resends them by default, so the emitter must not follow cross-host redirects with auth attached. Part of the cross-SDK auth-on-redirect conformance case.

## Budget
- token: per-operation size within budget.
