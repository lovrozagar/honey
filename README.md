# Honey

Type-safe API framework on Web Standards. Builder-pattern DX, precompiled radix-tree router, OpenAPI, and generated clients for TypeScript, Python, Go, and Rust.

This repo is the source of the [`@lovrozagar/honey`](https://www.npmjs.com/package/@lovrozagar/honey) npm package. The CLI binary is still `honey`.

## Table of contents

- [Start](#start)
- [What Honey is](#what-honey-is)
- [Install](#install)
- [First app](#first-app)
- [CLI](#cli)
  - [`honey init`](#honey-init)
  - [`honey generate`](#honey-generate)
- [Builder](#builder)
  - [Routes and methods](#routes-and-methods)
  - [Context](#context)
  - [Input](#input)
  - [Output](#output)
  - [Errors](#errors)
  - [Middleware](#middleware)
  - [Composition](#composition)
- [Serve](#serve)
  - [Bun, Node, Deno](#bun-node-deno)
  - [Cloudflare Workers](#cloudflare-workers)
  - [Feature auto-load](#feature-auto-load)
- [OpenAPI, docs, and manifest](#openapi-docs-and-manifest)
- [WebSockets and realtime](#websockets-and-realtime)
- [Generated clients](#generated-clients)
- [Type inference](#type-inference)
- [Package exports](#package-exports)
- [Repository layout](#repository-layout)
- [Develop](#develop)
  - [Test matrix](#test-matrix)
  - [E2E apps and runtimes](#e2e-apps-and-runtimes)
  - [Live Cloudflare proof](#live-cloudflare-proof)
  - [Bench](#bench)
- [License](#license)

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

Generated TypeScript, Python, Go, and Rust clients: [SDK index](packages/core/docs/sdk.md).

## What Honey is

Honey is a single TypeScript builder that becomes a Web-standard `fetch(request, env)` handler. The same app runs on Bun, Node, Deno, and Cloudflare Workers.

- **Builder DX.** `honey().get("/users/:id").input(...).handler(...)` is how you write routes. Types flow from path params, Standard Schema input, output maps, and middleware additions into `ctx`.
- **Radix tree.** Routes compile into a radix tree. Production can load a generated tree so unknown paths 404 without walking a catch-all.
- **Web Standards.** Handlers see `Request` and return `Response`. `app.fetch()` is the public entry. On Node, `serve()` wraps `IncomingMessage` / `ServerResponse` so the hot path does not build a native Fetch pair.
- **OpenAPI from the app.** `app.openapi()` serves JSON and YAML from the same document. Scalar or Swagger mounts at `/docs`. Spec and docs routes are internal — they do not appear in the spec they serve.
- **Clients from the spec.** `honey generate` writes route types, a manifest, OpenAPI, and optional SDKs (TypeScript, Python, Go, Rust) plus an optional Go CLI.

Honey is not Express with types bolted on. There is no `req.body` parser stack. Input is declared per route with Standard Schema (Zod, Valibot, ArkType, and others).

## Install

Requires [Bun](https://bun.sh) 1.3+ to develop this repo. Consumers can run the published `honey` package on Bun, Node, Deno, or Workers.

```bash
bun add @lovrozagar/honey
# or
npm add @lovrozagar/honey
# or
pnpm add @lovrozagar/honey
```

The CLI ships with the package (`honey` in `package.json` `bin`). After install:

```bash
honey init
honey generate
```

Peer-free runtime: the published package depends only on `jiti` for generate/watch. Validation libraries are your choice.

## First app

`honey init` is the supported scaffold.

```bash
mkdir my-api && cd my-api
bun init -y
bun add @lovrozagar/honey
honey init
bun run dev
```

That writes:

| File | Role |
|---|---|
| `src/app.ts` | App export: health route + `openapi({ docs: "scalar" })` |
| `src/server.ts` | `await app.serve({ port })` |
| `vite.config.ts` | `honey({ app: "src/app.ts" })` plugin |

Scripts added to `package.json`: `dev` (runs `src/server.ts`) and `generate` (`honey generate`).

Cloudflare from the start:

```bash
honey init --cf
```

Also writes `src/worker.ts` (`export default { fetch }`) and `wrangler.jsonc`. Existing files refuse to overwrite unless you pass `--force`.

## CLI

```
honey generate [--watch] [--config <path>] [--app <path>] [flags]
honey init [--cf] [--force]
```

### `honey init`

| Flag | Meaning |
|---|---|
| `--cf` | Also write a Workers entry and `wrangler.jsonc` |
| `--force` | Overwrite `src/app.ts`, `src/server.ts`, `vite.config.ts` if they exist |

### `honey generate`

Reads the Vite `honey()` plugin config (default `vite.config.ts`) and writes `src/_gen/` next to the app.

| Flag | Meaning |
|---|---|
| `--watch` | Regenerate when the route tree checksum changes. Ignores `_gen` / `.gen.*` |
| `--config <path>` | Vite config to load |
| `--app <path>` | App module, overrides plugin `app` |
| `--tree` | Write the generated route tree |
| `--types` | Write TypeScript route types |
| `--manifest` | Write `manifest.gen.json` |
| `--sdk` | Write language SDKs configured on the plugin |
| `--cli` | Write the Go CLI |

Jiti loads the app and the Vite config with `fsCache` and `moduleCache` off, so a second generate after you add a route is not stale.

Typical plugin config:

```ts
import { honey } from "@lovrozagar/honey/plugin"

export default {
  plugins: [
    honey({
      app: "src/app.ts",
    }),
  ],
}
```

## Builder

```ts
import { honey } from "@lovrozagar/honey"
import * as z from "zod"

const app = honey<{ DATABASE_URL: string }>()
  .basePath("/api")
  .trailingSlash("strip")
  .get("/health")
  .handler((ctx) => ctx.res.json("ok", { status: "ok" }))

  .post("/users")
  .input({ json: z.object({ email: z.string().email(), name: z.string() }) })
  .output({ "application/json": { created: z.object({ id: z.string() }) } })
  .handler((ctx) => ctx.res.json("created", { id: "u-1" }))

await app.serve({ env: { DATABASE_URL: process.env.DATABASE_URL! }, port: 3000 })
```

### Routes and methods

`.get`, `.post`, `.put`, `.patch`, `.delete`, `.options`, `.all`, and `.on(methods, path)` register HTTP routes.

Path params are parsed from the pattern:

```ts
app.get("/orgs/:orgId/members/:memberId").handler((ctx) => {
  ctx.params.orgId
  ctx.params.memberId
  return ctx.res.json("ok", ctx.params)
})
```

- `trailingSlash("ignore" | "strip" | "enforce")` — `strip` 308s `/health/` → `/health`; `enforce` 308s the other way.
- `basePath("/api")` prefixes every later route.
- `stripPrefix("/app")` rewrites inbound paths (gateway style). It does not lock the route to that prefix.

Static paths use an O(1) map. Dynamic and wildcard segments walk the radix tree.

### Context

`ctx` is a `HoneyContext`:

| Field | Meaning |
|---|---|
| `ctx.req` | Web `Request` (on Node serve, a Request-shaped wrapper) |
| `ctx.res` | `HoneyRes` — `json`, `text`, `html`, `csv`, `xml`, `binary`, `noContent`, `redirect`, `sse`, `stream`, `generate`, `raw` |
| `ctx.env` | Bindings you passed to `fetch` / `serve` |
| `ctx.params` | Path params |
| `ctx.search` / `ctx.searchAll` | First value / all values of the query string (lazy) |
| `ctx.headers` / `ctx.cookies` | Lazy records |
| `ctx.input` | Validated input when `.input()` is declared |
| `ctx.errors` | Typed error factory when `.errorFactory()` is set |
| `ctx.meta` | Route `.meta()` object |
| `ctx.background(promise)` | `waitUntil` on Workers, otherwise fire-and-forget |

`ctx.res.json("ok", data)` is branded at the type level (`TypedResponse<"application/json", "ok">`) and is a real `Response` on Bun / Workers. On Node `serve()`, known-size bodies skip `new Response()` and write with `writeHead` / `end`.

Reserved keys (`req`, `res`, `env`, `params`, `headers`, `cookies`, `search`, `background`) cannot be overwritten by `next({ ... })`.

### Input

`.input()` takes Standard Schema objects:

```ts
app
  .post("/in/all/:resourceId")
  .input({
    json: z.object({ title: z.string() }),
    search: z.object({ draft: z.coerce.boolean().optional() }),
    headers: z.object({ "x-request-id": z.string() }),
    cookies: z.object({ sid: z.string() }),
  })
  .handler((ctx) => {
    ctx.input.json.title
    ctx.params.resourceId
    return ctx.res.json("ok", { ok: true })
  })
```

JSON vs form is selected from `Content-Type`. Multipart uses `req.formData()`. `readableStream` from `honey/input` leaves the body for the handler.

Invalid input is `400` with `error_key` and `fields`.

### Output

`.output()` maps content type → status key → schema:

```ts
app
  .post("/items")
  .output({
    "application/json": {
      created: z.object({ id: z.string() }),
      ok: z.object({ id: z.string() }),
    },
  })
  .handler((ctx) => ctx.res.json("created", { id: "1" }))
```

`.outputValidation("off" | "dev" | "always")` controls runtime checks. `"dev"` validates when `NODE_ENV !== "production"`. Mismatch is `500` (`output_validation_failed` or `output_content_type_mismatch`).

### Errors

```ts
import { defineErrors, HoneyError, honey } from "@lovrozagar/honey"

const errors = defineErrors({
  unauthorized: "unauthorized",
  org_slug_taken: "conflict",
  api_error: "internal_server_error",
})

const app = honey()
  .errorFactory(errors)
  .defaultErrors("unauthorized")
  .defaultBoundary("api_error")
  .onError((error, ctx) => {
    if (error instanceof HoneyError && error.errorKey === "org_slug_taken") {
      return ctx.jsonFromError(error)
    }
    return undefined
  })
```

Throw `ctx.errors.org_slug_taken({ vars: { slug } })` from a handler. The JSON body includes `error_key`, `status`, `status_key`, `message`, and optional `fields` / `vars`.

`.errorI18n({ errors, resolveLocale })` translates messages. That feature is loaded when you call it (or `import "@lovrozagar/honey/i18n"`).

### Middleware

```ts
import { createMiddleware } from "@lovrozagar/honey"
import { cors } from "@lovrozagar/honey/cors"
import { bodyLimit } from "@lovrozagar/honey/body-limit"
import { requestId } from "@lovrozagar/honey/request-id"

const withAuth = createMiddleware(async (ctx, next) => {
  const token = ctx.req.headers.get("authorization")
  if (!token) throw ctx.errors.unauthorized()
  return next({ user: { id: "u-1" } })
})

app.use(cors({ origin: "https://app.example.com" }))
app.use(bodyLimit({ maxSize: 1_048_576 }))
app.use(requestId())
app.use(withAuth)
```

`createMiddleware` infers additions from `next({ ... })`. `.use("/admin", mw)` is prefix-scoped.

Shipped middleware (import from the matching `honey/...` path): `cors`, `csrf`, `body-limit`, `logger`, `curl-logger`, `request-id`, `etag`, `timeout`, `secure-headers`, `server-timing`, `ip-restrict`, `powered-by`, `pretty-json`, `static`, `proxy`.

### Composition

- `.route(sub)` merges another Honey instance into this one (routes, realtime, taps, static map).
- `.use()` / `.basePath()` / `.context()` / `.meta()` clone the builder and share the route graph with the parent.
- `.taps<{ audit: Payload }>()` plus `ctx.tap("audit", payload)` runs after a successful handler.

`app.fetch(request, env)` is always valid. Sync handlers return a `Response` directly; async handlers and middleware return a `Promise<Response>`. Callers should `await app.fetch(...)`.

## Serve

### Bun, Node, Deno

```ts
await app.serve({
  port: 3000,
  hostname: "0.0.0.0",
  cors: true,              // or a CORS options object
  env: { DATABASE_URL },
  runtime: "bun",          // optional; detected if omitted
})
```

Returns `{ url, port, hostname, runtime, close() }`.

| Runtime | How it listens |
|---|---|
| Bun | `Bun.serve({ fetch })` + `honey/ws/bun` |
| Node | `node:http` + `honey/serve` + `honey/ws/node` |
| Deno | `Deno.serve` + `honey/ws/deno` |

On Node, import `honey/serve` (or call `app.serve()`, which loads it) so the listen implementation is registered. The Node adapter wraps `IncomingMessage` instead of `new Request()` on the inbound hot path, and writes known JSON/text bodies with `res.end` instead of draining a Fetch `Response`.

`runtime: "cloudflare"` throws. Workers cannot listen.

### Cloudflare Workers

```ts
import { cfWebSocket } from "@lovrozagar/honey/ws/cloudflare"
import { app } from "./app.ts"

app.wsAdapter(cfWebSocket())

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
}
```

`honey init --cf` writes this stub. Local e2e uses wrangler / workerd. The live proof worker is documented under [Live Cloudflare proof](#live-cloudflare-proof).

### Feature auto-load

`honey()` stays fetch-only until you opt in:

| Call or import | Loads |
|---|---|
| `app.serve()` or `import "@lovrozagar/honey/serve"` | Listen adapters |
| `app.openapi()` or `import "@lovrozagar/honey/openapi"` | Spec + docs |
| `app.errorI18n()` or `import "@lovrozagar/honey/i18n"` | Error i18n |

Production bundles that only call `app.fetch` do not pull listen, OpenAPI, or i18n code. The load uses an opaque `import(["@lovrozagar/honey", name].join("/"))` so bundlers do not follow unused feature entries.

## OpenAPI, docs, and manifest

```ts
app.openapi({
  title: "My API",
  version: "1.0.0",
  docs: "scalar",          // or "swagger"
  // docsPath: "/docs",
})

app.manifest()
```

Served (cached, invalidated when the route graph changes):

| Path | Body |
|---|---|
| `/openapi.json` | OpenAPI 3.1 |
| `/openapi.yaml` / `/openapi.yml` | Same document as YAML |
| `/docs` | Scalar or Swagger UI pointing at the JSON spec |
| `/manifest.json` | Route methods, paths, middleware names, error keys |

Those routes are marked internal. They do not appear inside the spec or the manifest. Generate writes the same JSON/YAML to `src/_gen/` for clients.

`.meta({ operationId, tags, summary })` on a route feeds the document.

## WebSockets and realtime

Two APIs:

- **`.ws(path).handler(ws)`** — raw WebSocket. You get `open` / `message` / `close` and send on the socket. Use this for echo, rooms you own, or protocol you control.
- **`.realtime(path, { handler })`** — Honey’s realtime protocol (rooms, publish, reconnect buffer). REST handlers can `ctx.realtime.publish(topic, data)` to connected sockets.

`app.serve()` attaches the runtime adapter. On Cloudflare, call `app.wsAdapter(cfWebSocket())` yourself.

A GET without `Upgrade: websocket` to a WS/realtime path returns `426`.

The kitchen e2e app covers echo, reconnect tokens, chat rooms, and REST publish. Cloudflare’s isolate-local bus does not cross isolates — REST publish to another connection is skipped on the CF e2e env.

## Generated clients

One OpenAPI document, four printers. See [packages/core/docs/sdk.md](packages/core/docs/sdk.md) for the capability matrix and snippets.

| Language | Output |
|---|---|
| TypeScript | `sdk.client.gen.ts`, types, map, optional realtime runtime |
| Python | `sdk/` package, async + sync |
| Go | module (`replace` in go.mod) |
| Rust | Cargo crate (`path = "..."`) |

Parity includes typed operations, typed errors, `onAuthExpired` + one 401 retry, cancellation, per-call timeout/headers, request/response hooks, invalidation, SSE, realtime, WebSocket, and streaming bodies. Python and Rust also emit a sync runtime.

`honey generate --cli` emits a Go CLI from the same IR.

## Type inference

All of these are exported from `honey` and describe the *app you built*, not a looser guess:

| Type | Meaning |
|---|---|
| `InferRoutes<typeof app>` | Path → methods → input/output/errors |
| `InferRoutePaths<typeof app>` | Union of paths |
| `InferRouteMethods<typeof app, Path>` | Methods on one path |
| `InferRouteInput<typeof app, Path, Method>` | Validated input |
| `InferRouteOutput<typeof app, Path, Method>` | Output map |
| `InferRouteErrors<typeof app, Path, Method>` | Declared error keys |
| `InferCtx<typeof app>` | Handler context (no `res` brand) |
| `InferEnv<typeof app>` | `ctx.env` |
| `InferMeta<typeof app>` | App-level meta |
| `InferErrorFactory<typeof app>` | Error factory |
| `InferBasePath<typeof app>` | Base path string |

Use them in tests and in hand-written clients when you are not generating an SDK.

## Package exports

Import features from their path. Do not expect `import { cors } from "@lovrozagar/honey"` — cors lives at `honey/cors`.

| Export | Purpose |
|---|---|
| `honey` | Builder, context, errors, `app.fetch` / `app.serve` types |
| `honey/serve` | Register Node/Bun/Deno listen |
| `honey/openapi` | Register spec generation |
| `honey/i18n` | Register error i18n |
| `@lovrozagar/honey/plugin` | Vite plugin + `generateFromApp` |
| `honey/client` / `honey/client/sdk` | Typed TS client runtime |
| `honey/cors`, `honey/csrf`, `honey/body-limit`, `honey/logger`, `honey/etag`, `honey/timeout`, `honey/request-id`, `honey/secure-headers`, `honey/server-timing`, `honey/ip-restrict`, `honey/powered-by`, `honey/pretty-json`, `honey/static`, `honey/proxy`, `honey/curl-logger` | Middleware |
| `honey/input` | `readableStream()` helper |
| `honey/testing` | `testClient` + cookie jar |
| `honey/ws/bun`, `honey/ws/node`, `honey/ws/deno`, `honey/ws/cloudflare` | WS adapters |
| `honey/node` | Low-level Node `serve()` |
| `honey/codegen` | Generate SDKs from a spec |
| `honey/build` | `createBuildPlugin` for per-target production artifacts |

## Repository layout

```
packages/core/     published `honey` package (src, tests, docs, examples)
e2e/apps/          consumer apps (kitchen, defaults, compose, surface, gateway)
e2e/{bun,node,deno,cf-workers}/   runtime hosts + Playwright
e2e/run.ts         env × app runner
bench/             bombardier vs Hono / Elysia / Express / Nest (bun + node)
```

`e2e/apps/*` own the tests. Runtimes only listen. `HONEY_E2E_APP` and `HONEY_E2E_ENV` select which app and host.

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
bun run lint                 # oxlint
bun run lint:fix             # oxlint --fix
bun run fmt                  # oxfmt
bun run fmt:check            # oxfmt --check
```

Opt-in locally (CI `harness` job runs the first one):

```bash
bun run test:harness       # TS / Go / Python / Rust / MCP compile + behavioral
bun run test:harness:rust  # rust-only subset of the same loop
bun run test:all           # default suite + language harnesses
```

Typecheck stays strict. Do not weaken `strict` or add `as any` to make it pass.

### Test matrix

| Command | What it proves |
|---|---|
| `bun run test` | Core unit + integration. Default CI gate. |
| `bun run test:consumers` | Each e2e app imports `honey` and hits a few routes in-process. |
| `bun run test:e2e` | Playwright against Bun listen, every app. |
| `bun run test:e2e:node` | Same tests, Node (`tsx`) listen. |
| `bun run test:e2e:deno` | Same tests, Deno listen. |
| `bun run test:e2e:cf` | Same tests, local workerd. Kitchen REST publish is skipped (`HONEY_E2E_ENV=cf`). |
| `bun run test:harness` | Generated SDKs compile and behave. |

```bash
bun e2e/run.ts --env node --app kitchen
bun e2e/run.ts --env all --app surface
bun e2e/run.ts --env bun --mode prod
```

### E2E apps and runtimes

| App | Covers |
|---|---|
| `kitchen` | Auth, CRUD, i18n, OpenAPI, SSE, WS, realtime, trailing slash, errors |
| `defaults` | Empty-middleware app, root OpenAPI, no CORS by default |
| `compose` | `.route()` groups, Scalar collision with a user `/docs` |
| `surface` | Every input source, output type, method, SSE, WS, uploads |
| `gateway` | `stripPrefix` + enforce slash, Swagger behind a prefix |

Runtimes: `e2e/bun`, `e2e/node`, `e2e/deno`, `e2e/cf-workers`.

### Live Cloudflare proof

Same kitchen app on workerd: https://honey-cf-e2e.lovro-zagar5.workers.dev

See `e2e/cf-workers/README.md`. Redeploy with `bun run deploy:e2e:cf`. Live soak: `bun run test:live:cf`.

### Bench

`bench/` compares Honey, Hono, Elysia, Express, and Nest on Bun and Node (naked + Zod). Bombardier, 10s / 100 connections, localhost.

```bash
bun run --filter @honey/bench build:all
bun run --filter @honey/bench bench:bun
bun run --filter @honey/bench bench:node
```

Numbers and bundle sizes: [`bench/RESULTS.md`](bench/RESULTS.md).

Python runtime tests skip without `httpx` (`pip install httpx`). Rust cargo tests skip without `cargo` or when `HONEY_RUST_INTEGRATION=0`. Go tests skip without `go`. Cargo artifacts go to `.cache/cargo-target`, not `/tmp`.

## License

MIT
