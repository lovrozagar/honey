# The generated CLI

`honey-clients generate --target cli` writes a Go command-line client: one command per operation, grouped
by its dotted `operationId`, with `--help`, `commands` and `schema` describing every call and an embedded `SKILL.md`
for agents. It reads its base URL and credentials from flags, the environment or a config file, and it ships with a
release workflow and install scripts; see the CLI release page.

## Example

```sh
honey-clients generate --spec openapi.json --target cli --out ./cli --repo acme/shop-cli
```

## Reference

| Value                                                               | Default         | What it does                                                                       | Watch for                                                                |
| ------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| command per operation                                               | —               | one command per OpenAPI operation, grouped by the dotted operationId resource tree | verbs are consistent at the schema level (list/get/create/update/delete) |
| `--json`                                                            | off             | uniform machine-readable output on every command                                   | uniform shape so an agent parses one format                              |
| output formats (json/ndjson/yaml/table)                             | table           | human and machine formats                                                          | compact-for-agent output is the default under `--json`                   |
| `--api-key` / `--base-url` / `--config` / `--timeout` / `--verbose` | from config/env | auth, target, config file, deadline, logging                                       | precedence: flag > env > config file                                     |
| command discovery                                                   | on              | a machine-listable command index for agents                                        | agents enumerate capabilities without scraping help text                 |
| local/remote indicator                                              | —               | shows whether a command hits local or remote                                       | —                                                                        |
| shell completion                                                    | —               | bash/zsh/fish completion                                                           | —                                                                        |
| agent skills/docs bundle                                            | emitted         | a skills/docs bundle shipped with the CLI for agents                               | part of the token-budget surface                                         |
| binary response                                                     | —               | writes bytes to stdout or `--output <file>`                                        | pipe-safe; no mojibake on binary                                         |
| exit codes                                                          | usage/standard  | non-zero on usage error vs runtime error                                           | distinguishable for scripts                                              |
