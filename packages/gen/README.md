# @lovrozagar/honey-codegen

Generates SDKs (TypeScript, Go, Rust, Python, C#, Java) and a Go CLI from an OpenAPI 3.x document.

## honey-codegen generate

```sh
honey-codegen generate --spec openapi.json --target ts --target cli --out generated \
  --cli-binary-name shop --cli-module-path github.com/acme/shop --cli-repo acme/shop
```

- `--spec <file>`: the OpenAPI document, as JSON.
- `--target <name>`: `ts`, `go`, `rust`, `python`, `csharp`, `java`, `cli` or `mcp`; repeat it for more than one. Each
  target's files go under `<out>/<target>`.
- `--<target>-<option>`: a target's options are its generator's, passed through as given (`--go-module-path`,
  `--rust-crate-name`, `--cli-binary-name`, a boolean as `--go-throw-on-error=false`). `honey-codegen --help` lists
  them all.
- `--watch`: generate again on each change of the spec, each run in a fresh process.

The `go` and `cli` targets format every Go file they write with gofmt, so they need Go installed. gofmt is found by
`$GOFMT`, then `$GOROOT/bin/gofmt`, then `gofmt` on `PATH`, then beside the `go` on `PATH`. Without one they refuse.

**Stale files are not deleted yet.** Each run writes its files over the old ones and deletes nothing. A file a removed
operation left behind stays until a later release cleans the output directory, and a stale one can break the build
(a `cli` target's old `<name>_cmds.go` still compiles into the module). Clear `<out>/<target>` before generating when
operations have been removed.

Generating from an app's source (`--app`) is not here yet; generate from its OpenAPI document.
