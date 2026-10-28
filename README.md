# Honey

A typed web framework for the Fetch API, and the code generator that turns an app into clients. One app runs on Node,
Bun and Cloudflare Workers; its routes generate an OpenAPI 3.1 document, a route manifest, and typed SDKs in six
languages, a command-line client and an MCP server.

| Package                                               | What it is                                                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@lovrozagar/honey`](packages/core/README.md)        | The framework: routing, typed input and output, middleware, streaming, WebSockets and realtime, OpenAPI, the `honey` CLI and the Vite plugin |
| [`@lovrozagar/honey-codegen`](packages/gen/README.md) | `honey-codegen generate`: SDKs (TypeScript, Go, Rust, Python, C#, Java), a Go CLI and an MCP server from a document or a honey app           |

## Start

```sh
npm install @lovrozagar/honey
npx honey init
```

`honey init` writes `src/app.ts`, `src/server.ts` and a Vite config. The app it writes:

```ts
import { honey } from "@lovrozagar/honey"
import { serveOpenApi } from "@lovrozagar/honey/openapi"

export const app = serveOpenApi(
	honey()
		.get("/health")
		.handler((ctx) => ctx.res.text("ok", "ok")),
	{ docs: "scalar", title: "Honey", version: "0.0.1" },
)
```

The server, `serve(app)` from `@lovrozagar/honey/serve`:

```ts
import { honey } from "@lovrozagar/honey"
import { serve } from "@lovrozagar/honey/serve"

const app = honey()
app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

await serve(app, { port: Number(process.env.PORT ?? 3000) })
```

```sh
curl http://127.0.0.1:3000/health
# ok
# the API reference: open http://127.0.0.1:3000/docs
```

Then generate a client for it:

```sh
npx honey-codegen generate --app src/app.ts --target ts --out generated
```

## Documentation

[docs/](docs/README.md) covers each part of honey with an example its tests compile: routing, input and output,
middleware, streaming, WebSockets and realtime, the OpenAPI document, testing, code generation and the per-language
recipes, the generated CLI and MCP server, [every package export](docs/packages.md), and each capability new in 1.0.
Upgrading from 0.7: [the migration guide](docs/migration.md).

## Develop

The repository is a Bun workspace: `packages/core` is `@lovrozagar/honey`, `packages/gen` is
`@lovrozagar/honey-codegen`, `packages/core/tests/e2e` holds the end-to-end apps and runtimes, `bench/` the
benchmarks, `docs/` the documentation and `blueprint/` the design records.

```sh
bun install
bun run verify
```

`bun run verify` runs every gate in order and stops at the first failure: formatting, lint, type-checks, the tests,
the generated outputs, the consumer type-checks and tests, and the end-to-end matrix. CI runs the same gates on every
push, plus each SDK language's toolchain tests, the per-runtime end-to-end cells, the build tier and the packaging
tier. How the packages are built and what they ship: [packaging](packages/core/docs/packaging.md).

## Releases

Both packages share a version. Set it in `packages/core/package.json` and `packages/gen/package.json`, then push a
`vX.Y.Z` tag. The release workflow packs both tarballs, checks each version against the tag, runs CI on the tagged
commit, then publishes both to npm with provenance and creates the GitHub release.

## License

MIT
