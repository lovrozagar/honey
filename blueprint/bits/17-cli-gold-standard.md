# Bit 17 — CLI (cf-grade)

Closes: E1
Oracle kept green: `tests/integration` go-cli suites (basic-crud, auth, body-json, enums, exit-codes, multipart, naming, output-modes, path/query-params, runtime-embed, streaming, compile).
Formatter post-pass: gofmt. Language: Go (single static binary; end user needs no Go/Node).

## Scope
The Go CLI emitter, raised to the cf bar at the schema level (split v0 `codegen-go-cli.ts` 1,066 into `gen/emit/cli/`). Shares the Go SDK emit layer (bit 12). Keep Go for zero-setup distribution; adopt cf's consistency/discovery/compact output.

## Distribution (ruled — emit the release plumbing, not just source)
Honey emits Go CLI **source** (a buildable, pure-Go module → one static binary, `CGO_ENABLED=0`, no Go/Node at runtime). The compiled per-platform binaries are built and hosted by the API author's pipeline, not by Honey (consistent with bit 19: "publication is the API author's pipeline, documented") — but "gold-standard zero-setup distribution" means the author must not hand-wire that pipeline. So the CLI scaffold emits the full cross-build + release plumbing:
- `.goreleaser.yaml` — the build matrix (linux/darwin/windows × amd64/arm64 from one runner, no C cross-toolchain since the code is pure Go), checksums, archives, and optional publishers (GitHub Releases, Homebrew tap, Scoop). The author runs `goreleaser release` on a tag.
- a release CI workflow (GitHub Actions) that tags → runs goreleaser → uploads the artifacts.
- `install.sh` + `install.ps1` — detect os/arch and fetch the right binary from wherever the author hosts (GitHub Releases or a CDN, e.g. Cloudflare R2); CDN-hostable, so a `curl … | sh` one-liner works.

Add to the file list when designing: `gen/emit/cli/{release,install}.ts` (+test each) and their fixtures. Hosting target (GitHub Releases vs a CDN) stays the author's choice; Honey generates the plumbing both paths use. Bit 20 documents the release flow (bit 19 scope).

## Files (from files.tsv — `gen/emit/cli`)
- `gen/emit/cli/{commands,flags,output,discovery,completion,skills,indicator,binary}.ts` (+test each) + index.
- As shipped (the close's mapping): the emitter is `module.ts` (the Go module, tidy-exact go.mod/go.sum, the embedded Go SDK under `internal/sdk`), `layout.ts` (the cmd package), `commands.ts`, `flags.ts`, `discovery.ts`, `skills.ts`, `release.ts` and `install.ts`; output, binary, completion, the indicator and the streams live in the vendored Go runtime `gen/runtime/cli/*.go` and are tested by `output.test.ts`, `binary.test.ts`, `completion.test.ts`, `indicator.test.ts`, `stream.test.ts` and `socket.test.ts`. Phase h adds the `honey-codegen generate` bin (`gen/bin/honey-codegen.js`, `src/cli.ts`, `src/gen/{args,process}.ts`).

## Tests (named, written first)
- `gen/emit/cli/commands.test.ts` — one command per operation, consistent verbs from the resource tree.
- `gen/emit/cli/flags.test.ts` — `--api-key/--base-url/--config/--timeout/--verbose`; precedence flag>env>config.
- `gen/emit/cli/output.test.ts` — `--json` uniform on every command; json/ndjson/yaml/table; compact-for-agent default under `--json`.
- `gen/emit/cli/discovery.test.ts` — machine-listable command index for agents (E1).
- `gen/emit/cli/completion.test.ts` — bash/zsh/fish.
- `gen/emit/cli/skills.test.ts` — the agent skills/docs bundle ships with the CLI.
- `gen/emit/cli/binary.test.ts` — bytes to stdout or `--output <file>`; pipe-safe. As shipped the flag is `-o/--output`, global on every command; binary bytes to a terminal are refused.

- `conformance/cli.test.ts` — the generated CLI runs the shared conformance matrix (incl. `--json`/exit-codes/`--output` binary/discovery) against the live reference server (dx/conformance.md).
- Closed at f: 28 shared matrix cells + 5 CLI-only rows (exit codes 0–5 by outcome with the redirect hint, `--json` exact single lines, `-o` file bytes, the discovery index and `__complete`'s candidates, both literal), every cell red on a named mutant (the cell × mutant grid has no hollow cell), no lacks.

## Security corpus
- shared string-escape (F2); no secret in `--verbose` logs.
- Closed at i: F2 rechecked on a built binary (`emit/cli/hostile.test.ts`): a hostile title, summary and description compile and vet; help, the index, the group list, the command help and the skill print no control character and no format verb is interpreted; the install scripts carry no byte of the document; 7 named mutants red.

## Budget
- token: the discovery index + per-command help are the measured CLI surface for the token budget (H6).
- Closed at i (`scripts/sdk-budget.cli.test.ts`, read from each e2e app's built binary, equal to the emitter's measurement): the index, each command, each schema, the banner and the skill per app at `ceilingOf(measured, 0.2)` with a completeness check (a command per call plan). Kitchen: index 175, per command max 15 (median 7), schema max 46, skill 441. Surface (the widest): index 274, per command max 26, schema max 66, skill 433.
- runtime: locked at zero headroom at 55,356 B over `runtime/cli`, every file named (55,319 B, then +37 B at i: a stream cut mid-way exits 3 as transport).
- binary: the stripped kitchen binary (CGO_ENABLED=0, -trimpath, -s -w, linux/amd64) at `ceilingOf(9,932,960 B, 0.02)` = 10,131,620 B.

## Moved to bit 19
- `honey-codegen generate --app` (core's public document entry and a no-bind codegen flag are needed first), `src/ir/load.ts` and regression V072-2: h shipped `--spec` (JSON) only.
- Stale generated-file cleanup: `generate` writes over and deletes nothing (documented in `--help` and the README).
- CLI release signing and attestation (the release workflow is least-privilege and unsigned).
