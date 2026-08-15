# Honey

Type-safe API framework on Web Standards. Builder-pattern DX, precompiled radix-tree router, OpenAPI, and generated clients.

This repo is the source of the `honey` npm package.

## Start

```bash
bun add honey
honey init
bun run dev
```

```ts
import { honey } from "honey"

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

Generated TypeScript, Python, Go, and Rust clients: [SDK index](packages/core/docs/sdk.md).

## Develop

`packages/core` is the published package. `e2e/*` imports `honey` over `workspace:*`.

Requires [Bun](https://bun.sh) 1.3+.

```bash
bun install
bun run generate        # honey generate for every e2e app
bun run test            # core unit + in-process integration (default CI)
bun run test:consumers  # e2e apps import honey like a real app
bun run test:e2e        # Playwright, bun × every e2e app
bun run test:e2e:node   # same matrix against Node (tsx)
bun run test:e2e:deno   # same matrix against Deno
bun run test:e2e:cf     # same matrix against local wrangler / workerd
bun run test:e2e:all    # bun + node + deno + local cf × every e2e app
bun run typecheck            # core src (TypeScript 7)
bun run typecheck:consumers  # every e2e app + generated types
```

Opt-in locally (CI `harness` job runs the first one):

```bash
bun run test:harness       # TS / Go / Python / Rust / MCP compile + behavioral
bun run test:harness:rust  # rust-only subset of the same loop
bun run test:all           # default suite + language harnesses
```

CI runs bun e2e in the `test` job and node / deno / cf-workers in a parallel `e2e` matrix.

Live Cloudflare proof (same e2e app, workerd): https://honey-cf-e2e.lovro-zagar5.workers.dev — see `e2e/cf-workers/README.md`. Redeploy with `bun run deploy:e2e:cf`.

Python runtime tests skip without `httpx` (`pip install httpx`). Rust cargo tests skip without `cargo` or when `HONEY_RUST_INTEGRATION=0`. Go tests skip without `go`. Cargo artifacts go to `.cache/cargo-target`, not `/tmp`.

## License

MIT
