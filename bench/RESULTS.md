# Bench snapshot

Recorded 2026-08-14 on this machine. Bun runtime, `bun build --minify --target bun`, bombardier **10s / 100 connections**. Two matrices, same machine, same run. After the core/openapi/serve split and auto-load.

- **Naked** — framework only. No zod. Routes: `GET /json`, `GET /params/:id`, `GET /middleware`.
- **Zod** — same three frameworks, same `zod@4.3.6`. Honey `.input()`, Hono `@hono/zod-validator`, Elysia 1.4 Standard Schema `body`. Plus the naked routes.

Zero 4xx/5xx on every scenario.

## Naked — framework only

| Framework | Raw | Gzip |
|---|---|---|
| Honey | 55 KB | 15 KB |
| Hono | 20 KB | **8 KB** |
| Elysia | 374 KB | 103 KB |

| Scenario | Honey | Hono | Elysia |
|---|---|---|---|
| GET `/json` | 248k | 270k | **386k** |
| GET `/params/42` | 240k | 257k | **380k** |
| GET `/middleware` | **250k** | 228k | 351k |

Latency averages: Honey ~399–417µs, Hono ~369–438µs, Elysia ~258–284µs.

## Zod — same validator

| Framework | Raw | Gzip |
|---|---|---|
| Honey | 123 KB | 34 KB |
| Hono | 92 KB | **28 KB** |
| Elysia | 443 KB | 122 KB |

The jump from naked is almost all `zod` (Honey +68 KB raw, Hono +71 KB). Elysia pays zod on top of TypeBox.

| Scenario | Honey | Hono | Elysia |
|---|---|---|---|
| GET `/json` | 253k | 274k | **382k** |
| GET `/params/42` | 240k | 253k | **382k** |
| POST `/validate` | **193k** | 179k | 233k |
| GET `/middleware` | **246k** | 221k | 345k |

Latency averages: Honey ~395–518µs, Hono ~365–559µs, Elysia ~261–429µs.

## Read

Honey ≈ Hono on RPS: Hono wins the hot GETs (~8–10%), Honey wins validate (~8%) and middleware (~10–11%). Elysia still owns raw GET throughput and is 5–7× fatter.

Fetch-only Honey is 15 KB gzip vs Hono’s 8 KB. Listen adapters, i18n, and docs UI load when `app.serve()` / `errorI18n()` / `openapi()` are actually used. Remaining size gap is the router/context/validation core, not leaked codegen.
