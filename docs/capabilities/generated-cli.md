# The generated CLI

`honey-clients generate --target cli` writes a Go command-line
client for your API, with the polish of a first-party one: a command per operation grouped by resource, `--help`
everywhere, `commands` and `schema` for discovery, typed flags, JSON and raw output, streams and pagination, and an
embedded `SKILL.md` for agents. It ships with a release workflow and install scripts that verify what they install;
see the CLI release page.

## Example

```sh
honey-clients generate --spec openapi.json --target cli --out ./cli --repo acme/shop-cli
shop orders list --status open --output json
```

Tested by: `integration/conformance/cli.test.ts`
