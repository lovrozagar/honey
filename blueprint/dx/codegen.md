# dx — codegen (`@lovrozagar/honey-codegen`)

Runs against any `openapi.json` (3.x), not only honey's. Emits SDKs, the CLI, and the MCP server. Runtime glue is vendored into each output (H9); emission uses strings + the shared sanitizer + a formatter post-pass (H12).

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| input spec | yes | — | the OpenAPI document (file or object) → IR | a non-honey spec still works via the IR seam | `ir/build.test.ts` |
| `targets` (ts, go, rust, python, csharp, java, cli, mcp) | yes | — | which artifacts to emit | each target is an independent emitter reading only the IR | `gen/process.test.ts` |
| output dir | yes | — | where the generated package lands | one package per target with its build manifest | `gen/write.test.ts` |
| formatter post-pass | no | on in CI | **[H12]** runs gofmt/rustfmt/ruff/`dotnet format`/google-java-format/oxfmt (TS) | mandatory in publish CI; valid-but-unformatted fallback when the toolchain is absent (pure-JS/worker) | `emit/shared/format.test.ts` |
| runtime | — | vendored | **[H9]** glue vendored inline, depends on the ecosystem lib by version range | no per-language runtime package is published | `gen/write.test.ts` |
| type extraction | no | — | **[H12]** extract middleware ctx/chain types from a TS honey app via the ts-morph compiler API | needs `ts-morph` (optional peer); only for TS honey apps | `extract/extract.test.ts` |
| webhook helpers | — | — | **[B3]** emit a typed webhook-payload parser + signature-verify helper when the spec declares `webhooks` | — | `emit/shared/webhooks.test.ts` |
| naming / sanitizer | — | — | **[F2]** one shared, fuzzed string-escape + identifier layer across all emitters | raw spec text never reaches source | `emit/shared/escape.test.ts` |
| determinism | — | on | stable, code-unit-ordered output across machines | `localeCompare` is banned in emitters (host-locale drift) | `emit/shared/escape.test.ts` |
