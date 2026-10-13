# dx — CLI (generated)

The generated CLI is Go, compiled to a single static native binary — the end user needs no Go and no Node runtime (this is the zero-setup advantage over cf's TypeScript/Node CLI). v1 raises it to the cf bar at the schema level (E1).

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| command per operation | — | — | one command per OpenAPI operation, grouped by the dotted operationId resource tree | verbs are consistent at the schema level (list/get/create/update/delete) | `emit/cli/commands.test.ts` |
| `--json` | no | off | uniform machine-readable output on every command | uniform shape so an agent parses one format | `emit/cli/output.test.ts` |
| output formats (json/ndjson/yaml/table) | no | table | human and machine formats | compact-for-agent output is the default under `--json` | `emit/cli/output.test.ts` |
| `--api-key` / `--base-url` / `--config` / `--timeout` / `--verbose` | no | from config/env | auth, target, config file, deadline, logging | precedence: flag > env > config file | `emit/cli/flags.test.ts` |
| command discovery | — | on | **[E1]** a machine-listable command index for agents | agents enumerate capabilities without scraping help text | `emit/cli/discovery.test.ts` |
| local/remote indicator | — | — | **[E1]** shows whether a command hits local or remote | — | `emit/cli/indicator.test.ts` |
| shell completion | no | — | **[E1]** bash/zsh/fish completion | — | `emit/cli/completion.test.ts` |
| agent skills/docs bundle | — | emitted | **[E1]** a skills/docs bundle shipped with the CLI for agents | part of the token-budget surface | `emit/cli/skills.test.ts` |
| binary response | — | — | **[A1]** writes bytes to stdout or `--output <file>` | pipe-safe; no mojibake on binary | `emit/cli/binary.test.ts` |
| exit codes | — | usage/standard | non-zero on usage error vs runtime error | distinguishable for scripts | `emit/cli/commands.test.ts` |
