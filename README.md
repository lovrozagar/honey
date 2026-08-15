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
bun run test            # core unit + in-process integration (default CI)
bun run test:consumers  # e2e-app imports honey like a real app
bun run typecheck       # core src (TypeScript 7)
```

Opt-in:

```bash
bun run test:harness  # Python / Go / Rust / MCP SDK harnesses
bun run test:e2e      # Playwright against the bun runtime
bun run test:all      # full vitest tree, including stale snapshots
```

Python harnesses need `httpx` (`pip install httpx`). Rust/Go harnesses need `cargo` and `go`.

## Package

Consumers import `honey` and its subpath exports (`/client`, `/codegen`, `/plugin`, `/node`, `/ws/bun`, …). The `honey` CLI lives on the same package.

```ts
import { honey, defineErrors } from "honey"
```

## License

MIT
