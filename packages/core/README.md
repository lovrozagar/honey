# @lovrozagar/honey

A typed web framework for the Fetch API. One app runs on Node, Bun and Cloudflare Workers, and its routes generate
an OpenAPI 3.1 document, a route manifest and, through
[`@lovrozagar/honey-clients`](https://www.npmjs.com/package/@lovrozagar/honey-clients), typed SDKs in six languages, a
command-line client and an MCP server.

## Install

```sh
npm install @lovrozagar/honey
```

`bun add` and `pnpm add` work too. Node 22.12 or later, Bun 1.3 or later, or Cloudflare Workers.

## Start

`npx honey init` writes `src/app.ts`, `src/server.ts` and a Vite config (`--cf` adds a Worker and its
`wrangler.jsonc`). The app it writes:

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

And the server, `serve(app)` from `@lovrozagar/honey/serve` on Node and Bun:

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

`npx honey generate` writes the app's route tree, manifest, OpenAPI JSON and YAML and its types beside it.

## Documentation

- [The docs](https://github.com/lovrozagar/honey/blob/main/docs/README.md): routing, input and output, middleware,
  streaming, WebSockets and realtime, the OpenAPI document, testing, and every capability new in 1.0.
- [Generated SDKs, the CLI and MCP](https://github.com/lovrozagar/honey/blob/main/docs/codegen.md), and their
  [per-language recipes](https://github.com/lovrozagar/honey/blob/main/docs/sdk-recipes.md).
- [Every package export](https://github.com/lovrozagar/honey/blob/main/docs/packages.md).
- [Migrating from 0.7](https://github.com/lovrozagar/honey/blob/main/docs/migration.md).

## License

MIT
