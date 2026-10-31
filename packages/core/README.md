# @lovrozagar/honey

A typed web framework for the Fetch API whose routes are the source of its clients. You write a route once, with its
input and output schemas; honey serves it on Node, Bun or Cloudflare Workers, and
[`@lovrozagar/honey-clients`](https://www.npmjs.com/package/@lovrozagar/honey-clients) turns the same routes into an
OpenAPI 3.1 document, typed SDKs for six languages, a command-line client and an MCP server.

Nothing is inferred at runtime: the schemas you declare are what the handler receives, what the document says, and
what every generated client's types promise.

This page is the whole framework. Every TypeScript block below is type-checked by the repository's tests against this
package, so nothing here is pseudocode.

- [Install](#install)
- [A route, end to end](#a-route-end-to-end)
- [The app](#the-app)
- [Routing](#routing)
- [Input and output](#input-and-output)
- [Responses](#responses)
- [Errors](#errors)
- [Middleware](#middleware)
- [The request context](#the-request-context)
- [Cookies](#cookies)
- [Streaming, WebSockets and realtime](#streaming-websockets-and-realtime)
- [Serving on Node, Bun and Cloudflare Workers](#serving-on-node-bun-and-cloudflare-workers)
- [Static files and proxying](#static-files-and-proxying)
- [The OpenAPI document](#the-openapi-document)
- [The MCP server](#the-mcp-server)
- [Logging and tracing](#logging-and-tracing)
- [Internationalization and crypto](#internationalization-and-crypto)
- [Testing](#testing)
- [The build plugin and the honey CLI](#the-build-plugin-and-the-honey-cli)
- [Generated clients](#generated-clients)
- [Every export](#every-export)
- [Type helpers](#type-helpers)
- [Documentation](#documentation)
- [License](#license)

## Install

1.0 is out as a release candidate, published under npm's `next` tag, so an install without a tag still gives 0.7.3.
Add `@next` until the final release:

```sh
npm install @lovrozagar/honey@next
npx honey init
```

Node 22.12 or later, Bun 1.3 or later, or Cloudflare Workers. A schema library is yours to pick: honey validates
through [Standard Schema](https://standardschema.dev), so Zod, Valibot, ArkType, Effect Schema and Yup all work. The
examples here use Zod.

`honey init` writes `src/app.ts`, `src/server.ts` and a Vite config; `honey init --cf` adds a Worker entry and a
`wrangler.jsonc`.

## A route, end to end

Declare what a route takes and what it answers. `ctx.input` is typed by the schemas, and so is `ctx.res.json`'s
payload for the status key you name:

```ts
import { defineErrors, honey } from "@lovrozagar/honey"
import * as z from "zod"

const errors = defineErrors({ not_found: "not_found" })

const app = honey()

app
	.get("/books/:id")
	.input({ params: z.object({ id: z.string() }), search: z.object({ lang: z.string().optional() }) })
	.output({ "application/json": { ok: z.object({ id: z.string(), title: z.string() }) } })
	.errors(errors, "not_found")
	.handler((ctx) => {
		if (ctx.input.params.id === "0") throw errors.not_found()
		return ctx.res.json("ok", { id: ctx.input.params.id, title: "Dune" })
	})

app
	.post("/books")
	.input({ json: z.object({ title: z.string().min(1) }) })
	.handler((ctx) => ctx.res.json("created", { id: "b-1", title: ctx.input.json.title }))

export default app
```

Serving is the same for any app, and the reference UI comes from the document the routes already describe:

```ts
import { honey } from "@lovrozagar/honey"
import { serveOpenApi } from "@lovrozagar/honey/openapi"
import { serve } from "@lovrozagar/honey/serve"

const app = honey()
app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

await serve(serveOpenApi(app, { docs: "scalar", title: "Books", version: "1.0.0" }), { port: 3000 })
```

```sh
curl http://127.0.0.1:3000/health
# ok
# the API reference: open http://127.0.0.1:3000/docs
```

Then generate a client from the app module itself, with no document to keep in step by hand:

```sh
npx honey-clients generate --app src/app.ts --target ts --out generated
```

## The app

`honey<TEnv>()` returns an app typed to its runtime environment — a Worker's bindings, or whatever your adapter
passes. The chain derives handles that share one settings graph: `basePath()` rebases every route registered through
it, `context()` adds static values the handler finds on `ctx`, and `use()` installs middleware for that handle and
its descendants.

```ts
import { honey } from "@lovrozagar/honey"

type Env = { GREETING: string }

const app = honey<Env>().basePath("/api").context({ startedAt: Date.now() })

app.get("/hello").handler((ctx) => ctx.res.json("ok", { greeting: ctx.env.GREETING, since: ctx.startedAt }))

export default app
```

`context()` values are fixed at registration; per-request data belongs in middleware, which passes it through
`next({ … })`.

Settings sit on the same chain and apply to the whole app:

```ts
import { honey } from "@lovrozagar/honey"

const app = honey()
	.trailingSlash("strip")
	.encodedSlashes("reject")
	.outputValidation("always")
	.errorFormat("problem+json")
	.onNotFound((ctx) => new Response(`no route for ${new URL(ctx.req.url).pathname}`, { status: 404 }))
	.onMethodNotAllowed((ctx) => new Response(null, { headers: { allow: ctx.allowed.join(", ") }, status: 405 }))

app.get("/").handler((ctx) => ctx.res.text("ok", "up"))
```

| Setting                                          | What it does                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| `basePath(prefix)`                               | rebases every route and OpenAPI path registered through the handle     |
| `context(values)`                                | static values on `ctx`, typed into the handler                         |
| `use(mw)` / `use(path, mw)`                      | middleware for this handle and its descendants, or for one path        |
| `route(prefix, sub)`                             | mounts a sub-app under a prefix                                        |
| `meta(values)`                                   | app-level route meta every route inherits                              |
| `errorFactory(factory)`, `defaultErrors(…)`      | the error factory routes throw from, and the keys every route declares |
| `defaultBoundary(key)`                           | the error an unexpected throw becomes                                  |
| `onError(handler)`                               | maps a thrown value to a response before error telemetry               |
| `onNotFound(handler)`, `onMethodNotAllowed(…)`   | the two misses                                                         |
| `logger(logger \| false)`, `requestLog(…)`       | where lines go, and the one-line-per-request log                       |
| `telemetry(value)`                               | the tracing adapter (`otelAdapter`)                                    |
| `errorFormat(format)`                            | `"honey"` (the default) or `"problem+json"` (RFC 9457)                 |
| `defaultErrorFormatter`, `customErrorFormatter`  | your own error body, schema-checked                                    |
| `outputValidation(mode)`                         | what a response that does not match its `.output()` does               |
| `trailingSlash`, `encodedSlashes`, `stripPrefix` | path normalization, and the prefix a gateway already consumed          |
| `wsAdapter(adapter)`                             | the WebSocket adapter, when `serve()` does not pick one                |
| `fetch(request, env, ctx)`                       | the Fetch handler an adapter calls                                     |

Full reference: [the app](https://github.com/lovrozagar/honey/blob/main/docs/app-settings.md).

## Routing

One method per call (`get`, `post`, `put`, `patch`, `delete`, `head`, `options`), `all` for any, and `on` for a named
set. Paths take `:params` and a trailing `*` wildcard; `meta()` carries what the document says about the route.

```ts
import { honey } from "@lovrozagar/honey"
import { serveOpenApi } from "@lovrozagar/honey/openapi"

const app = honey()

app
	.get("/users/:id")
	.meta({ operationId: "users.get", summary: "One user", tags: ["users"] })
	.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

app.delete("/users/:id").handler((ctx) => ctx.res.noContent())

serveOpenApi(app, { title: "Users", version: "1.0.0", docs: "scalar" })
```

Sub-apps mount with `route()`, and `on()` registers one handler for several methods:

```ts
import { honey } from "@lovrozagar/honey"

const admin = honey()
admin.get("/stats").handler((ctx) => ctx.res.json("ok", { users: 1 }))

const app = honey()
app.route("/admin", admin)
app.on(["POST", "PUT"], "/webhooks/:source").handler((ctx) => ctx.res.json("accepted", { from: ctx.params.source }))
```

A gateway merges the route trees its services publish, each tree tagged with meta of its own:

```ts
import { mergeTree } from "@lovrozagar/honey"
import type { RouteTree } from "@lovrozagar/honey/tree"

declare const orders: RouteTree
declare const billing: RouteTree

const gateway = mergeTree([orders, { service: "orders" }], [billing, { service: "billing" }])
```

Full reference: [routing](https://github.com/lovrozagar/honey/blob/main/docs/routing.md).

## Input and output

`.input()` validates the request: `params`, `search`, `headers`, `json`, `form` and `text`, each a Standard Schema.
`.output()` declares what the route answers, by media type and status key, and the declared response headers. A
media type other than JSON is just another key, so an image or a CSV is as typed as a JSON body:

```ts
import { honey } from "@lovrozagar/honey"
import * as z from "zod"

const app = honey()

app
	.get("/avatar/:id")
	.output({
		"image/png": { ok: z.instanceof(Uint8Array) },
		headers: { ok: z.object({ etag: z.string() }) },
	})
	.handler((ctx) =>
		ctx.res.binary("ok", new Uint8Array([137, 80, 78, 71]), { contentType: "image/png", headers: { etag: '"v1"' } }),
	)
```

A body you do not want in memory is input too: `readableStream()` hands the handler the stream itself.

```ts
import { honey } from "@lovrozagar/honey"
import { readableStream } from "@lovrozagar/honey/input"
import * as z from "zod"

const app = honey()

app
	.post("/ingest")
	.input({ json: readableStream(z.object({ chunks: z.number(), fileName: z.string() })) })
	.handler(async (ctx) => {
		/* the schema is what the document and the clients promise; the body itself stays on the request */
		const reader = (ctx.req.body as ReadableStream<Uint8Array>).getReader()
		await reader.cancel()
		return ctx.res.json("accepted", { taken: true })
	})
```

Content negotiation, when a route answers in more than one shape, reads the request directly:

```ts
import { accepts } from "@lovrozagar/honey/accepts"
import { honey } from "@lovrozagar/honey"

const app = honey()

app.get("/report").handler((ctx) => {
	const type = accepts(ctx.req, ["text/csv", "application/json"])
	if (type === "text/csv") return ctx.res.csv("ok", "name,count\nada,1\n")
	return ctx.res.json("ok", [{ count: 1, name: "ada" }])
})
```

Full reference: [input and output](https://github.com/lovrozagar/honey/blob/main/docs/input-output.md).

## Responses

`ctx.res` builds a typed response: `json`, `text`, `html`, `xml`, `csv`, `binary`, `noContent`, `redirect`, `raw` for
a `Response` you made yourself, and `sse`, `stream` and `generate` for bodies that arrive over time. The first
argument is the status key the route declared, which is what makes the payload's type the right one.

```ts
import { honey } from "@lovrozagar/honey"

const app = honey()

app.get("/page").handler((ctx) => ctx.res.html("ok", "<h1>hi</h1>"))
app.get("/feed").handler((ctx) => ctx.res.xml("ok", "<feed />"))
app.get("/old").handler((ctx) => ctx.res.redirect("/new"))
app.get("/nothing").handler((ctx) => ctx.res.noContent())
app.get("/bytes").handler((ctx) =>
	ctx.res.stream(async (writable) => {
		const writer = writable.getWriter()
		await writer.write(new TextEncoder().encode("chunk"))
		await writer.close()
	}),
)
```

Caching, entity tags and byte ranges are middleware and helpers over any of those:

```ts
import { honey } from "@lovrozagar/honey"
import { cacheControl } from "@lovrozagar/honey/cache-control"
import { etag } from "@lovrozagar/honey/etag"
import { prettyJson } from "@lovrozagar/honey/pretty-json"
import { rangeResponse } from "@lovrozagar/honey/range"

const video = new Blob([new Uint8Array(1024)], { type: "video/mp4" })

const app = honey()
	.use(etag())
	.use(prettyJson({ query: "pretty" }))
	.use(cacheControl({ public: true, maxAge: 60, staleWhileRevalidate: 300 }))

app.get("/prices").handler((ctx) => ctx.res.json("ok", { eur: 1.08 }))
app.get("/video").handler((ctx) => ctx.res.raw(rangeResponse(ctx.req, video)))
```

`etag()` answers a conditional GET with 304, `rangeResponse` a `Range` request with 206, and `cacheControl` sets the
header once for every route under it. `httpDate` from the same subpath formats an HTTP date, and `notModified` from
`@lovrozagar/honey/etag` turns a response into its 304.

Streaming bodies clean up when the client leaves — the generator's `finally` runs:

```ts run
import { honey } from "@lovrozagar/honey"
import { serve } from "@lovrozagar/honey/serve"

let ended = (_: string) => {}
const cleanedUp = new Promise<string>((resolve) => (ended = resolve))

const app = honey()

app.get("/ticks").handler((ctx) =>
	ctx.res.sse(
		async (stream) => {
			try {
				for (let tick = 1; !stream.closed; tick++) {
					await stream.send({ data: String(tick), event: "tick", id: String(tick) })
					await new Promise((resolve) => setTimeout(resolve, 50))
				}
			} finally {
				stream.close()
				ended("cleaned up")
			}
		},
		{ defaultRetry: 3000 },
	),
)

const server = await serve(app, { hostname: "127.0.0.1", port: 0 })
const leave = new AbortController()
const response = await fetch(`${server.url}/ticks`, { signal: leave.signal })
const reader = (response.body as ReadableStream<Uint8Array>).getReader()
const first = new TextDecoder().decode((await reader.read()).value)
console.log(first.includes("retry: 3000") ? "retry sent" : "no retry")
leave.abort()
console.log(await cleanedUp)
await server.close()
// prints: retry sent
// prints: cleaned up
```

Full reference: [streaming](https://github.com/lovrozagar/honey/blob/main/docs/streaming.md),
[media types](https://github.com/lovrozagar/honey/blob/main/docs/capabilities/media-types.md),
[range requests](https://github.com/lovrozagar/honey/blob/main/docs/capabilities/range.md) and
[Cache-Control](https://github.com/lovrozagar/honey/blob/main/docs/capabilities/cache-control.md).

## Errors

`defineErrors` maps your own keys to HTTP statuses and gives you the factory a route throws from. A route declares
which keys it can throw with `.errors()`, and those keys are what the document and every generated client know
about.

```ts
import { defineErrors, honey } from "@lovrozagar/honey"

const errors = defineErrors({ out_of_stock: "conflict" })

const app = honey().errorFormat("problem+json")

app
	.post("/orders")
	.errors(errors, "out_of_stock")
	.handler(() => {
		throw errors.out_of_stock()
	})
```

`errorFormat("problem+json")` answers RFC 9457 Problem Details instead of honey's own body. Anything thrown becomes a
`HoneyError`; `onError` sees it first, and `ERROR_META` is the symbol a thrown value carries its status under, so a
value from elsewhere can present itself as one. `createErrorResponse` builds the body outside a request, which is
what a custom formatter or a test harness needs.

```ts
import {
	createErrorResponse,
	defineErrors,
	ERROR_META,
	type ErrorFormatter,
	HoneyError,
	honey,
} from "@lovrozagar/honey"

const errors = defineErrors({ db_timeout: "service_unavailable" })

const app = honey().onError((error, ctx) => {
	if (error instanceof HoneyError && error.errorKey === "db_timeout") return ctx.jsonFromError(error)
	return undefined
})

app.get("/").handler((ctx) => ctx.res.text("ok", "up"))

/* a thrown value of your own, carrying the status honey should answer with */
const refusal = Object.assign(new Error("nope"), { [ERROR_META]: { errorKey: "forbidden", status: 403 } })

/* the body an error answers with: the default shape, plus whatever your API adds to it */
const formatter: ErrorFormatter = (error, defaultShape) => ({ ...defaultShape, retriable: error.status >= 500 })
const answer = createErrorResponse(errors.db_timeout(), formatter, null, { format: "problem+json" })
```

Full reference: [problem+json](https://github.com/lovrozagar/honey/blob/main/docs/capabilities/problem-json.md) and
[logging, errors and tracing](https://github.com/lovrozagar/honey/blob/main/docs/observability.md).

## Middleware

A middleware is a function of `(ctx, next)`. Calling `next({ … })` adds typed values to the context every route below
it sees — that is how per-request data (a user, a tenant, a database handle) reaches a handler without a global.

```ts
import { type MiddlewareFn, honey } from "@lovrozagar/honey"
import { cors } from "@lovrozagar/honey/cors"
import { rateLimit } from "@lovrozagar/honey/rate-limit"
import { secureHeaders } from "@lovrozagar/honey/secure-headers"

type UserCtx = { user: { id: string } | null }

const withUser: MiddlewareFn<{ req: Request }, UserCtx> = (ctx, next) => {
	const token = ctx.req.headers.get("authorization")
	return next({ user: token === null ? null : { id: "u1" } })
}

const app = honey()
	.use(secureHeaders())
	.use(cors({ origin: ["https://app.example.com"], credentials: true }))
	.use(rateLimit({ limit: 100, windowMs: 60_000 }))
	.use(withUser)

app.get("/me").handler((ctx) => ctx.res.json("ok", { user: ctx.user }))
```

`createMiddleware` is the same thing with the context type given once, and `defineMiddleware` keeps a middleware
reusable across apps:

```ts
import { createMiddleware, defineMiddleware, honey } from "@lovrozagar/honey"

const requireKey = createMiddleware<{ req: Request }>((ctx, next) =>
	ctx.req.headers.get("x-api-key") === null ? new Response(null, { status: 401 }) : next(),
)

const stamp = defineMiddleware({ fn: (_ctx: { req: Request }, next) => next({ at: Date.now() }) })

const app = honey().use(requireKey).use(stamp)
app.get("/me").handler((ctx) => ctx.res.json("ok", { at: ctx.at }))
```

The bundled set, each its own subpath so an app that does not import it bundles none of it:

```ts
import { honey } from "@lovrozagar/honey"
import { bodyLimit } from "@lovrozagar/honey/body-limit"
import { compress } from "@lovrozagar/honey/compress"
import { csrf } from "@lovrozagar/honey/csrf"
import { ipRestrict } from "@lovrozagar/honey/ip-restrict"
import { poweredBy } from "@lovrozagar/honey/powered-by"
import { requestId } from "@lovrozagar/honey/request-id"
import { serverTiming } from "@lovrozagar/honey/server-timing"
import { timeout } from "@lovrozagar/honey/timeout"

const app = honey()
	.use(requestId())
	.use(poweredBy())
	.use(serverTiming())
	.use(timeout({ duration: 10_000 }))
	.use(bodyLimit({ maxSize: 1024 * 1024 }))
	.use(compress({ threshold: 2048 }))
	.use(csrf({ origin: ["https://app.example.com"] }))
	.use(ipRestrict({ allowList: ["203.0.113.0/24"] }))

app.get("/report").handler((ctx) => ctx.res.text("ok", "row\n".repeat(5000)))
```

| Middleware                | From                               | What it does                                               |
| ------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| `cors(options)`           | `@lovrozagar/honey/cors`           | the CORS headers and the preflight answer                  |
| `secureHeaders(options?)` | `@lovrozagar/honey/secure-headers` | CSP, HSTS and the rest of the hardening headers            |
| `csrf(options?)`          | `@lovrozagar/honey/csrf`           | refuses a cross-origin unsafe method                       |
| `rateLimit(options)`      | `@lovrozagar/honey/rate-limit`     | a window per key, with `memoryStore()` or one of your own  |
| `compress(options?)`      | `@lovrozagar/honey/compress`       | gzip or brotli over a threshold                            |
| `cacheControl(options)`   | `@lovrozagar/honey/cache-control`  | the `Cache-Control` header, and `httpDate`                 |
| `etag(options?)`          | `@lovrozagar/honey/etag`           | an entity tag, 304 on a conditional GET, and `notModified` |
| `prettyJson(options?)`    | `@lovrozagar/honey/pretty-json`    | indents a JSON body when the query asks                    |
| `requestId(options?)`     | `@lovrozagar/honey/request-id`     | one id per request, on the response and in the log         |
| `timeout(options)`        | `@lovrozagar/honey/timeout`        | a deadline per request                                     |
| `bodyLimit(options)`      | `@lovrozagar/honey/body-limit`     | refuses a body over a size                                 |
| `ipRestrict(options)`     | `@lovrozagar/honey/ip-restrict`    | an allow or deny list over `ctx.ip`                        |
| `serverTiming()`          | `@lovrozagar/honey/server-timing`  | `Server-Timing`, and `ctx.timing` to add to it             |
| `poweredBy(options?)`     | `@lovrozagar/honey/powered-by`     | the `X-Powered-By` header                                  |
| `staticFiles(options)`    | `@lovrozagar/honey/static`         | serves files under a prefix                                |
| `curlLogger(options?)`    | `@lovrozagar/honey/curl-logger`    | logs each request as the command that would repeat it      |

Full reference: [middleware](https://github.com/lovrozagar/honey/blob/main/docs/middleware.md),
[rate limiting](https://github.com/lovrozagar/honey/blob/main/docs/capabilities/rate-limit.md) and
[compression](https://github.com/lovrozagar/honey/blob/main/docs/capabilities/compress.md).

## The request context

The handler's `ctx` is one object, and these keys are reserved on it: `req`, `env`, `executionCtx`, `path`,
`params`, `search`, `searchAll`, `headers`, `input`, `ip`, `res`, `errors`, `error`, `meta`, `routePattern`,
`cookies`, `log`, `logger`, `signal`, `background` and `tap`. Everything else on `ctx` is yours, from `context()` or
from a middleware's `next({ … })`.

```ts
import { honey } from "@lovrozagar/honey"

const app = honey()

app.get("/where/:id").handler((ctx) => {
	ctx.log.info({ id: ctx.params.id }, "asked")
	ctx.background(Promise.resolve())
	return ctx.res.json("ok", {
		accept: ctx.headers.accept ?? null,
		aborted: ctx.signal.aborted,
		id: ctx.params.id,
		ip: ctx.ip,
		pattern: ctx.routePattern,
		path: ctx.path,
		tags: ctx.searchAll.tag ?? [],
		verbose: ctx.search.verbose ?? null,
	})
})
```

`background(promise)` keeps work alive past the response where the runtime allows it, `signal` aborts when the client
leaves, and `log` is the request's logger with the request id already bound. `HoneyContext` is the class behind it
and `HoneyRes` the response builder, both exported for a helper of your own that takes either.

## Cookies

`ctx.cookies` reads them, and a response sets them. Signed cookies are a signer you build from your secrets, newest
first, so a rotation keeps the old ones verifying:

```ts
import { honey } from "@lovrozagar/honey"
import { createCookieSigner } from "@lovrozagar/honey/cookie-sign"

const signer = createCookieSigner([process.env.COOKIE_SECRET ?? ""])

const app = honey()

app.post("/login").handler(async (ctx) => {
	const session = await signer.sign("user-1")
	const cookie = { value: session, httpOnly: true, secure: true, sameSite: "lax" as const, path: "/" }
	return ctx.res.json("ok", { signedIn: true }, { cookies: { session: cookie } })
})

app.get("/me").handler(async (ctx) => {
	const raw = ctx.cookies.session
	const user = raw === undefined ? null : await signer.verify(raw)
	return ctx.res.json("ok", { user })
})
```

`@lovrozagar/honey/cookie` has the header functions on their own (`serializeCookie`, `parseCookieHeader`) and
`@lovrozagar/honey/cookie-sign` the one-shot `sign` and `verify`:

```ts
import { parseCookieHeader, serializeCookie } from "@lovrozagar/honey/cookie"
import { sign, verify } from "@lovrozagar/honey/cookie-sign"

declare const req: Request
declare const SECRET: string
declare const OLD_SECRET: string

const jar = parseCookieHeader(req.headers.get("cookie") ?? "")
const header = serializeCookie("theme", { value: "dark", httpOnly: true, path: "/", sameSite: "lax" })

/* a signature bound to the cookie's name; verify takes every secret still accepted, newest first */
const signed = await sign("abc", SECRET, { name: "sid" })
const value = await verify(signed, [SECRET, OLD_SECRET], { name: "sid" })
```

Full reference: [cookies](https://github.com/lovrozagar/honey/blob/main/docs/cookies.md).

## Streaming, WebSockets and realtime

A WebSocket route is `ws(app, path)`; a resumable connection — one logical subscription over WebSocket, SSE or
long-poll, whichever the client can hold — is `realtime(app, path, options)`. Both publish to rooms, and a plain
route can publish into them.

```ts
import { honey } from "@lovrozagar/honey"
import { realtime } from "@lovrozagar/honey/realtime"
import { ws } from "@lovrozagar/honey/ws"

const app = honey()

ws(app, "/echo").handler({
	onMessage(_ctx, socket, data) {
		socket.send(data)
	},
})

const chat = realtime(app, "/chat/:room", {
	namespace: "chat",
	handler: (_ctx, conn) => {
		conn.join("lobby")
		conn.on("message", (payload) => conn.publish("lobby", payload))
	},
})

app.post("/announce").handler(async (ctx) => {
	chat.publish("lobby", await ctx.req.json())
	return ctx.res.json("ok", { sent: true })
})
```

A publisher outside a connection works the same way, which is what a ticker is:

```ts
import { honey } from "@lovrozagar/honey"
import { realtime } from "@lovrozagar/honey/realtime"

const app = honey()

const prices = realtime(app, "/prices", {
	namespace: "prices",
	handler: (_ctx, conn) => {
		conn.join("ticker")
	},
})

setInterval(() => prices.publish("ticker", { eur: 1.08, at: Date.now() }), 1000)
```

`serve()` picks the adapter for Node and Bun; a Worker sets one itself. `createWsSession` from
`@lovrozagar/honey/ws/session` is the session runtime those adapters share, for an adapter of your own:

```ts
import { createWsSession } from "@lovrozagar/honey/ws/session"
import { bunWebSocket } from "@lovrozagar/honey/ws/bun"
import { cfWebSocket } from "@lovrozagar/honey/ws/cloudflare"
import { nodeWebSocket } from "@lovrozagar/honey/ws/node"
import { honey } from "@lovrozagar/honey"

/* each runtime's adapter; serve() sets the first two, a Worker entry the third */
const adapters = [bunWebSocket(), nodeWebSocket(), cfWebSocket()]
const app = honey().wsAdapter(cfWebSocket())

/* the ordered lane a custom adapter drives: open, then messages, then close */
const session = createWsSession({
	callbacks: { onMessage: (_ctx, socket, data) => socket.send(data) },
	ctx: {},
	log: null,
	reconnectToken: null,
	route: "/echo",
})
```

`nodeWebSocket()` needs the optional `ws` peer installed; the Bun and Workers adapters use their runtime's own
sockets. A resumed connection replays from the client's `Last-Event-ID` or `reconnect_token`.

Full reference: [WebSockets, realtime and SSE](https://github.com/lovrozagar/honey/blob/main/docs/realtime.md) and
[realtime resume](https://github.com/lovrozagar/honey/blob/main/docs/capabilities/realtime-resume.md).

## Serving on Node, Bun and Cloudflare Workers

One app runs on each of them; only how it is served differs.

| Runtime            | How it runs                                                                       |
| ------------------ | --------------------------------------------------------------------------------- |
| Node               | `serve(app)` from `@lovrozagar/honey/serve`                                       |
| Bun                | `serve(app)`, or `Bun.serve({ fetch: app.fetch })`                                |
| Cloudflare Workers | `export default app` — the Worker's `fetch` handler, with named exports beside it |

```ts
import { detectRuntime, honey, toFetchRequest } from "@lovrozagar/honey"
import { serve } from "@lovrozagar/honey/serve"

const app = honey()
app.get("/health").handler((ctx) => ctx.res.text("ok", detectRuntime()))

/* a request from an adapter that handed you its own Request subclass */
declare const incoming: Request
const request = toFetchRequest(incoming)

const server = await serve(app, { hostname: "127.0.0.1", maxRequestBodySize: 8 * 1024 * 1024, port: 0 })
console.log(server.url)
await server.close()
```

`@lovrozagar/honey/serve` is the one to reach for: it resolves the runtime itself and returns a `ServeHandle` with
the bound `url` and a `close()` that drains. `@lovrozagar/honey/node` is `node:http` directly, for an existing
server or a framework that hands you one:

```ts
import { honey } from "@lovrozagar/honey"
import { serve } from "@lovrozagar/honey/node"

const app = honey()
app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

const server = await serve(app, { env: {}, port: 0 })
await server.close()
```

On Workers the app is the default export, and `app.fetch` the handler to wrap when you need to:

```ts
import { honey } from "@lovrozagar/honey"

type Env = { readonly SECRET: string }

const app = honey<Env>()
app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

export default { fetch: (...args: Parameters<typeof app.fetch>) => app.fetch(...args) }
```

## Static files and proxying

`staticFiles()` serves what a resolver of yours returns, so the bytes can come from a bundle, a KV store or a disk
read — honey never assumes a filesystem.

```ts
import { honey } from "@lovrozagar/honey"
import { cacheControl } from "@lovrozagar/honey/cache-control"
import { staticFiles } from "@lovrozagar/honey/static"

const assets = new Map<string, Blob>([["/app.js", new Blob(["console.log(1)"])]])

const app = honey()
	.use(cacheControl({ public: true, maxAge: 3600 }))
	.use(staticFiles({ prefix: "/assets", resolve: (_ctx, path) => assets.get(path) ?? null }))
```

`proxy()` is a handler that forwards, which is what makes an app a gateway: you own the destination call, so the
upstream is explicit and nothing is reachable by accident.

```ts
import { honey } from "@lovrozagar/honey"
import { proxy } from "@lovrozagar/honey/proxy"

const app = honey()

app.all("/billing/*").handler(
	proxy({
		destination: (_ctx, url, init) => fetch(`https://billing.internal.example.com${url}`, init),
		requestHeaders: { "x-gateway": "edge" },
		timeout: 10_000,
	}),
)
```

Full reference: [static files](https://github.com/lovrozagar/honey/blob/main/docs/static.md) and
[proxying and gateways](https://github.com/lovrozagar/honey/blob/main/docs/proxy.md).

## The OpenAPI document

`serveOpenApi(app, options)` returns the app with the document and its reference UI mounted; `generateOpenApi` gives
you the document as a value instead, for a file you commit or a build step. Tags, servers with variables,
externalDocs and webhooks are all declared, never guessed.

```ts
import { honey } from "@lovrozagar/honey"
import { serveOpenApi } from "@lovrozagar/honey/openapi"

const app = honey()

app
	.get("/orders")
	.meta({ summary: "List orders", tags: ["orders"] })
	.handler((ctx) => ctx.res.json("ok", []))

serveOpenApi(app, {
	title: "Shop",
	version: "1.2.0",
	servers: [{ url: "https://{region}.api.example.com", variables: { region: { default: "eu" } } }],
	tags: [{ name: "orders", description: "Placing and tracking orders" }],
	docs: "scalar",
})
```

The document as a value, the route manifest, YAML, and either reference page explicitly:

```ts
import { honey } from "@lovrozagar/honey"
import { generateManifest, generateOpenApi, serveManifest, toYaml } from "@lovrozagar/honey/openapi"
import { scalar } from "@lovrozagar/honey/openapi/scalar"
import { swagger } from "@lovrozagar/honey/openapi/swagger"

const app = honey()
app.get("/orders").handler((ctx) => ctx.res.json("ok", []))

const document = generateOpenApi(app, { info: { title: "Shop", version: "1.2.0" } })
const manifest = generateManifest(app, {})
const yaml = toYaml(document)

serveManifest(app, { path: "/manifest.json" })

/* the two reference pages, if you mount one yourself rather than through docs: */
const pages = [scalar({ title: "Shop", url: "/openapi.json" }), swagger({ title: "Shop", url: "/openapi.json" })]
```

Webhooks — the requests your API sends out — are declared with the document, signature and all, so a generated
client gets a typed parser and a verifier for them:

```ts
import { honey } from "@lovrozagar/honey"
import { serveOpenApi } from "@lovrozagar/honey/openapi"
import * as z from "zod"

const app = honey()

serveOpenApi(app, {
	title: "Shop",
	version: "1.0.0",
	webhooks: {
		orderShipped: {
			body: z.object({ orderId: z.string(), shippedAt: z.string() }),
			signature: { algorithm: "hmac-sha256", encoding: "hex", header: "x-signature", prefix: "sha256=" },
			summary: "An order left the warehouse",
		},
	},
})
```

Full reference: [the OpenAPI document](https://github.com/lovrozagar/honey/blob/main/docs/openapi.md) and
[webhooks](https://github.com/lovrozagar/honey/blob/main/docs/capabilities/webhooks.md).

## The MCP server

There are two ways to serve your API's tools over the Model Context Protocol, and they run in different places. The
standalone server `honey-clients generate --target mcp` writes needs Node, and is what a local stdio install
(Claude Desktop, Claude Code, Cursor) starts. The mounted endpoint below runs wherever the app runs — Workers
included — dispatches in process, and is guarded by the app's own auth. It is the one to use remotely.

`mcp(app, path, handler, options)` mounts the handler `codegen.mcp` generated beside your app:

```ts
import { honey } from "@lovrozagar/honey"
import { type McpHandler, mcp } from "@lovrozagar/honey/mcp"

/* in the app: import { mcpHandler } from "./_gen/mcp.gen.ts" */
declare const mcpHandler: McpHandler

const app = honey()
mcp(app, "/mcp", mcpHandler, {
	authenticate: (request) => /^ApiKey \S+$/.test(request.headers.get("authorization") ?? ""),
})
```

Three opt-ins ride on the mount. `oauth()` makes the endpoint an OAuth 2.1 resource server (RFC 9728 metadata and
Bearer challenges), which is what ChatGPT requires; `uploads()` takes files out of band, so a large file never goes
through a tool argument; `urlFiles()` lets a file argument be an https URL from a host you list.

```ts
import { honey } from "@lovrozagar/honey"
import { type McpHandler, mcp } from "@lovrozagar/honey/mcp"
import { oauth } from "@lovrozagar/honey/mcp/oauth"
import { memoryUploadStore, uploads } from "@lovrozagar/honey/mcp/uploads"
import { urlFiles } from "@lovrozagar/honey/mcp/url-files"

/* in the app: import { mcpHandler } from "./_gen/mcp.gen.ts" */
declare const mcpHandler: McpHandler
declare const UPLOAD_SECRET: string

const app = honey()
mcp(app, "/mcp", mcpHandler, {
	authenticate: (request) => /^ApiKey \S+$/.test(request.headers.get("authorization") ?? ""),
	oauth: oauth({
		authorizationServers: ["https://auth.example.com"],
		resource: "https://mcp.example.com/mcp",
		resourceName: "Example",
		scopesSupported: ["mcp:read"],
	}),
	uploads: uploads({ secret: UPLOAD_SECRET, store: memoryUploadStore() }),
	urlFiles: urlFiles({ hosts: ["files.example.com"] }),
})
```

`memoryUploadStore()` is for one process; on Workers the store is yours (a Durable Object for the claim, R2 for the
bytes), and the MCP page shows that end to end. Only a route marked `meta({ mcp: true })` becomes a tool, and each
tool's input and output schemas come from the route's own.

Full reference: [the generated MCP server](https://github.com/lovrozagar/honey/blob/main/docs/mcp.md) and
[MCP structured output](https://github.com/lovrozagar/honey/blob/main/docs/capabilities/mcp-structured-output.md).

## Logging and tracing

`logger()` sets where lines go, `requestLog()` turns on the one line per request, and `onError` maps a thrown value
to a response before the error is reported.

```ts
import { HoneyError, honey } from "@lovrozagar/honey"
import { createLogger } from "@lovrozagar/honey/logger"
import { requestId } from "@lovrozagar/honey/request-id"

const app = honey()
	.use(requestId())
	.logger(createLogger({ level: "info" }))
	.requestLog(true)
	.onError((error, ctx) => {
		if (error instanceof HoneyError && error.errorKey === "db_timeout") return ctx.jsonFromError(error)
		return undefined
	})

app.get("/").handler((ctx) => ctx.res.text("ok", "up"))
```

Tracing is an adapter: `otelAdapter` nests `http.request` → `middleware.*` → `http.handler` and continues an incoming
W3C `traceparent`, so a span from a caller stays one trace. With it on, the logger's child binds `trace_id` and
`span_id`, and `requestId` stays the client-facing id.

```ts
import { honey } from "@lovrozagar/honey"
import { createLogger } from "@lovrozagar/honey/logger"
import { otelAdapter, type OtelApi } from "@lovrozagar/honey/telemetry/otel"

declare const api: OtelApi

const app = honey()
	.logger(createLogger({ level: "info" }))
	.telemetry(otelAdapter(api))
	.requestLog(true)

app.get("/").handler((ctx) => ctx.res.text("ok", "up"))
```

A request logged as the command that would repeat it is its own middleware, and the same formatter is available on
its own for a failing call you want to paste into a terminal — both redact credentials by default:

```ts
import { honey } from "@lovrozagar/honey"
import { curlLogger } from "@lovrozagar/honey/curl-logger"
import { requestToCurl } from "@lovrozagar/honey/request-to-curl"

declare const req: Request

const app = honey().use(curlLogger())
app.get("/").handler((ctx) => ctx.res.text("ok", "up"))

/* the authorization header left out of the logged command */
const command = await requestToCurl(req, { excludeHeader: (name) => name === "authorization" })
```

Full reference: [logging, errors and tracing](https://github.com/lovrozagar/honey/blob/main/docs/observability.md).

## Internationalization and crypto

Error messages translate through a dictionary you supply, and ICU messages interpolate with plurals:

```ts run
import { interpolate } from "@lovrozagar/honey/i18n"

const message = "{count, plural, one {# new message} other {# new messages}} for {name}"
console.log(interpolate(message, { count: 3, name: "Ada" }, "en"))
// prints: 3 new messages for Ada
```

```ts
import { defineErrors, honey } from "@lovrozagar/honey"
import { errorI18n, translateError } from "@lovrozagar/honey/i18n"

const errors = defineErrors({ not_found: "not_found" })

/* locale, then error key, then the ICU template that key's message reads from */
const translations = { errors: { de: { not_found: "Nicht gefunden" }, en: { not_found: "Not found" } } }

const app = honey().errorI18n(
	errorI18n({ ...translations, resolveLocale: (ctx) => ctx.headers["accept-language"]?.slice(0, 2) ?? "en" }),
)

app.get("/books/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

const german = translateError(errors.not_found(), translations, "de")
```

Crypto is WebCrypto, with the comparison that does not leak by timing:

```ts run
import { timingSafeEqual } from "@lovrozagar/honey/crypto"

const expected = "s3cret-token"
console.log(await timingSafeEqual("s3cret-token", expected), await timingSafeEqual("guess", expected))
// prints: true false
```

Full reference: [internationalization](https://github.com/lovrozagar/honey/blob/main/docs/i18n.md) and
[crypto](https://github.com/lovrozagar/honey/blob/main/docs/crypto.md).

## Testing

`testClient(app, options)` calls the app the way a client would, in process by default — no port, no server — and
over real HTTP when you ask for it. Request fields a handler reads but a test cannot easily forge, such as `ip`, are
options rather than mocks.

```ts run
import { honey } from "@lovrozagar/honey"
import { testClient } from "@lovrozagar/honey/testing"

const app = honey()
app.get("/hello").handler((ctx) => ctx.res.json("ok", { hello: ctx.search.name ?? "world", ip: ctx.ip }))

const client = testClient(app, { env: {} })
const answer = await client.get("/hello", { search: { name: "Ada" }, ip: "203.0.113.7" })
console.log(answer.status, JSON.stringify(await answer.json()))
// prints: 200 {"hello":"Ada","ip":"203.0.113.7"}
```

Full reference: [testing an app](https://github.com/lovrozagar/honey/blob/main/docs/testing.md) and
[SDK conformance](https://github.com/lovrozagar/honey/blob/main/docs/conformance.md), which is how the generated
clients are held to behaving alike.

## The build plugin and the honey CLI

The Vite plugin writes the app's artifacts — the route tree, the types, the manifest, the OpenAPI document and the
MCP handler — at build start, and again on each save in dev:

```ts
import { honey } from "@lovrozagar/honey/plugin"
import { defineConfig } from "vite"

export default defineConfig({
	plugins: [honey({ app: "src/app.ts" })],
})
```

What it generates is `codegen`, and each output takes a path or a config of its own:

```ts
import { honey } from "@lovrozagar/honey/plugin"

export default {
	plugins: [
		honey({
			app: "src/app.ts",
			codegen: {
				manifest: true,
				mcp: true,
				openApi: { title: "Shop", version: "1.0.0", securitySchemes: {} },
				tree: true,
				types: { baseCtxName: "AppCtx" },
			},
			watch: ["src/**/*.ts"],
		}),
	],
}
```

`@lovrozagar/honey/build` adds the production bundle for a deploy target, so `vite build` emits one file to run:

```ts
import { createBuildPlugin } from "@lovrozagar/honey/build"
import { defineConfig } from "vite"

export default defineConfig({
	plugins: [createBuildPlugin({ target: "cloudflare", minify: true }, { entry: "src/app.ts", export: "app" })],
})
```

The `honey` CLI does the same generation without Vite, which is what a CI step or a `package.json` script wants:

```sh
honey generate                       # reads vite.config.* and the honey() plugin in it
honey generate --app src/app.ts --tree --types --manifest
honey generate --config vite.config.ts --plugin 0 --watch
honey generate --merge-tree src/_gen/routes.gen.ts   # a gateway's merged tree
honey init --cf --force
```

| Flag                  | What it does                                                               |
| --------------------- | -------------------------------------------------------------------------- |
| `--config <path>`     | the Vite config holding `honey()` (default: `vite.config.{ts,mts,js,mjs}`) |
| `--plugin <n>`        | which `honey()` plugin in the config, 0-based                              |
| `--app <path>`        | the app entry; overrides the config's app, or replaces the config          |
| `--tree`              | the route tree module                                                      |
| `--types`             | the ambient types                                                          |
| `--manifest`          | the route manifest                                                         |
| `--merge-tree <path>` | the route tree source of a gateway                                         |
| `--watch`             | generate again when files next to the app change                           |

The SDKs, the CLI and the MCP server are honey-clients's: `honey-clients generate --app <path>`.

Full reference: [the build plugin](https://github.com/lovrozagar/honey/blob/main/docs/plugin.md).

## Generated clients

`honey-clients` reads the app module or the document and writes clients that know the routes:

```sh
npx honey-clients generate --app src/app.ts --target ts --target python --out generated
```

A call answers your value and throws a typed error by status; its `client.safe` mirror answers the same calls as a
`Result` instead, so a failure is a value rather than a throw. All six SDKs have both styles.

```ts sdk
import { DecodeError, Kitchen, NotFoundError } from "./kitchen"

export function newClient(): Kitchen {
	return new Kitchen({
		baseURL: "https://api.example.com",
		headers: { authorization: `Bearer ${process.env.KITCHEN_TOKEN ?? ""}` },
		timeout: 10_000,
	})
}

export async function organization(client: Kitchen, orgId: string): Promise<string | null> {
	try {
		await client.getApiV1OrganizationsByOrgId({ params: { orgId } })
		return orgId
	} catch (error) {
		if (error instanceof NotFoundError) return null
		throw error
	}
}

export async function health(client: Kitchen): Promise<string> {
	const result = await client.safe.getApiHealth()
	if (result.ok) return "up"
	if (result.error instanceof DecodeError) return `unreadable answer: ${result.error.message}`
	return `answered ${result.error.status}`
}
```

That block is a verbatim slice of
[the compiled example](https://github.com/lovrozagar/honey/blob/main/docs/examples/ts/example.ts): the tests
type-check it against an SDK generated from a real document, so it cannot drift from what the generator writes.

Full reference: [code generation](https://github.com/lovrozagar/honey/blob/main/docs/codegen.md),
[the generated clients](https://github.com/lovrozagar/honey/blob/main/docs/client.md),
[their per-language recipes](https://github.com/lovrozagar/honey/blob/main/docs/sdk-recipes.md),
[the generated CLI](https://github.com/lovrozagar/honey/blob/main/docs/cli.md) and
[releasing it](https://github.com/lovrozagar/honey/blob/main/docs/cli-release.md).

## Every export

Each feature is a subpath: import what the app uses, and a bundle carries nothing else. An app that never imports
`@lovrozagar/honey/ws` bundles no WebSocket code, and one that never imports `@lovrozagar/honey/openapi` no document
generator.

| Export                              | What it holds                                                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@lovrozagar/honey`                 | `honey`, `HoneyError`, `defineErrors`, `createMiddleware`, `defineMiddleware`, `mergeTree`, `detectRuntime`, and the type helpers below |
| `@lovrozagar/honey/serve`           | `serve(app, options)`: Node or Bun, whichever runs it                                                                                   |
| `@lovrozagar/honey/node`            | `serve` for `node:http` directly                                                                                                        |
| `@lovrozagar/honey/ws`              | `ws(app, path)`, a WebSocket route                                                                                                      |
| `@lovrozagar/honey/ws/bun`          | `bunWebSocket`                                                                                                                          |
| `@lovrozagar/honey/ws/node`         | `nodeWebSocket` (with the optional `ws` peer)                                                                                           |
| `@lovrozagar/honey/ws/cloudflare`   | `cfWebSocket`                                                                                                                           |
| `@lovrozagar/honey/ws/session`      | `createWsSession`: the session runtime a custom WebSocket adapter builds on                                                             |
| `@lovrozagar/honey/realtime`        | `realtime(app, path, options)`: a resumable connection over WebSocket, SSE and long-poll                                                |
| `@lovrozagar/honey/mcp`             | `mcp(app, path, handler, options?)`: the app's tools over MCP's Streamable HTTP, the handler `codegen.mcp` writes                       |
| `@lovrozagar/honey/mcp/oauth`       | `oauth(options)`: `mcp()`'s opt-in OAuth 2.1 resource server (RFC 9728 metadata, Bearer challenges)                                     |
| `@lovrozagar/honey/mcp/uploads`     | `uploads(options)`, `memoryUploadStore()`: `mcp()`'s opt-in out-of-band file uploads (the file-uploads extension's flow)                |
| `@lovrozagar/honey/mcp/url-files`   | `urlFiles(options)`: `mcp()`'s opt-in file arguments as https URLs from listed hosts                                                    |
| `@lovrozagar/honey/openapi`         | `serveOpenApi`, `serveManifest`, `generateOpenApi`, `generateManifest`, `toYaml`                                                        |
| `@lovrozagar/honey/openapi/scalar`  | `scalar`, the Scalar API reference page                                                                                                 |
| `@lovrozagar/honey/openapi/swagger` | `swagger`, the Swagger UI page                                                                                                          |
| `@lovrozagar/honey/errors`          | `defineErrors` (also on the root)                                                                                                       |
| `@lovrozagar/honey/i18n`            | `errorI18n`, `translateError`, `interpolate`, `createInterpolator`                                                                      |
| `@lovrozagar/honey/input`           | `readableStream()`, a streamed request body as input                                                                                    |
| `@lovrozagar/honey/range`           | `rangeResponse`, a `Range` request answered from bytes                                                                                  |
| `@lovrozagar/honey/cache-control`   | `cacheControl`, `httpDate`                                                                                                              |
| `@lovrozagar/honey/compress`        | `compress`                                                                                                                              |
| `@lovrozagar/honey/etag`            | `etag`, `notModified`                                                                                                                   |
| `@lovrozagar/honey/rate-limit`      | `rateLimit`, `memoryStore`                                                                                                              |
| `@lovrozagar/honey/cors`            | `cors`                                                                                                                                  |
| `@lovrozagar/honey/csrf`            | `csrf`                                                                                                                                  |
| `@lovrozagar/honey/body-limit`      | `bodyLimit`                                                                                                                             |
| `@lovrozagar/honey/timeout`         | `timeout`                                                                                                                               |
| `@lovrozagar/honey/ip-restrict`     | `ipRestrict`                                                                                                                            |
| `@lovrozagar/honey/request-id`      | `requestId`                                                                                                                             |
| `@lovrozagar/honey/secure-headers`  | `secureHeaders`                                                                                                                         |
| `@lovrozagar/honey/server-timing`   | `serverTiming`                                                                                                                          |
| `@lovrozagar/honey/powered-by`      | `poweredBy`                                                                                                                             |
| `@lovrozagar/honey/pretty-json`     | `prettyJson`                                                                                                                            |
| `@lovrozagar/honey/logger`          | `createLogger`                                                                                                                          |
| `@lovrozagar/honey/curl-logger`     | `curlLogger`, a request logged as a command that repeats it                                                                             |
| `@lovrozagar/honey/telemetry/otel`  | `otelAdapter`                                                                                                                           |
| `@lovrozagar/honey/static`          | `staticFiles`                                                                                                                           |
| `@lovrozagar/honey/proxy`           | `proxy`, a route that forwards to an upstream                                                                                           |
| `@lovrozagar/honey/accepts`         | `accepts`, content negotiation                                                                                                          |
| `@lovrozagar/honey/cookie`          | `serializeCookie`, `parseCookieHeader`                                                                                                  |
| `@lovrozagar/honey/cookie-sign`     | `sign`, `verify`, `createCookieSigner`                                                                                                  |
| `@lovrozagar/honey/crypto`          | `timingSafeEqual`                                                                                                                       |
| `@lovrozagar/honey/request-to-curl` | `requestToCurl`                                                                                                                         |
| `@lovrozagar/honey/testing`         | `testClient`, an app called in process or over `serve`                                                                                  |
| `@lovrozagar/honey/tree`            | the route tree's types and helpers                                                                                                      |
| `@lovrozagar/honey/plugin`          | `honey()`, the Vite plugin that generates the app's artifacts                                                                           |
| `@lovrozagar/honey/build`           | `createBuildPlugin`, a production bundle for a deploy target                                                                            |

The root export's values: `honey()` and the `Honey` class behind it, `HoneyContext` and `HoneyRes` (the handler's
`ctx` and its `ctx.res`), `HoneyError`, `defineErrors` and `ERROR_META`, `createErrorResponse`, `createMiddleware`
and `defineMiddleware`, `mergeTree`, `detectRuntime` and `toFetchRequest`.

## Type helpers

Exported from `@lovrozagar/honey`, each over the app you built (`typeof app`). This is how a test, a client or a
helper of yours stays tied to the routes rather than to a copy of their shapes.

```ts
import { honey, type InferRouteInput, type InferRoutePaths, type InferRoutes } from "@lovrozagar/honey"
import * as z from "zod"

const app = honey()
	.get("/books/:id")
	.input({ params: z.object({ id: z.string() }) })
	.handler((ctx) => ctx.res.json("ok", { id: ctx.input.params.id }))

type Paths = InferRoutePaths<typeof app>
type Routes = InferRoutes<typeof app>
type BookInput = InferRouteInput<typeof app, "/books/:id", "get">

const path: Paths = "/books/:id"
declare const input: BookInput
const id: string = input.params.id
```

| Type                                         | What it describes                                                |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `InferRoutes<typeof app>`                    | every path, its methods, and each one's input, output and errors |
| `InferRoutePaths<typeof app>`                | the paths, as a union                                            |
| `InferRouteMethods<typeof app, Path>`        | one path's methods                                               |
| `InferRouteInput<typeof app, Path, Method>`  | a route's validated input                                        |
| `InferRouteOutput<typeof app, Path, Method>` | a route's output map                                             |
| `InferRouteErrors<typeof app, Path, Method>` | a route's declared error keys                                    |
| `InferRouteMeta<typeof app, Path, Method>`   | a route's meta                                                   |
| `InferRouteCtx<typeof app, Path, Method>`    | a route's handler `ctx`                                          |
| `InferCtx<typeof app>`                       | the app's handler context                                        |
| `InferEnv<typeof app>`                       | `ctx.env`                                                        |
| `InferMeta<typeof app>`                      | the app-level meta                                               |
| `InferErrorFactory<typeof app>`              | the error factory                                                |
| `InferBasePath<typeof app>`                  | the base path, as a string                                       |
| `InferMethods<typeof app>`                   | the methods the app serves                                       |

## Documentation

Every page's examples are compiled by the repository's tests.

- [All the docs](https://github.com/lovrozagar/honey/blob/main/docs/README.md)
- [Migrating from 0.7](https://github.com/lovrozagar/honey/blob/main/docs/migration.md)
- [Package exports](https://github.com/lovrozagar/honey/blob/main/docs/packages.md)
- [What a tarball ships, and why](https://github.com/lovrozagar/honey/blob/main/packages/core/docs/packaging.md)
- [The repository](https://github.com/lovrozagar/honey)

## License

MIT
