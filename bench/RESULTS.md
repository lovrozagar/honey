# Bench snapshot

Recorded 2026-08-14 on this machine (AMD Ryzen 7 9800X3D, Linux x86_64). Bombardier **10s / 100 connections**, localhost.

Two environments, two matrices each:

| Command | Runtime | How servers start |
|---|---|---|
| `bun run bench:bun` | Bun 1.3.11 | `bun dist/bun/...` (`--target bun`) |
| `bun run bench:node` | Node 25.5.0 | `node dist/node/...` (`--target node`) |

- **Naked** — framework only. Routes: `GET /json`, `GET /params/:id`, `GET /middleware`.
- **Zod** — same `zod@4.3.6`. Honey `.input()`, Hono `@hono/zod-validator`, Elysia Standard Schema `body`, Express/Nest `zod.parse`.

Listen path differs by env:

| Framework | Bun | Node |
|---|---|---|
| Honey | `Bun.serve({ fetch })` | `app.serve({ runtime: "node" })` + `import "honey/serve"` |
| Hono | `Bun.serve({ fetch })` | `@hono/node-server` |
| Elysia | `app.listen()` (Bun) | `@elysia/node` adapter |
| Express | `app.listen()` | same |
| Nest | `bun run` TS | `tsx` TS (cannot bun-bundle) |

Bun ports `3100–3104`. Node ports `3300–3304`. Nest size is n/a.

Zero 4xx/5xx on every recorded scenario below.

## Bun — naked

| Framework | Raw | Gzip |
|---|---|---|
| Honey | 55 KB | 15 KB |
| Hono | 20 KB | **8 KB** |
| Elysia | 376 KB | 104 KB |
| Express | 803 KB | 267 KB |
| Nest | n/a | n/a |

| Scenario | Honey | Hono | Elysia | Express | Nest |
|---|---|---|---|---|---|
| GET `/json` | 246k | 273k | **384k** | 155k | 128k |
| GET `/params/42` | 241k | 252k | **379k** | 151k | 115k |
| GET `/middleware` | 244k | 224k | **348k** | 139k | 109k |

## Bun — zod

| Framework | Raw | Gzip |
|---|---|---|
| Honey | 123 KB | 34 KB |
| Hono | 92 KB | **28 KB** |
| Elysia | 444 KB | 122 KB |
| Express | 871 KB | 285 KB |
| Nest | n/a | n/a |

| Scenario | Honey | Hono | Elysia | Express | Nest |
|---|---|---|---|---|---|
| GET `/json` | 251k | 269k | **309k** | 135k | 124k |
| GET `/params/42` | 237k | 259k | **381k** | 149k | 113k |
| POST `/validate` | 188k | 176k | **225k** | 96k | 83k |
| GET `/middleware` | 243k | 227k | **342k** | 129k | 112k |

## Node — naked

| Framework | Raw | Gzip |
|---|---|---|
| Honey | 112 KB | 32 KB |
| Hono | 43 KB | **16 KB** |
| Elysia | 468 KB | 132 KB |
| Express | 582 KB | 229 KB |
| Nest | n/a | n/a |

Honey’s Node bundle includes `honey/serve` + the Node HTTP/WS adapter. That is why it is 32 KB gzip here vs 15 KB on Bun fetch-only.

| Scenario | Honey | Hono | Elysia | Express | Nest |
|---|---|---|---|---|---|
| GET `/json` | 80k | 150k | **165k** | 90k | 81k |
| GET `/params/42` | 75k | 145k | **162k** | 85k | 76k |
| GET `/middleware` | 78k | 131k | **152k** | 85k | 74k |

## Node — zod

| Framework | Raw | Gzip |
|---|---|---|
| Honey | 180 KB | 50 KB |
| Hono | 114 KB | **35 KB** |
| Elysia | 536 KB | 150 KB |
| Express | 651 KB | 247 KB |
| Nest | n/a | n/a |

| Scenario | Honey | Hono | Elysia | Express | Nest |
|---|---|---|---|---|---|
| GET `/json` | 82k | 149k | **164k** | 89k | 80k |
| GET `/params/42` | 79k | 147k | **159k** | 86k | 74k |
| POST `/validate` | 54k | **99k** | 88k | 65k | 56k |
| GET `/middleware` | 82k | 101k | **150k** | 81k | 69k |

## Read

On **Bun**, Honey ≈ Hono. Elysia owns raw GET. Honey wins validate and middleware vs Hono. Express/Nest are 1.6–2× slower than Honey and much fatter.

On **Node**, everyone drops. Elysia still leads GET (~165k vs Honey 80k), but it is no longer 380k. Hono’s Node adapter is the second-fastest. Honey’s Node `serve()` path is in the Express band on JSON (~80k vs Express 90k) and loses validate to Hono. That is the adapter tax, not the router: same Honey fetch core, `node:http` + WS wiring around it.

Express and Nest look less broken on Node than on Bun, because that is their I/O. They still do not catch Hono or Elysia.

```bash
bun run --filter @honey/bench build:all   # bun + node bundles
bun run --filter @honey/bench bench:bun
bun run --filter @honey/bench bench:node
```
