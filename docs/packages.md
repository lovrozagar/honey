# Package exports

Each feature is a subpath: import what an app uses, and a bundle carries nothing else. An app that never imports
`@lovrozagar/honey/ws` bundles no WebSocket code, and one that never imports `@lovrozagar/honey/openapi` no document
generator.

## @lovrozagar/honey

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
| `@lovrozagar/honey/openapi`         | `serveOpenApi`, `serveManifest`, `generateOpenApi`, `generateManifest`, `toYaml`                                                        |
| `@lovrozagar/honey/openapi/scalar`  | `scalar`, the Scalar API reference page                                                                                                 |
| `@lovrozagar/honey/openapi/swagger` | `swagger`, the Swagger UI page                                                                                                          |
| `@lovrozagar/honey/errors`          | `defineErrors` (also on the root)                                                                                                       |
| `@lovrozagar/honey/i18n`            | `errorI18n`, `translateError`                                                                                                           |
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
| `@lovrozagar/honey/curl-logger`     | `curlLogger`, a request logged as a `curl` command                                                                                      |
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

## @lovrozagar/honey-codegen

| Export                          | What it holds                                        |
| ------------------------------- | ---------------------------------------------------- |
| `@lovrozagar/honey-codegen`     | `generateRouteTree`, `generateTypes`, `extractTypes` |
| `@lovrozagar/honey-codegen/cli` | the `honey-codegen` command's `main`                 |

The SDK, CLI and MCP generators run through `honey-codegen generate` ([code generation](codegen.md)).

## Utilities

```ts
import { accepts } from "@lovrozagar/honey/accepts"
import { serializeCookie } from "@lovrozagar/honey/cookie"
import { sign, verify } from "@lovrozagar/honey/cookie-sign"
import { timingSafeEqual } from "@lovrozagar/honey/crypto"
import { requestToCurl } from "@lovrozagar/honey/request-to-curl"

declare const req: Request
declare const SECRET: string
declare const OLD_SECRET: string

/* the best match the request accepts, or null */
const type = accepts(req, ["application/json", "text/html"])

const cookie = serializeCookie("theme", { value: "dark", httpOnly: true, path: "/", sameSite: "lax" })

/* a signature bound to the cookie's name; verify takes every secret still accepted, newest first */
const signed = await sign("abc", SECRET, { name: "sid" })
const value = await verify(signed, [SECRET, OLD_SECRET], { name: "sid" })

const same = await timingSafeEqual("token-a", "token-b")

/* the authorization header left out of the logged command */
const curl = await requestToCurl(req, { excludeHeader: (name) => name === "authorization" })
```

## Type helpers

Exported from `@lovrozagar/honey`, each over the app you built (`typeof app`):

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
