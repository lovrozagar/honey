# Honey

A typed web framework for the Fetch API whose routes are the source of its clients. You write a route once, with its
input and output schemas; honey serves it on Node, Bun or Cloudflare Workers, and `honey-clients` turns the same
routes into an OpenAPI 3.1 document, typed SDKs for six languages, a command-line client and an MCP server.

Nothing is inferred at runtime: the schemas you declare are what the handler receives, what the document says, and
what every generated client's types promise.

This is the repository. **The guides are the two packages' own pages**, which is also what npm shows:

- [Packages](#packages)
- [Install](#install)
- [Documentation](#documentation)
- [Develop](#develop)
- [Releases](#releases)
- [License](#license)

## Packages

| Package                                               | What it is                                                                                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@lovrozagar/honey`](packages/core/README.md)        | The framework: routing, typed input and output, middleware, streaming, WebSockets and realtime, OpenAPI, the MCP mount, the `honey` CLI and the Vite plugin |
| [`@lovrozagar/honey-clients`](packages/gen/README.md) | `honey-clients generate`: SDKs (TypeScript, Go, Rust, Python, C#, Java), a Go CLI and an MCP server from a document or a honey app                          |

Each package's README is its complete guide: every export and every area, with examples the tests compile.

## Install

1.0 is out as a release candidate, published under npm's `next` tag, so an install without a tag still gives 0.7.3.
Add `@next` until the final release.

The framework, in the app:

```sh
npm install @lovrozagar/honey@next
npx honey init
```

The generator, as a dev dependency:

```sh
npm install --save-dev @lovrozagar/honey-clients@next
npx honey-clients generate --app src/app.ts --target ts --out generated
```

## Documentation

- [`@lovrozagar/honey`](packages/core/README.md) — the framework, end to end
- [`@lovrozagar/honey-clients`](packages/gen/README.md) — the generator, every target and flag
- [All the docs](docs/README.md) — a page per area, each example compiled by the tests
- [Migrating from 0.7](docs/migration.md)
- [Package exports](docs/packages.md) — every subpath either package exports
- [Packaging](packages/core/docs/packaging.md) — how a tarball is built and what it ships

## Develop

The repository is a Bun workspace: `packages/core` is `@lovrozagar/honey`, `packages/gen` is
`@lovrozagar/honey-clients`, `packages/core/tests/e2e` holds the end-to-end apps and runtimes, `bench/` the
benchmarks, `docs/` the documentation and `blueprint/` the design records.

```sh
bun install
bun run verify
```

`bun run verify` runs every gate in order and stops at the first failure: formatting, lint, type-checks, the tests,
the generated outputs, the consumer type-checks and tests, and the end-to-end matrix. CI runs the same gates on every
push, plus each SDK language's toolchain tests, the per-runtime end-to-end cells, the build tier and the packaging
tier.

## Releases

Both packages share a version. Set it in `packages/core/package.json` and `packages/gen/package.json`, then push a
`vX.Y.Z` tag. The release workflow packs both tarballs, checks each version against the tag and that CHANGELOG.md
carries that release's entry, runs CI on the tagged commit, then publishes both to npm with provenance and creates
the GitHub release.

Two rules the workflow enforces rather than trusts:

- **A release candidate is `vX.Y.Z-rc.N`** and publishes under npm's `next` tag, so `latest` keeps pointing at the
  last final release; its GitHub release is marked a prerelease. A candidate reads the release's own CHANGELOG entry,
  so `1.0.0-rc.1` needs `## 1.0.0` and no heading of its own.
- **A final release dates its entry.** Change `## X.Y.Z` to `## X.Y.Z - YYYY-MM-DD` in the same commit that sets the
  final version; the pack job refuses a final tag whose entry is still undated, which is what keeps the date from
  being an afterthought.

## License

MIT
