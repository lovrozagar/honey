# Honey

Type-safe API framework on Web Standards. Builder-pattern DX, precompiled radix-tree router, OpenAPI and multi-language SDK codegen.

This repo is the source of the `honey` npm package.

## Layout

```
packages/core     published package (honey)
examples/*        consumer apps used while iterating
e2e/app           shared e2e app
e2e/*             runtime harnesses (bun, node, deno, cf-workers)
bench             throughput benches vs hono / elysia
```

`packages/core` is the only published workspace. Examples and `e2e/*` are the consumer proof — they import `honey` over `workspace:*` the way a real app would.

## Develop

Requires [Bun](https://bun.sh) 1.3+.

```bash
bun install
bun run generate        # honey generate for examples + e2e-app (OpenAPI JSON + YAML)
bun run test            # core unit + in-process integration (default CI)
bun run test:consumers  # e2e-app imports honey like a real app
bun run test:e2e        # Playwright against the bun runtime
bun run typecheck            # core src (TypeScript 7)
bun run typecheck:consumers  # examples + e2e-app + generated types
```

Opt-in:

```bash
bun run test:harness       # Go / TS / Python compile + TS/Go/MCP behavioral (skip Python runtime if no httpx)
bun run test:harness:rust  # Rust SDK compile + behavioral — still red, emit drift
bun run test:all      # full vitest tree, including remaining schema/SDK stale files
```

Node / Deno / Cloudflare Worker Playwright suites stay opt-in (`e2e/node`, `e2e/deno`, `e2e/cf-workers`).

Python harnesses need `httpx` (`pip install httpx`). Rust/Go harnesses need `cargo` and `go`.

## Package

Consumers import `honey` and its subpath exports (`/client`, `/codegen`, `/plugin`, `/node`, `/ws/bun`, …). The `honey` CLI lives on the same package.

```ts
import { honey, defineErrors } from "honey"
```

## License

MIT
