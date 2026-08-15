# Honey

Type-safe API framework on Web Standards. Builder-pattern DX, precompiled radix-tree router, OpenAPI, and generated clients.

## Start

```bash
bun add @lovrozagar/honey
honey init
bun run dev
```

```ts
import { honey } from "@lovrozagar/honey"

export const app = honey()
  .get("/health")
  .handler((ctx) => ctx.res.text("ok", "ok"))
  .openapi({ docs: "scalar", title: "My API", version: "1.0.0" })

await app.serve({ cors: true, port: 3000 })
```

```bash
curl http://127.0.0.1:3000/health
# ok

curl http://127.0.0.1:3000/openapi.json
# open http://127.0.0.1:3000/docs
```

`honey init` writes `src/app.ts`, `src/server.ts`, `vite.config.ts`, and `dev` / `generate` scripts. `honey init --cf` also writes `wrangler.jsonc` and a worker that exports `fetch`.

`app.serve()` detects bun / node / deno and loads only that WebSocket adapter. Pass `runtime` to pin it. Cloudflare Workers cannot listen — export `fetch: (req, env, ctx) => app.fetch(req, env, ctx)`.

`app.serve()`, `app.openapi()`, and `app.errorI18n()` load their implementations when called. A fetch-only production bundle does not include listen adapters, spec generation, or i18n. Spec and docs routes stay out of the generated document.

```bash
honey generate          # writes src/_gen/
honey generate --watch
```

## Generated clients

Honey emits TypeScript, Python, Go, and Rust SDKs from the same spec. See [the SDK index](./docs/sdk.md).

Full framework guide (builder, serve, OpenAPI, WS, e2e, bench): the [repository README](https://github.com/lovrozagar/honey#table-of-contents).

## License

MIT
