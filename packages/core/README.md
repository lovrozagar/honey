# Honey

Type-safe API framework on Web Standards. Builder-pattern DX, precompiled radix-tree router, OpenAPI, and generated clients for TypeScript, Python, Go, and Rust.

This repo is the source of the [`@lovrozagar/honey`](https://www.npmjs.com/package/@lovrozagar/honey) npm package. The CLI binary is still `honey`.

This README is the full usage manual. An agent that reads only this file should be able to build, serve, generate, and consume a Honey app without opening source.

## Table of contents

- [Start](#start)
- [What Honey is](#what-honey-is)
- [Install](#install)
- [First app](#first-app)
- [CLI](#cli)
  - [`honey init`](#honey-init)
  - [`honey generate`](#honey-generate)
- [Builder](#builder)
  - [Create the app](#create-the-app)
  - [Routes and methods](#routes-and-methods)
  - [Path matching](#path-matching)
  - [Prefixes and slashes](#prefixes-and-slashes)
  - [Context](#context)
  - [Responses](#responses)
  - [Status keys](#status-keys)
  - [Input](#input)
  - [Output](#output)
  - [Errors](#errors)
  - [Middleware](#middleware)
  - [Shipped middleware](#shipped-middleware)
  - [Composition](#composition)
  - [Taps](#taps)
  - [Proxy routes](#proxy-routes)
  - [Static files](#static-files)
  - [Logging, telemetry, production tree](#logging-telemetry-production-tree)
- [Serve](#serve)
  - [Bun, Node, Deno](#bun-node-deno)
  - [Cloudflare Workers](#cloudflare-workers)
  - [Feature auto-load](#feature-auto-load)
- [OpenAPI, docs, and manifest](#openapi-docs-and-manifest)
  - [Meta spec](#meta-spec)
- [WebSockets](#websockets)
- [Realtime](#realtime)
- [SSE and streaming](#sse-and-streaming)
- [Generated clients](#generated-clients)
  - [Plugin codegen config](#plugin-codegen-config)
  - [TypeScript `createClient`](#typescript-createclient)
  - [Generated SDK usage](#generated-sdk-usage)
  - [Go CLI](#go-cli)
  - [Programmatic codegen](#programmatic-codegen)
- [Type inference](#type-inference)
- [Testing](#testing)
- [Utilities](#utilities)
- [Package exports](#package-exports)
- [Repository layout](#repository-layout)
- [Develop](#develop)
  - [Test matrix](#test-matrix)
  - [E2E apps and runtimes](#e2e-apps-and-runtimes)
  - [Live Cloudflare proof](#live-cloudflare-proof)
  - [Bench](#bench)
- [Releases](#releases)
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

## What Honey is

Honey is a single TypeScript builder that becomes a Web-standard `fetch(request, env)` handler. The same app runs on Bun, Node, Deno, and Cloudflare Workers.

- **Builder DX.** `honey().get("/users/:id").input(...).handler(...)` is how you write routes. Types flow from path params, Standard Schema input, output maps, and middleware additions into `ctx`.
- **Radix tree.** Routes compile into a radix tree. Production can load a generated tree so unknown paths 404 without walking a catch-all.
- **Web Standards.** Handlers see `Request` and return `Response`. `app.fetch()` is the public entry. On Node, `serve()` wraps `IncomingMessage` / `ServerResponse` so the hot path does not build a native Fetch pair.
- **OpenAPI from the app.** `app.openapi()` serves JSON and YAML from the same document. Scalar or Swagger mounts at `/docs`. Spec and docs routes are internal — they do not appear in the spec they serve.
- **Clients from the spec.** `honey generate` writes route types, a manifest, OpenAPI, and optional SDKs (TypeScript, Python, Go, Rust) plus an optional Go CLI.

Honey is not Express with types bolted on. There is no `req.body` parser stack. Input is declared per route with Standard Schema (Zod, Valibot, ArkType, Effect Schema, Yup — anything that implements the Standard Schema `~standard` interface).

## Install

Requires [Bun](https://bun.sh) 1.3+ to develop this repo. Consumers can run the published package on Bun, Node, Deno, or Workers.

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

Peer-free runtime: the published package depends only on `jiti` for generate/watch. Validation libraries are your choice. Type generation (`codegen.types`) needs `ts-morph` as a **dev** dependency.

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

| File             | Role                                                     |
| ---------------- | -------------------------------------------------------- |
| `src/app.ts`     | App export: health route + `openapi({ docs: "scalar" })` |
| `src/server.ts`  | `await app.serve({ port })`                              |
| `vite.config.ts` | `honey({ app: "src/app.ts" })` plugin                    |

Scripts added to `package.json`: `dev` (runs `src/server.ts`) and `generate` (`honey generate`).

Cloudflare from the start:

```bash
honey init --cf
```

Also writes `src/worker.ts` (`export default { fetch }`) and `wrangler.jsonc`. Existing files refuse to overwrite unless you pass `--force`.

Minimal app without the scaffold:

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

## CLI

```
honey generate [--watch] [--config <path>] [--app <path>] [flags]
honey init [--cf] [--force]
```

Any other first argument prints usage and exits `1`.

### `honey init`

| Flag      | Meaning                                                                 |
| --------- | ----------------------------------------------------------------------- |
| `--cf`    | Also write a Workers entry and `wrangler.jsonc`                         |
| `--force` | Overwrite `src/app.ts`, `src/server.ts`, `vite.config.ts` if they exist |

### `honey generate`

Reads the Vite `honey()` plugin config (default `vite.config.ts`) and writes artifacts next to the app. Jiti loads the app and the Vite config with `fsCache` and `moduleCache` off, so a second generate after you add a route is not stale.

If there is no Vite config, you must pass `--app`.

| Flag                           | Meaning                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `--watch`                      | Regenerate when the route tree checksum changes. Ignores `_gen` / `.gen.*`. Requires `--app` or plugin `app`. |
| `--config <path>`              | Vite config to load (default `vite.config.ts`)                                                                |
| `--app <path>`                 | App module, overrides plugin `app`                                                                            |
| `--tree`                       | Enable writing the generated route tree                                                                       |
| `--types`                      | Enable writing TypeScript route types (needs `ts-morph`)                                                      |
| `--manifest`                   | Enable writing `manifest.gen.json`                                                                            |
| `--sdk`                        | Enable TypeScript SDK at `src/_gen` (same as `codegen.sdk: true`)                                             |
| `--cli`                        | Enable Go CLI; **requires** `--cli-out` and `--cli-binary-name`                                               |
| `--merge-tree <path>`          | Merge this generated tree into the write                                                                      |
| `--cli-out <dir>`              | Go CLI output directory                                                                                       |
| `--cli-binary-name <name>`     | Binary name                                                                                                   |
| `--cli-config-name <name>`     | Optional config file name                                                                                     |
| `--cli-default-base-url <url>` | Default base URL baked into the CLI                                                                           |
| `--cli-env-prefix <prefix>`    | Env prefix for CLI config                                                                                     |
| `--cli-module-path <path>`     | Go module path                                                                                                |
| `--cli-sdk-module-path <path>` | Import an existing Go SDK instead of embedding one                                                            |

CLI boolean flags **turn features on**. They do not turn plugin-configured features off. Plugin config is the source of truth for paths and SDK ports.

Default plugin resolution (when a flag/`true` enables the feature):

| Artifact               | Default path                                 | Default on?                        |
| ---------------------- | -------------------------------------------- | ---------------------------------- |
| Route tree             | `src/_gen/routes.gen.ts`                     | yes (`tree` defaults on)           |
| Types                  | `src/_gen/types.gen.d.ts`                    | no                                 |
| Manifest               | `src/_gen/manifest.gen.json`                 | no                                 |
| OpenAPI                | `src/_gen/openapi.gen.json` (+ YAML sibling) | no, until `codegen.openApi` is set |
| TS SDK                 | `src/_gen/sdk.*.gen.ts`                      | no                                 |
| Python / Go / Rust SDK | only if `codegen.sdk.ports` is set           | no                                 |
| Go CLI                 | only if `codegen.cli` object is set          | no                                 |

Typical plugin config:

```ts
import { honey } from "@lovrozagar/honey/plugin"

export default {
	plugins: [
		honey({
			app: "src/app.ts",
			watch: ["src/**/*.ts"],
			codegen: {
				tree: true,
				types: true,
				manifest: true,
				openApi: { title: "My API", version: "1.0.0" },
				sdk: {
					name: "MySDK",
					ports: {
						typescript: { outDir: "src/_gen" },
						python: { outDir: "sdk/python" },
						go: { outDir: "sdk/go", modulePath: "example.com/myapi" },
						rust: { outDir: "sdk/rust", crateName: "myapi" },
					},
				},
				cli: { out: "cli", binaryName: "myapi" },
			},
		}),
	],
}
```

`generateFromApp(app)` (from `@lovrozagar/honey/plugin`) is the in-process helper: it returns `{ routeTree, manifest?, openApi?, openApiYaml? }` without writing files.

## Builder

### Create the app

```ts
import { honey } from "@lovrozagar/honey"

const app = honey<{ DATABASE_URL: string; API_KEY: string }>()
```

The type argument is `ctx.env`. Pass the same object to `app.fetch(req, env)` or `app.serve({ env })`. On Cloudflare, `env` is the Worker bindings object.

### Routes and methods

```ts
app.get("/items")
app.post("/items")
app.put("/items/:id")
app.patch("/items/:id")
app.delete("/items/:id")
app.head("/items/:id")
app.options("/items")
app.all("/echo") // every method
app.on("GET", "/health")
app.on(["GET", "HEAD"], "/resource") // same handler, extra methods
```

Each verb returns a **route builder**. Chain `.input()`, `.output()`, `.errors()`, `.boundary()`, `.meta()`, then finish with `.handler()` or `.proxy()`. After `.handler()` you are back on the app, so you can keep chaining routes.

There is no `.head` convenience beyond `.head(path)` itself. Use `.on(["GET", "HEAD"], path)` when GET and HEAD share a handler.

### Path matching

```ts
app.get("/orgs/:orgId/members/:memberId").handler((ctx) => {
	ctx.params.orgId
	ctx.params.memberId
	return ctx.res.json("ok", ctx.params)
})

app.get("/files/*path").handler((ctx) => {
	// GET /files/a/b/c  →  ctx.params.path === "a/b/c"
	return ctx.res.json("ok", { path: ctx.params.path })
})
```

- `:name` is one segment.
- `*name` is the remainder of the path.
- Static paths (`/health`) use an O(1) map. Dynamic and wildcard segments walk the radix tree.

Optional extra validation of params (beyond “it is a string”):

```ts
app
	.get("/orgs/:orgId")
	.input({ params: z.object({ orgId: z.string().uuid() }) })
	.handler((ctx) => ctx.res.json("ok", { id: ctx.input.params.orgId }))
```

### Prefixes and slashes

```ts
app.basePath("/api") // every later route is prefixed
app.trailingSlash("strip") // 308 /health/ → /health
app.trailingSlash("enforce") // 308 /health → /health/
app.trailingSlash("ignore") // both match (default)
app.stripPrefix("/app") // inbound /app/api/x is matched as /api/x
```

- `basePath` only affects routes registered **after** the call, on that chain.
- `stripPrefix` is a gateway rewrite. Requests without the prefix still match. It will not strip a partial segment (`/apple` is not stripped by `/app`).
- `.use()` / `.basePath()` / `.context()` / `.meta()` clone the builder and share the route graph with the parent.

### Context

`ctx` is a `HoneyContext`. Fields:

| Field                          | Meaning                                                 |
| ------------------------------ | ------------------------------------------------------- |
| `ctx.req`                      | Web `Request` (on Node serve, a Request-shaped wrapper) |
| `ctx.res`                      | `HoneyRes` — see [Responses](#responses)                |
| `ctx.env`                      | Bindings you passed to `fetch` / `serve`                |
| `ctx.params`                   | Path params (`:id`, `*path`)                            |
| `ctx.search` / `ctx.searchAll` | First value / all values of the query string (lazy)     |
| `ctx.headers` / `ctx.cookies`  | Lazy records (lowercase cookie names as sent)           |
| `ctx.input`                    | Validated input when `.input()` is declared             |
| `ctx.errors`                   | Typed error factory when `.errorFactory()` is set       |
| `ctx.meta`                     | Merged route + chain `.meta()`                          |
| `ctx.path`                     | Request pathname after `stripPrefix`                    |
| `ctx.routePattern`             | Registered pattern, e.g. `/users/:id`                   |
| `ctx.realtime`                 | `{ publish(topic, data) }` when realtime routes exist   |
| `ctx.tap(key, payload)`        | Queue a tap (only if `.taps()` was declared)            |
| `ctx.background(promise)`      | `waitUntil` on Workers, otherwise fire-and-forget       |
| `ctx.executionCtx`             | Workers `ExecutionContext` when `fetch` received one    |
| `ctx.log`                      | Present when `logger({ instance })` middleware ran      |
| `ctx.requestId`                | Present when `requestId()` middleware ran               |
| `ctx.timing`                   | Present when `serverTiming()` middleware ran            |

Reserved keys that middleware / `.context()` **cannot** overwrite: `req`, `res`, `env`, `params`, `headers`, `cookies`, `search`, `background`.

```ts
app
	.context({ version: "1.0.0" })
	.get("/")
	.handler((ctx) => {
		return ctx.res.json("ok", { version: ctx.version })
	})
```

`ctx.res.json("ok", data)` is branded at the type level (`TypedResponse<"application/json", "ok">`) and is a real `Response` on Bun / Workers. On Node `serve()`, known-size bodies skip `new Response()` and write with `writeHead` / `end`.

### Responses

Every `ctx.res.*` method takes a **status key** (except `noContent`, `redirect`, `sse`, `stream`, `generate`, `raw`). Optional third argument (or last for the exceptions):

```ts
type ResponseOptions = {
	status?: number // override numeric status (redirect only by default)
	headers?: Record<string, string>
	cookies?: Record<string, CookieOptions>
}

type CookieOptions = {
	value: string
	domain?: string
	expires?: Date
	httpOnly?: boolean
	maxAge?: number
	path?: string
	sameSite?: "lax" | "none" | "strict"
	secure?: boolean
}
```

```ts
ctx.res.json("ok", { id: "1" })
ctx.res.json(
	"created",
	{ id: "1" },
	{
		headers: { "x-request-id": "r1" },
		cookies: { sid: { value: "abc", httpOnly: true, sameSite: "lax", path: "/" } },
	},
)
ctx.res.text("ok", "hello")
ctx.res.html("ok", "<h1>Hi</h1>")
ctx.res.csv("ok", "id,name\n1,Ada")
ctx.res.xml("ok", "<ok/>")
ctx.res.binary("ok", new Uint8Array([0x48, 0x49]))
ctx.res.noContent()
ctx.res.redirect("/elsewhere") // 302
ctx.res.redirect("/gone", { status: 301 })
ctx.res.raw(new Response("passthrough"))
```

`__Host-` cookies require `secure: true`, `path: "/"`, and no `domain`.

SSE / stream / generate: see [SSE and streaming](#sse-and-streaming).

### Status keys

`ctx.res.json("created", data)` sets HTTP 201. Use the snake_case key, not the number, except `redirect({ status })`.

| Key                               | Code | Key                               | Code |
| --------------------------------- | ---- | --------------------------------- | ---- |
| `ok`                              | 200  | `bad_request`                     | 400  |
| `created`                         | 201  | `unauthorized`                    | 401  |
| `accepted`                        | 202  | `payment_required`                | 402  |
| `non_authoritative_information`   | 203  | `forbidden`                       | 403  |
| `no_content`                      | 204  | `not_found`                       | 404  |
| `reset_content`                   | 205  | `method_not_allowed`              | 405  |
| `partial_content`                 | 206  | `not_acceptable`                  | 406  |
| `multi_status`                    | 207  | `proxy_authentication_required`   | 407  |
| `already_reported`                | 208  | `request_timeout`                 | 408  |
| `im_used`                         | 226  | `conflict`                        | 409  |
| `multiple_choices`                | 300  | `gone`                            | 410  |
| `moved_permanently`               | 301  | `length_required`                 | 411  |
| `found`                           | 302  | `precondition_failed`             | 412  |
| `see_other`                       | 303  | `content_too_large`               | 413  |
| `not_modified`                    | 304  | `uri_too_long`                    | 414  |
| `temporary_redirect`              | 307  | `unsupported_media_type`          | 415  |
| `permanent_redirect`              | 308  | `range_not_satisfiable`           | 416  |
| `internal_server_error`           | 500  | `expectation_failed`              | 417  |
| `not_implemented`                 | 501  | `im_a_teapot`                     | 418  |
| `bad_gateway`                     | 502  | `misdirected_request`             | 421  |
| `service_unavailable`             | 503  | `unprocessable_entity`            | 422  |
| `gateway_timeout`                 | 504  | `locked`                          | 423  |
| `http_version_not_supported`      | 505  | `failed_dependency`               | 424  |
| `variant_also_negotiates`         | 506  | `too_early`                       | 425  |
| `insufficient_storage`            | 507  | `upgrade_required`                | 426  |
| `loop_detected`                   | 508  | `precondition_required`           | 428  |
| `not_extended`                    | 510  | `too_many_requests`               | 429  |
| `network_authentication_required` | 511  | `request_header_fields_too_large` | 431  |
|                                   |      | `unavailable_for_legal_reasons`   | 451  |

`.output()` only accepts **2xx success keys** plus a `redirect` map. Error statuses belong on `.errors()`, not `.output()`.

### Input

`.input()` takes Standard Schema objects. `json` and `form` are mutually exclusive (one Content-Type per request).

```ts
app
	.put("/in/all/:resourceId")
	.input({
		json: z.object({ title: z.string() }),
		search: z.object({ draft: z.coerce.boolean().optional() }),
		headers: z.object({ "x-request-id": z.string() }),
		cookies: z.object({ sid: z.string() }),
		params: z.object({ resourceId: z.string().min(1) }),
	})
	.handler((ctx) => {
		ctx.input.json.title
		ctx.input.search.draft
		ctx.input.headers["x-request-id"]
		ctx.input.cookies.sid
		ctx.input.params.resourceId
		return ctx.res.json("ok", { ok: true })
	})
```

Form + file (Zod `z.file()` or equivalent):

```ts
app
	.post("/upload")
	.input({ form: z.object({ title: z.string(), upload: z.file() }) })
	.handler((ctx) => ctx.res.json("ok", { name: ctx.input.form.upload.name, title: ctx.input.form.title }))
```

Leave the body for the handler (no Honey parse):

```ts
import { readableStream } from "@lovrozagar/honey/input"

app
	.post("/pipe")
	.input({ json: readableStream(z.unknown()) })
	.handler(async (ctx) => {
		const body = ctx.req.body
		return ctx.res.json("ok", { piped: body !== null })
	})
```

Content-Type selection:

- `application/json` → `json`
- `application/x-www-form-urlencoded` or `multipart/form-data` → `form` (`req.formData()`)
- Invalid input is **400** with `error_key: "validation_failed"` and `fields: { name: [{ error_key, message, path }] }`.

Valibot / ArkType work the same way — pass any Standard Schema:

```ts
import * as v from "valibot"
app
	.post("/v")
	.input({ json: v.object({ n: v.number() }) })
	.handler((ctx) => ctx.res.json("ok", ctx.input.json))
```

### Output

`.output()` maps content type → status key → schema. Only 2xx keys plus `redirect`.

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

Declared content types unlock the matching `ctx.res` method at the type level:

| Content type               | Method                                |
| -------------------------- | ------------------------------------- |
| `application/json`         | `json`                                |
| `text/plain`               | `text`                                |
| `text/html`                | `html`                                |
| `text/csv`                 | `csv`                                 |
| `application/xml`          | `xml`                                 |
| `application/octet-stream` | `binary`                              |
| `text/event-stream`        | `sse`                                 |
| `redirect`                 | `redirect` (map of 3xx keys → `true`) |

Always available: `noContent`, `raw`, `redirect`, `stream`. Also recognized in the map (no dedicated helper): `application/cbor`, `application/msgpack`, `application/pdf`.

```ts
app
	.get("/go")
	.output({ redirect: { found: true, moved_permanently: true } })
	.handler((ctx) => ctx.res.redirect("/next"))
```

`.outputValidation("off" | "dev" | "always")` controls runtime checks. `"dev"` (typical) validates when `NODE_ENV !== "production"`. Mismatch is **500** (`output_validation_failed` or `output_content_type_mismatch`).

```ts
app.outputValidation("always")
```

### Errors

```ts
import { defineErrors, HoneyError, honey } from "@lovrozagar/honey"

const errors = defineErrors({
	unauthorized: "unauthorized",
	org_slug_taken: "conflict",
	item_not_found: {
		status: "not_found",
		schema: z.object({ reason: z.string() }),
	},
	api_error: "internal_server_error",
})

const app = honey()
	.errorFactory(errors)
	.defaultErrors("unauthorized") // every route may throw these
	.defaultBoundary("api_error") // unexpected throws become this key
	.onError((error, ctx) => {
		if (error instanceof HoneyError && error.errorKey === "org_slug_taken") {
			return ctx.jsonFromError(error)
		}
		return undefined // fall through to default handling
	})
	.onNotFound((ctx) => ctx.jsonFromError(errors.item_not_found({ reason: "no route" })))
	.onMethodNotAllowed((ctx) => {
		// ctx.allowed is the Allow list
		return new Response(null, { status: 405, headers: { allow: ctx.allowed.join(", ") } })
	})
```

Throw from a handler:

```ts
throw ctx.errors.org_slug_taken({ vars: { slug: "acme" } })
throw ctx.errors.item_not_found({ reason: "deleted" })
throw ctx.errors.unauthorized({
	fields: { token: [{ error_key: "required", message: "missing", path: "token" }] },
	headers: { "www-authenticate": "Bearer" },
})
```

Standard error JSON:

```json
{
	"error_key": "org_slug_taken",
	"status": 409,
	"status_key": "conflict",
	"message": "org_slug_taken",
	"success": false,
	"fields": {},
	"vars": { "slug": "acme" }
}
```

Custom-schema errors serialize **the schema payload** as the body (not the envelope), unless you set `customErrorFormatter`.

Per-route:

```ts
app
	.post("/orgs")
	.errors("org_slug_taken", "unauthorized")
	.boundary("api_error") // this route's unexpected-throw key
	.handler((ctx) => {
		throw ctx.errors.org_slug_taken({ vars: { slug: "x" } })
	})
```

`.errors(factory, ...keys)` also accepts the factory object as the first argument (kitchen style). Undeclared `HoneyError` keys fail the boundary check and become the boundary error.

Formatters:

```ts
app.defaultErrorFormatter((error, defaultShape) => ({
	...defaultShape,
	request_id: "r1",
}))

app.defaultErrorFormatter(z.object({ error_key: z.string(), status: z.number() }), (error) => ({
	error_key: error.errorKey,
	status: error.status,
}))

app.customErrorFormatter((error, data) => ({ ...data, error_key: error.errorKey }))
```

i18n (loads `@lovrozagar/honey/i18n` when called):

```ts
import "@lovrozagar/honey/i18n"

app.errorI18n({
	errors: {
		en: { org_slug_taken: "Slug {slug} is taken", unauthorized: "Sign in" },
		de: { org_slug_taken: "Name {slug} ist vergeben", unauthorized: "Anmeldung nötig" },
	},
	fieldNames: {
		en: { email: "Email" },
	},
	resolveLocale: (ctx) => {
		const accept = ctx.req.headers.get("accept-language")
		return accept?.startsWith("de") ? "de" : "en"
	},
})
```

Messages are ICU: `{slug}`, `{n, number}`, `{n, plural, one {# item} other {# items}}`, `{k, select, a {A} other {X}}`. `cause` is reserved and is not a template var.

`HoneyError` fields: `errorKey`, `status` (number), `statusKey`, `fields`, `vars`, `data`, `headers`. `HoneyError.serialize(err)` is a JSON-safe dump for logs.

Framework-owned keys you do not declare: `validation_failed` (400), `output_validation_failed` (500), plus routing / content-negotiation keys.

### Middleware

```ts
import { createMiddleware } from "@lovrozagar/honey"

const withAuth = createMiddleware(async (ctx, next) => {
	const token = ctx.req.headers.get("authorization")
	if (!token) throw ctx.errors.unauthorized()
	return next({ user: { id: "u-1" } })
})

app.use(withAuth) // global on this chain
app.use("/admin", withAuth) // prefix-scoped; additions only exist under /admin
```

`createMiddleware` infers additions from `next({ ... })`. Later handlers see `ctx.user`. Return `next()` with no argument to add nothing.

`.use()` clones the builder. Keep the returned value (or keep chaining) if later routes should see the middleware.

### Shipped middleware

Import each from its path. Do **not** `import { cors } from "@lovrozagar/honey"`.

#### `cors` — `@lovrozagar/honey/cors`

```ts
import { cors } from "@lovrozagar/honey/cors"

app.use(cors())
app.use(
	cors({
		origin: "https://app.example.com", // or "*" | string[] | (origin) => boolean
		credentials: true, // wildcard origin is echoed (spec-safe)
		methods: ["GET", "POST"],
		headers: ["authorization", "content-type"],
		exposeHeaders: ["x-request-id"],
		maxAge: 86400,
	}),
)
```

No `Origin` header → middleware is a no-op. Preflight is `OPTIONS` + `access-control-request-method`. `app.serve({ cors: true })` is `cors()` with defaults. `app.serve({ cors: { origin } })` passes the object through.

#### `csrf` — `@lovrozagar/honey/csrf`

```ts
import { csrf } from "@lovrozagar/honey/csrf"

app.use(csrf({ origin: "https://app.example.com" }))
```

Safe methods (`GET`/`HEAD`/`OPTIONS`) pass. Non-form JSON also passes. Form posts (`urlencoded` / `multipart` / `text/plain`) need `Sec-Fetch-Site: same-origin` or a matching `Origin`. Failure is **403** `forbidden`.

#### `body-limit` — `@lovrozagar/honey/body-limit`

```ts
import { bodyLimit } from "@lovrozagar/honey/body-limit"

app.use(
	bodyLimit({
		maxSize: 1_048_576,
		limits: { "application/json": 64_000, "multipart/": 10_485_760 },
		trustContentLength: false, // default; true skips counting when Content-Length is in range
	}),
)
```

Skipped for GET/HEAD/OPTIONS/DELETE. Oversize is **413** `content_too_large`. `limits` keys are matched with `startsWith` against `Content-Type`.

#### `logger` — `@lovrozagar/honey/logger`

```ts
import { createLogger, logger } from "@lovrozagar/honey/logger"

const log = createLogger({
	level: "info", // trace | debug | info | warn | error | fatal
	base: { service: "api" },
	write: (line) => console.log(line),
})

app.use(logger())
app.use(
	logger({
		instance: log, // pino-shaped; sets ctx.log
		skip: (data) => data.path === "/health",
		log: (data) => {
			// used when instance is omitted
			console.log(`${data.method} ${data.path} ${data.status} ${data.duration}ms`)
		},
	}),
)
```

`createLogger` writes one JSON line per call (`level`, `msg`, `time`, plus `base`). `ctx.log.info("hello")` / `ctx.log.info({ k: 1 }, "hello")`.

#### `curl-logger` — `@lovrozagar/honey/curl-logger`

```ts
import { curlLogger } from "@lovrozagar/honey/curl-logger"

app.use(
	curlLogger({
		body: { maxBytes: 2048, allowContentTypes: ["application/json"] },
		redactHeader: (name, value) => (name === "authorization" ? "Bearer ***" : value),
		redactQueryParam: (name, value) => (name === "token" ? "***" : value),
		skip: (data) => data.path === "/health",
	}),
)
```

#### `request-id` — `@lovrozagar/honey/request-id`

```ts
import { requestId } from "@lovrozagar/honey/request-id"

app.use(requestId())
app.use(requestId({ header: "x-request-id", generator: () => crypto.randomUUID() }))
```

Adds `ctx.requestId` and echoes the header on the response. Reuses the inbound header when present.

#### `etag` — `@lovrozagar/honey/etag`

```ts
import { etag } from "@lovrozagar/honey/etag"

app.use(etag()) // weak ETag (default)
app.use(etag({ weak: false }))
```

GET/HEAD only. Skips 4xx and streaming bodies. Responds **304** when `If-None-Match` matches.

#### `timeout` — `@lovrozagar/honey/timeout`

```ts
import { timeout } from "@lovrozagar/honey/timeout"

app.use(timeout({ duration: 5_000 }))
```

Slow handlers reject with **504** `request_timeout`.

#### `secure-headers` — `@lovrozagar/honey/secure-headers`

```ts
import { secureHeaders } from "@lovrozagar/honey/secure-headers"

app.use(secureHeaders())
app.use(
	secureHeaders({
		contentSecurityPolicy: "default-src 'self'",
		strictTransportSecurity: "max-age=63072000; includeSubDomains",
		permissionsPolicy: "camera=()",
		referrerPolicy: "strict-origin-when-cross-origin", // or false to omit
		xContentTypeOptions: "nosniff", // or false
		xFrameOptions: "SAMEORIGIN",
		xXssProtection: "0",
		crossOriginOpenerPolicy: "same-origin",
		crossOriginEmbedderPolicy: "require-corp",
		crossOriginResourcePolicy: "same-site",
	}),
)
```

Defaults when omitted: `x-content-type-options: nosniff`, `x-frame-options: SAMEORIGIN`, `referrer-policy: strict-origin-when-cross-origin`, `x-xss-protection: 0`.

#### `server-timing` — `@lovrozagar/honey/server-timing`

```ts
import { serverTiming } from "@lovrozagar/honey/server-timing"

app.use(serverTiming())
app.get("/work").handler((ctx) => {
	ctx.timing.start("db", "query")
	ctx.timing.end("db")
	return ctx.res.json("ok", {})
})
```

#### `ip-restrict` — `@lovrozagar/honey/ip-restrict`

```ts
import { ipRestrict } from "@lovrozagar/honey/ip-restrict"

app.use(
	ipRestrict({
		allowList: ["127.0.0.1", "10.0.0.0/8"],
		denyList: ["192.168.1.50"],
		trustProxy: false, // true: X-Forwarded-For / X-Real-IP after CF
		getIp: (req) => req.headers.get("cf-connecting-ip"),
	}),
)
```

Default IP: `cf-connecting-ip` only. Denied / not-allowed is **403**.

#### `powered-by` — `@lovrozagar/honey/powered-by`

```ts
import { poweredBy } from "@lovrozagar/honey/powered-by"

app.use(poweredBy()) // x-powered-by: Honey
app.use(poweredBy({ name: "api" }))
```

#### `pretty-json` — `@lovrozagar/honey/pretty-json`

```ts
import { prettyJson } from "@lovrozagar/honey/pretty-json"

app.use(prettyJson()) // ?pretty=
app.use(prettyJson({ query: "pretty", space: 2 }))
```

Only rewrites `application/json` when the query string contains the key.

### Composition

```ts
const users = honey()
	.basePath("/users")
	.get("/:id")
	.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

const app = honey().route(users) // merges routes, realtime, taps, static map
```

`.route(sub)` copies the sub-app's tree into this one. Duplicate paths throw.

### Taps

Taps run **after** a successful handler. They do not run on thrown errors.

```ts
const app = honey()
	.taps<{ audit: { action: string } }>()
	.tap("audit", (ctx, payload) => {
		ctx.background(
			fetch("https://logs.example.com", {
				method: "POST",
				body: JSON.stringify({ path: ctx.req.url, ...payload }),
			}),
		)
	})
	.post("/items")
	.handler((ctx) => {
		ctx.tap("audit", { action: "create" })
		return ctx.res.json("created", { id: "1" })
	})
```

### Proxy routes

Finish a route with `.proxy()` instead of `.handler()`:

```ts
app.all("/upstream/*path").proxy({
	destination: (ctx, url, init) => fetch(`https://api.internal${url}`, init),
	rewriteUrl: (url) => url.replace(/^\/upstream/, ""),
	requestHeaders: { "x-forwarded-by": "honey" },
	// or requestHeaders: (ctx, headers) => { headers.set("x-user", ctx.user.id) }
	timeout: 10_000, // or (ctx) => 5_000; default 30_000; disabled for WS upgrades
	onResponse: (ctx, response) => {
		response.headers.set("x-proxied", "1")
	},
})
```

`destination` receives path + query (after `rewriteUrl`) and a prepared `RequestInit` (method, headers, body, signal, redirect). Hop-by-hop headers are stripped. `onResponse` is not called for 101 upgrades.

### Static files

```ts
import { staticFiles } from "@lovrozagar/honey/static"

app.use(
	staticFiles({
		prefix: "/assets",
		resolve: async (_ctx, filePath) => {
			const file = Bun.file(`./public${filePath}`)
			if (!(await file.exists())) return null
			return new Response(file)
		},
		headers: { "cache-control": "public, max-age=3600" },
		// or headers: (filePath) => ({ "content-type": mime(filePath) })
		rewritePath: (filePath) => (filePath === "/" ? "/index.html" : filePath),
	}),
)
```

GET/HEAD only. `..` segments are rejected. `resolve` returning `null` falls through to the next route.

### Logging, telemetry, production tree

App-level logger (Honey internals, not request logs):

```ts
app.logger({ warn: (msg, ...args) => console.warn(msg, ...args) })
```

OpenTelemetry-shaped adapter:

```ts
import { otelAdapter } from "@lovrozagar/honey/telemetry/otel"

app.telemetry(otelAdapter({ tracer }))
// or a hand-rolled adapter:
app.telemetry({
	onRequest: ({ req }) => {},
	onRoute: ({ method, path, params }) => {},
	onHandler: ({ status, duration }) => {},
	onResponse: ({ status, duration }) => {},
	onError: ({ error, duration }) => {},
	onMiddleware: ({ name, duration, error }) => {},
	onNotFound: ({ method, path }) => {},
	onMethodNotAllowed: ({ allowed }) => {},
})
```

Production tree (unknown paths 404 without a catch-all walk):

```ts
import { routeTree } from "./_gen/routes.gen.ts"

app.routeTree(routeTree)
const snapshot = app.toRouteTree()
```

`mergeTree` from `honey` / `honey/tree` merges several trees (optional extra meta per tree).

`app.fetch(request, env, executionCtx?)` is always valid. Sync handlers return a `Response` directly; async handlers and middleware return a `Promise<Response>`. Callers should `await app.fetch(...)`.

## Serve

### Bun, Node, Deno

```ts
const handle = await app.serve({
	port: 3000,
	hostname: "0.0.0.0",
	cors: true, // or a CORS options object
	env: { DATABASE_URL },
	runtime: "bun", // optional; detected if omitted
})

handle.url // http://127.0.0.1:3000
handle.port
handle.hostname
handle.runtime // "bun" | "node" | "deno"
await handle.close()
```

Defaults: `port` 3000, `hostname` `0.0.0.0` (Deno defaults to `127.0.0.1`). Bound `0.0.0.0` / `::` is printed as `127.0.0.1` in `url`.

| Runtime | How it listens                                |
| ------- | --------------------------------------------- |
| Bun     | `Bun.serve({ fetch })` + `honey/ws/bun`       |
| Node    | `node:http` + `honey/serve` + `honey/ws/node` |
| Deno    | `Deno.serve` + `honey/ws/deno`                |

On Node, import `honey/serve` (or call `app.serve()`, which loads it) so the listen implementation is registered. The Node adapter wraps `IncomingMessage` instead of `new Request()` on the inbound hot path, and writes known JSON/text bodies with `res.end` instead of draining a Fetch `Response`.

Low-level Node listen (same adapter, no runtime detect):

```ts
import { serve } from "@lovrozagar/honey/node"
const server = serve(app, { env: {}, port: 3000, hostname: "0.0.0.0" })
await server.shutdown()
```

`runtime: "cloudflare"` throws. Workers cannot listen.

Detect without serving:

```ts
import { detectRuntime } from "@lovrozagar/honey"
detectRuntime() // "bun" | "node" | "deno" | "cloudflare"
```

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

Adapters if you wire them yourself: `bunWebSocket` (`honey/ws/bun`), `nodeWebSocket` (`honey/ws/node`), `denoWebSocket` (`honey/ws/deno`), `cfWebSocket` (`honey/ws/cloudflare`). `app.serve()` attaches the matching one.

### Feature auto-load

`honey()` stays fetch-only until you opt in:

| Call or import                                                             | Loads           |
| -------------------------------------------------------------------------- | --------------- |
| `app.serve()` or `import "@lovrozagar/honey/serve"`                        | Listen adapters |
| `app.openapi()` / `app.manifest()` or `import "@lovrozagar/honey/openapi"` | Spec + docs     |
| `app.errorI18n()` or `import "@lovrozagar/honey/i18n"`                     | Error i18n      |

Production bundles that only call `app.fetch` do not pull listen, OpenAPI, or i18n code. The load uses an opaque `import(["@lovrozagar/honey", name].join("/"))` so bundlers do not follow unused feature entries.

`createBuildPlugin` (`honey/build`) is a Vite plugin that injects those imports per target (`bun` | `node` | `deno` | `cloudflare`).

```ts
import { createBuildPlugin } from "@lovrozagar/honey/build"

createBuildPlugin(
	{ target: "bun", port: 3000, minify: true, outDir: "dist", external: [] },
	{ entry: "src/app.ts", export: "app" }, // or export: "default"
)
```

## OpenAPI, docs, and manifest

```ts
app.openapi({
	title: "My API",
	version: "1.0.0",
	description: "Optional",
	docs: "scalar", // or "swagger"
	docsPath: "/docs", // default /docs, then /reference if /docs is taken
	path: "/openapi", // stem → /openapi.json, .yaml, .yml
	filterRoutes: (route) => route.path !== "/debug",
	securitySchemes: {
		bearerAuth: { type: "http", scheme: "bearer" },
	},
})

app.manifest()
app.manifest({ path: "/manifest.json" })
```

Served (cached, invalidated when the route graph changes):

| Path                             | Body                                               |
| -------------------------------- | -------------------------------------------------- |
| `/openapi.json`                  | OpenAPI 3.1                                        |
| `/openapi.yaml` / `/openapi.yml` | Same document as YAML                              |
| `/docs`                          | Scalar or Swagger UI pointing at the JSON spec     |
| `/manifest.json`                 | Route methods, paths, middleware names, error keys |

Those routes are marked internal. They do not appear inside the spec or the manifest. If `/docs` is already a user route, pass `docsPath` or Honey throws.

`.meta({ operationId, tags, summary, description })` on a route feeds the document. App-level `.meta<Shape>()` / `.meta({ auth: "required" })` sets defaults and constrains route meta.

Generate-time sanitize (plugin `codegen.openApi.sanitize`):

```ts
{
  stripSecuritySchemes: ["legacy"],
  stripSecurityRequirements: ["legacy"],
  stripXExtensions: true,          // or ["x-internal"]
}
```

### Meta spec

`.metaSpec()` declares what flows from route meta and route schemas into the document. Without it, the built-in policy maps the eight fields above and drops everything else silently.

```ts
const app = honey<Env>()
	.meta<HoneyMeta<AppRouteMeta>>()
	.metaSpec({
		strict: "error", // an app meta key with no entry fails the build
		meta: {
			permissions: "x-permissions", // verbatim
			rateLimit: { key: "x-rate-limit", map: (v) => ({ category: v, rps: RPS[v] }) },
			worker: false, // deliberately internal — never emitted
			captcha: false,
		},
		schema: {
			// read off `.meta({ entity })` stamped on the route's schemas, fan out to several tags
			entity: {
				from: ["output"],
				search: "deep", // looks inside `{ articles: [Article], nextCursor }` envelopes
				expand: (e) => ({
					"x-entity": e.table,
					"x-generated": e.generated,
					"x-soft-delete": e.softDelete ? { field: e.softDelete } : undefined,
				}),
			},
		},
		profiles: {
			// allowlist — a tag added later stays out of the public document until opted in
			public: { include: ["x-entity", "x-query"] },
		},
	})
```

Every key of the app's meta type needs an entry — mapped, or `false` — enforced by the type of the `meta` section and again at codegen. Route meta beats schema-derived facts; `meta.extensions` (a record of `x-*` keys) is the escape hatch and outranks both. `profile` on `app.openapi()` or on a `codegen.openApi` entry emits several documents with different extension sets from one policy. Codegen-time only; nothing runs per request.

Full reference, precedence rules, error taxonomy and migration path: [meta-spec.md](./docs/meta-spec.md).

## WebSockets

```ts
app.ws("/echo-ws").handler({
	onOpen(_ctx, ws) {
		ws.send("connected")
		ws.send({ hello: true }) // objects are JSON.stringified
	},
	onMessage(_ctx, ws, data) {
		ws.send(data) // string | ArrayBuffer
	},
	onReconnect(_ctx, ws, token) {
		ws.send(JSON.stringify({ event: "reconnected", token }))
	},
	onClose(_ctx, _ws, code, reason) {},
	onError(_ctx, _ws, error) {},
})
```

`ws` is `{ send, close, readyState, raw }`. `readyState` is `0|1|2|3`. Sends before open are buffered (max 32). Middleware on the chain runs for the HTTP upgrade. Auth middleware works: throw to reject.

A GET **without** `Upgrade: websocket` to a WS/realtime path returns **426** with `upgrade: websocket`.

Reconnect: pass `?reconnect_token=` on the next handshake; Honey calls `onReconnect` instead of `onOpen`.

`app.serve()` attaches the runtime adapter. On Cloudflare, call `app.wsAdapter(cfWebSocket())` yourself.

## Realtime

Honey's room protocol (not a raw socket). Transports: `ws`, `sse`, `longpoll`.

```ts
app.realtime("/realtime/chat/:roomId", {
	reconnectBuffer: 32,
	use: [withAuth], // extra middleware for this socket only
	handler: (ctx, conn) => {
		conn.join("room:default")
		conn.send({ event: "joined", id: conn.id, userId: conn.userId })
		conn.on("message", (payload) => {
			conn.publish("room:default", payload)
		})
		conn.on("close", (_reason) => {
			conn.leave("room:default")
		})
	},
})

app.post("/realtime/broadcast/:topic").handler(async (ctx) => {
	const body = await ctx.req.json()
	ctx.realtime.publish(ctx.params.topic, body)
	return ctx.res.json("ok", { published: true })
})
```

`conn`:

| Field                          | Meaning                       |
| ------------------------------ | ----------------------------- |
| `id`                           | Connection id                 |
| `userId`                       | `string \| null`              |
| `transport`                    | `"ws" \| "sse" \| "longpoll"` |
| `state`                        | Mutable bag                   |
| `join(topic)` / `leave(topic)` | Topic membership              |
| `send(payload)`                | To this connection            |
| `publish(topic, payload)`      | To everyone on the topic      |
| `close(reason?)`               | Disconnect                    |
| `on("message" \| "close", fn)` | Inbound / teardown            |

Duplicate `realtime()` paths throw. Cloudflare's isolate-local bus does **not** cross isolates — REST publish to another connection is skipped on the CF e2e env.

## SSE and streaming

```ts
app.get("/events").handler((ctx) =>
	ctx.res.sse(
		async (stream) => {
			if (stream.lastEventId) {
				await stream.send({ event: "resume", data: `from ${stream.lastEventId}` })
			}
			await stream.send({ event: "tick", data: "hello", id: "1", retry: 3000 })
			await stream.send({ event: "data", data: { n: 42 }, id: "2" })
			stream.close()
		},
		{ defaultRetry: 3000, keepalive: 15_000 },
	),
)
```

`Last-Event-Id` is read automatically. Event names and ids must not contain newlines. `keepalive` writes `: heartbeat` comments.

```ts
app.get("/stream").handler((ctx) =>
	ctx.res.stream(async (writable) => {
		const w = writable.getWriter()
		await w.write(new TextEncoder().encode("chunk"))
		await w.close()
	}),
)

app.get("/gen").handler((ctx) =>
	ctx.res.generate(
		(async function* () {
			yield "one"
			yield "two"
		})(),
		{ contentType: "text/plain", status: 200 },
	),
)
```

## Generated clients

One OpenAPI document, four printers. Parity: typed operations, typed errors, `onAuthExpired` + one 401 retry, cancellation, per-call timeout/headers, request/response hooks, invalidation, SSE, realtime, WebSocket, streaming bodies, `onLog`. Python and Rust also emit a sync runtime.

### Plugin codegen config

See [honey generate](#honey-generate). `codegen.sdk: true` is TypeScript-only into `src/_gen`. Object form selects ports. `codegen.sdk.specs: ["a.json"]` builds from existing specs (no app required for SDK). `codegen.cli=true` is invalid — pass `{ out, binaryName }`.

### TypeScript `createClient`

Hand-typed client against `InferRoutes<typeof app>` (no generate):

```ts
import { createClient, isClientError } from "@lovrozagar/honey/client"

const client = createClient<typeof app>({
	baseURL: "http://127.0.0.1:3000",
	headers: { authorization: "Bearer t" },
	timeout: 10_000,
	throwOnError: false,
	credentials: "include",
	onAuthExpired: async () => "new-token",
	onRequest: [
		async (ctx) => {
			ctx.headers.set("x-trace", "1")
		},
	],
	onResponse: [async (ctx) => ctx.response],
})

const res = await client.get("/api/health")
const created = await client.post("/api/users", { json: { email: "a@b.com", name: "Ada" } })

client.$url("/api/users/:id", { params: { id: "1" }, search: { x: "1" } })
client.$path("/api/users/:id", { params: { id: "1" } })
const ws = client.ws("/echo-ws", { reconnectToken: "t" })
```

Per-call options: `json`, `form`, `search`, `params`, `headers`, `cookies`, `timeout`, `signal`, `lastEventId`.

`throwOnError: true` throws `ClientError` subclasses (`BadRequestError`, `UnauthorizedError`, …). `isClientError(e)` is the guard.

### Generated SDK usage

After `honey generate` with `codegen.sdk.ports.typescript`:

```ts
import { MySDK, isClientError, UnauthorizedError } from "./_gen/sdk.index.gen.ts"

const sdk = new MySDK({
	baseURL: "http://127.0.0.1:3000",
	headers: { Authorization: "Bearer t" },
	onAuthExpired: () => Promise.resolve("new-token"),
	onLog: (entry) => console.debug(entry.event, entry.operation, entry.duration_ms),
	onRequest: [
		(ctx) => {
			ctx.headers["X-Trace-Id"] = crypto.randomUUID()
		},
	],
	throwOnError: true,
	timeout: 10_000,
	invalidation: { staleTime: 5 },
})

const user = await sdk.createUser({ json: { email: "a@b.com", name: "Ada" } })
```

Python / Go / Rust: point `ports.*.outDir` at a folder and import that package (`replace` in `go.mod`, `path =` in Cargo). Sync clients exist for Python and Rust only.

Capability details and four-language snippets: [SDK index](./docs/sdk.md) and [examples](https://github.com/lovrozagar/honey/tree/main/packages/core/examples).

### Go CLI

```ts
codegen: {
  cli: {
    out: "cli",
    binaryName: "myapi",
    modulePath: "example.com/myapi/cli",
    sdkModulePath: "example.com/myapi",  // omit to embed the SDK
    defaultBaseURL: "http://127.0.0.1:3000",
    envPrefix: "MYAPI",
    configName: "myapi",
  },
}
```

Equivalent CLI: `honey generate --cli --cli-out cli --cli-binary-name myapi`.

### Programmatic codegen

```ts
import {
	generateOpenApi,
	generateManifest,
	generateSDK,
	generateRouteTreeFromApp,
	mergeSpecs,
	sanitizeOpenApiSpec,
} from "@lovrozagar/honey/codegen"
import { generateGoCLI } from "@lovrozagar/honey/codegen-go-cli"

const spec = await generateOpenApi(app, { info: { title: "API", version: "1" } })
const { files } = generateSDK(spec, { name: "MySDK", stem: "sdk" })
```

Language printers used by the plugin (`generatePythonSDK`, `generateGoSDK`, `generateRustSDK`) are not separate package exports — call `honey generate`.

## Type inference

Exported from `@lovrozagar/honey`. They describe the **app you built**:

| Type                                                 | Meaning                              |
| ---------------------------------------------------- | ------------------------------------ |
| `InferRoutes<typeof app>`                            | Path → methods → input/output/errors |
| `InferRoutePaths<typeof app>`                        | Union of paths                       |
| `InferRouteMethods<typeof app, Path>`                | Methods on one path                  |
| `InferRouteInput<typeof app, Path, Method>`          | Validated input                      |
| `InferRouteOutput<typeof app, Path, Method>`         | Output map                           |
| `InferRouteErrors<typeof app, Path, Method>`         | Declared error keys                  |
| `InferRouteMeta<typeof app, Path, Method>`           | Route meta                           |
| `InferRouteCtx<typeof app, Path, Method>`            | Handler ctx for one route            |
| `InferCtx<typeof app>`                               | Handler context (no `res` brand)     |
| `InferEnv<typeof app>`                               | `ctx.env`                            |
| `InferMeta<typeof app>`                              | App-level meta                       |
| `InferErrorFactory<typeof app>`                      | Error factory                        |
| `InferBasePath<typeof app>`                          | Base path string                     |
| `StatusKey` / `SuccessStatusKey`                     | Status-key unions                    |
| `HoneyCtx<TEnv>`                                     | Untyped context shape                |
| `HoneyServeOptions` / `ServeHandle` / `ServeRuntime` | Serve types                          |
| `WSHandler` / `WSContext` / `WSAdapter`              | Socket types                         |
| `ConnContext` / `RealtimeRouteOpts`                  | Realtime types                       |

```ts
import type { InferCtx, InferRouteInput, InferRoutes } from "@lovrozagar/honey"

type AppRoutes = InferRoutes<typeof app>
type CreateInput = InferRouteInput<typeof app, "/api/users", "post">
type Ctx = InferCtx<typeof app>
```

## Testing

```ts
import { testClient } from "@lovrozagar/honey/testing"

const client = testClient(app, { env: { DATABASE_URL: "…" }, cookies: true })

const res = await client.get("/api/health")
await client.post("/api/users", {
	json: { email: "a@b.com", name: "Ada" },
	headers: { authorization: "Bearer t" },
	search: { dry: "1" },
})
await client.post("/login", { form: { user: "a", pass: "b" } })
```

Methods: `get` `post` `put` `patch` `delete` `head` `options` `request`. `cookies: true` stores `Set-Cookie` and sends them back.

## Utilities

```ts
import { accepts } from "@lovrozagar/honey/accepts"
accepts(req, ["application/json", "text/html"]) // best match or first if no Accept

import { serializeCookie } from "@lovrozagar/honey/cookie"
serializeCookie("sid", { value: "abc", httpOnly: true, path: "/" })

import { sign, verify } from "@lovrozagar/honey/cookie-sign"
const signed = await sign("abc", SECRET)
const raw = await verify(signed, [SECRET, OLD_SECRET]) // null if none match

import { timingSafeEqual } from "@lovrozagar/honey/crypto"
await timingSafeEqual(a, b)

import { requestToCurl } from "@lovrozagar/honey/request-to-curl"
await requestToCurl(req, { excludeHeader: (n) => n === "authorization" })
```

`honey/openapi/spec`, `honey/openapi/scalar`, `honey/openapi/swagger` are the internals `app.openapi()` loads. `honey/cli` is the generate/init binary. `honey/codegen/extract` is the ts-morph extractor used by `--types`.

## Package exports

Import features from their path.

| Export                                                                                                                                                                                                                                                 | Purpose                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `@lovrozagar/honey`                                                                                                                                                                                                                                    | `honey`, `defineErrors`, `HoneyError`, `createMiddleware`, `HoneyRes`, Infer* types, `mergeTree`, `detectRuntime` |
| `honey/serve`                                                                                                                                                                                                                                          | Register Node/Bun/Deno listen                                                                                     |
| `honey/node`                                                                                                                                                                                                                                           | Low-level Node `serve()`                                                                                          |
| `honey/openapi`                                                                                                                                                                                                                                        | Register spec generation                                                                                          |
| `honey/openapi/spec` `honey/openapi/scalar` `honey/openapi/swagger`                                                                                                                                                                                    | Spec / UI pieces                                                                                                  |
| `honey/i18n`                                                                                                                                                                                                                                           | Register error i18n                                                                                               |
| `@lovrozagar/honey/plugin`                                                                                                                                                                                                                             | Vite plugin + `generateFromApp`                                                                                   |
| `honey/client` / `honey/client/sdk`                                                                                                                                                                                                                    | Typed TS client runtime / generated-SDK helpers                                                                   |
| `honey/cors` `honey/csrf` `honey/body-limit` `honey/logger` `honey/curl-logger` `honey/etag` `honey/timeout` `honey/request-id` `honey/secure-headers` `honey/server-timing` `honey/ip-restrict` `honey/powered-by` `honey/pretty-json` `honey/static` | Middleware                                                                                                        |
| `honey/proxy`                                                                                                                                                                                                                                          | `ProxyConfig` type (`.proxy()` lives on the route builder)                                                        |
| `honey/input`                                                                                                                                                                                                                                          | `readableStream()`                                                                                                |
| `honey/testing`                                                                                                                                                                                                                                        | `testClient`                                                                                                      |
| `honey/ws/bun` `honey/ws/node` `honey/ws/deno` `honey/ws/cloudflare`                                                                                                                                                                                   | WS adapters                                                                                                       |
| `honey/accepts` `honey/cookie` `honey/cookie-sign` `honey/crypto` `honey/request-to-curl`                                                                                                                                                              | Utilities                                                                                                         |
| `honey/telemetry/otel`                                                                                                                                                                                                                                 | `otelAdapter`                                                                                                     |
| `honey/codegen`                                                                                                                                                                                                                                        | `generateOpenApi`, `generateSDK`, `generateManifest`, trees, sanitize                                             |
| `honey/codegen-go-cli`                                                                                                                                                                                                                                 | `generateGoCLI`                                                                                                   |
| `honey/codegen/extract`                                                                                                                                                                                                                                | ts-morph chain extractor                                                                                          |
| `honey/build`                                                                                                                                                                                                                                          | `createBuildPlugin`                                                                                               |
| `honey/tree`                                                                                                                                                                                                                                           | Tree types + `mergeTree`                                                                                          |
| `honey/cli`                                                                                                                                                                                                                                            | `honey` binary                                                                                                    |
| `honey/errors`                                                                                                                                                                                                                                         | `defineErrors` (also on the root export)                                                                          |

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

| Command                  | What it proves                                                                   |
| ------------------------ | -------------------------------------------------------------------------------- |
| `bun run test`           | Core unit + integration. Default CI gate.                                        |
| `bun run test:consumers` | Each e2e app imports `honey` and hits a few routes in-process.                   |
| `bun run test:e2e`       | Playwright against Bun listen, every app.                                        |
| `bun run test:e2e:node`  | Same tests, Node (`tsx`) listen.                                                 |
| `bun run test:e2e:deno`  | Same tests, Deno listen.                                                         |
| `bun run test:e2e:cf`    | Same tests, local workerd. Kitchen REST publish is skipped (`HONEY_E2E_ENV=cf`). |
| `bun run test:harness`   | Generated SDKs compile and behave.                                               |

```bash
bun e2e/run.ts --env node --app kitchen
bun e2e/run.ts --env all --app surface
bun e2e/run.ts --env bun --mode prod
```

### E2E apps and runtimes

| App        | Covers                                                               |
| ---------- | -------------------------------------------------------------------- |
| `kitchen`  | Auth, CRUD, i18n, OpenAPI, SSE, WS, realtime, trailing slash, errors |
| `defaults` | Empty-middleware app, root OpenAPI, no CORS by default               |
| `compose`  | `.route()` groups, Scalar collision with a user `/docs`              |
| `surface`  | Every input source, output type, method, SSE, WS, uploads            |
| `gateway`  | `stripPrefix` + enforce slash, Swagger behind a prefix               |

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

Numbers and bundle sizes: [`bench/RESULTS.md`](https://github.com/lovrozagar/honey/blob/main/bench/RESULTS.md).

Python runtime tests skip without `httpx` (`pip install httpx`). Rust cargo tests skip without `cargo` or when `HONEY_RUST_INTEGRATION=0`. Go tests skip without `go`. Cargo artifacts go to `.cache/cargo-target`, not `/tmp`.

## Releases

The published package is [`@lovrozagar/honey`](https://www.npmjs.com/package/@lovrozagar/honey). That URL is the repository website. GitHub Releases match npm versions. Pushing a tag `vX.Y.Z` (same as this `package.json` `version`) runs the repo [`.github/workflows/release.yml`](https://github.com/lovrozagar/honey/blob/main/.github/workflows/release.yml): unit + typecheck + consumer tests, `npm publish` via trusted publishing, GitHub Packages, then a GitHub Release.

Configure the trusted publisher once on this package (Settings → Trusted Publisher → GitHub Actions): repository `lovrozagar/honey`, workflow `release.yml`, no environment, allow npm publish. Do not put an npm token in GitHub secrets.

## License

MIT
