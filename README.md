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

`packages/core` is the only published workspace. Everything else exists to consume it the way a real app would.

## Develop

Requires [Bun](https://bun.sh) 1.3+.

```bash
bun install
bun test
```

Python SDK harness tests need `httpx` on the host (`pip install httpx`). Rust/Go harnesses need `cargo` and `go`.

```bash
bun run typecheck
```

## Package

Consumers import `honey` and its subpath exports (`/client`, `/codegen`, `/plugin`, `/node`, `/ws/bun`, …). The `honey` CLI lives on the same package.

```ts
import { honey, defineErrors } from "honey"
```

## License

MIT
