# @lovrozagar/honey-codegen

Generates SDKs (TypeScript, Go, Rust, Python, C#, Java) and a Go CLI from an OpenAPI 3.x document.

## honey-codegen generate

```sh
honey-codegen generate --spec openapi.json --target ts --target cli --out generated \
  --cli-binary-name shop --cli-module-path github.com/acme/shop --cli-repo acme/shop
```

- `--spec <file>`: the OpenAPI document, as JSON.
- `--app <module>[#export]`: a honey app module instead of `--spec` (give one, never both). Its named export, else
  `app`, else `default`, is the app; its document is made by the app's own `@lovrozagar/honey/openapi`, resolved from
  the app as at run time, and the module's `openApi` export, if any, is that document's options (`info`,
  `securitySchemes`, `invalidate`, …, as `generateOpenApi` takes them). Started by `bun run`, the bin hands the load to
  that Bun, so a module needing Bun's loaders works; a run ends once it has written, whatever the module left open.
  The module exports the app and serves nothing: one that calls `serve()` as it loads is outside `--app`'s contract,
  since honey never serves implicitly and has no switch to stop it.
- `--target <name>`: `ts`, `go`, `rust`, `python`, `csharp`, `java`, `cli` or `mcp`; repeat it for more than one. Each
  target's files go under `<out>/<target>`.
- `--<target>-<option>`: a target's options are its generator's, passed through as given (`--go-module-path`,
  `--rust-crate-name`, `--cli-binary-name`, a boolean as `--go-throw-on-error=false`). `honey-codegen --help` lists
  them all.
- `--watch`: generate again on each change of the spec (or the `--app` module), each run in a fresh process.

The `go` and `cli` targets format every Go file they write with gofmt, so they need Go installed. gofmt is found by
`$GOFMT`, then `$GOROOT/bin/gofmt`, then `gofmt` on `PATH`, then beside the `go` on `PATH`. Without one they refuse.

**Stale files are deleted, edited ones kept.** Each `<out>/<target>` keeps `.honey-generated.json`: every file the run
wrote, with its sha256. A file is rewritten only when its bytes change, through a temp file renamed over it. A
regeneration deletes a file the last run wrote and this one does not (a `cli` target's old `<name>_cmds.go`, say), unless
it was edited since: that one is kept and named on stderr. A file the manifest never listed is never deleted, nothing
outside `<out>/<target>` is touched, and no symlink is followed. Without a manifest, nothing is deleted.
