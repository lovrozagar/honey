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

## Tests (named, written first)
- `gen/emit/cli/commands.test.ts` — one command per operation, consistent verbs from the resource tree.
- `gen/emit/cli/flags.test.ts` — `--api-key/--base-url/--config/--timeout/--verbose`; precedence flag>env>config.
- `gen/emit/cli/output.test.ts` — `--json` uniform on every command; json/ndjson/yaml/table; compact-for-agent default under `--json`.
- `gen/emit/cli/discovery.test.ts` — machine-listable command index for agents (E1).
- `gen/emit/cli/completion.test.ts` — bash/zsh/fish.
- `gen/emit/cli/skills.test.ts` — the agent skills/docs bundle ships with the CLI.
- `gen/emit/cli/binary.test.ts` — bytes to stdout or `--output <file>`; pipe-safe.

- `conformance/cli.test.ts` — the generated CLI runs the shared conformance matrix (incl. `--json`/exit-codes/`--output` binary/discovery) against the live reference server (dx/conformance.md).

## Security corpus
- shared string-escape (F2); no secret in `--verbose` logs.

## Budget
- token: the discovery index + per-command help are the measured CLI surface for the token budget (H6).
