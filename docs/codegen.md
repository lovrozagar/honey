# Code generation

`honey-clients generate` writes clients from an OpenAPI document (`--spec`) or straight from an app module
(`--app`): SDKs in TypeScript, Go, Rust, Python, C# and Java, a command-line client and an MCP server. Each target
vendors its small runtime, so a generated SDK has no honey dependency. The output is formatted and deterministic, so
regenerating an unchanged spec changes nothing.

## Example

```sh
honey-clients generate --spec openapi.json --target go --out ./clients/go
honey-clients generate --app src/app.ts --target python --out ./clients/python
```

## Reference

| Value                                                    | Default  | What it does                                                                                    | Watch for                                                                                             |
| -------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| input spec                                               | —        | the OpenAPI document (file or object) → IR                                                      | a non-honey spec still works via the IR seam                                                          |
| `targets` (ts, go, rust, python, csharp, java, cli, mcp) | —        | which artifacts to emit                                                                         | each target is an independent emitter reading only the IR                                             |
| output dir                                               | —        | where the generated package lands                                                               | one package per target with its build manifest                                                        |
| formatter post-pass                                      | on in CI | runs gofmt/rustfmt/ruff/`dotnet format`/google-java-format/oxfmt (TS)                           | mandatory in publish CI; valid-but-unformatted fallback when the toolchain is absent (pure-JS/worker) |
| runtime                                                  | vendored | glue vendored inline, depends on the ecosystem lib by version range                             | no per-language runtime package is published                                                          |
| type extraction                                          | —        | extract middleware ctx/chain types from a TS honey app via the ts-morph compiler API            | needs `ts-morph` (optional peer); only for TS honey apps                                              |
| webhook helpers                                          | —        | emit a typed webhook-payload parser + signature-verify helper when the spec declares `webhooks` | —                                                                                                     |
| naming / sanitizer                                       | —        | one shared, fuzzed string-escape + identifier layer across all emitters                         | raw spec text never reaches source                                                                    |
| determinism                                              | on       | stable, code-unit-ordered output across machines                                                | `localeCompare` is banned in emitters (host-locale drift)                                             |
