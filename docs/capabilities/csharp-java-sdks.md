# The C# and Java SDKs

`honey-codegen generate --target csharp` writes a .NET
SDK (a project with its own `HttpClient` pipeline, `IAsyncDisposable` streams and a `Result<T>` safe mode), and
`--target java` writes a Java 17+ library (Jackson 3, builders, `try`-with-resources streams, a Gradle publication).
Both pass the same conformance grid as the TypeScript, Go, Rust and Python SDKs. The SDK recipes page shows each in
a compiled example.

## Example

```sh
honey-codegen generate --spec openapi.json --target csharp --out ./clients/csharp
honey-codegen generate --spec openapi.json --target java --out ./clients/java
```

Tested by: `integration/conformance/csharp.test.ts`, `integration/conformance/java.test.ts`
