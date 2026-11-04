# Package exports

Each feature is a subpath: import what an app uses, and a bundle carries nothing else. An app that never imports
`@lovrozagar/honey/ws` bundles no WebSocket code, and one that never imports `@lovrozagar/honey/openapi` no document
generator.

## @lovrozagar/honey

| Export                              | What it holds                                                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@lovrozagar/honey`                 | `honey`, `HoneyError`, `defineErrors`, `createMiddleware`, `mergeTree`, and the type helpers below                                                  |
| `@lovrozagar/honey/node`            | `serve(app, options)` on Node's `node:http`                                                                                                         |
| `@lovrozagar/honey/bun`             | `serve(app, options)` on `Bun.serve`                                                                                                                |
| `@lovrozagar/honey/ws`              | `ws(app, path)`, a WebSocket route                                                                                                                  |
| `@lovrozagar/honey/ws/bun`          | `bunWebSocket`                                                                                                                                      |
| `@lovrozagar/honey/ws/node`         | `nodeWebSocket` (with the optional `ws` peer)                                                                                                       |
| `@lovrozagar/honey/webhook`         | `webhookContract`, `signWebhook`, `SignedWebhook`, `WebhookContract`, `WebhookEvents`, `WebhookSignOptions`, `SignWebhookOptions`, `WebhookHeaders` |
| `@lovrozagar/honey/cron`            | `defineCron`, `CronConfig`, `CronDefinition`, `CronHandler`, `CronJob`, `CronSchedule`                                                              |
| `@lovrozagar/honey/cron/serve`      | `serveCron`, `ServeCronOptions`, `CronHandle`, `CronFailure`                                                                                        |
| `@lovrozagar/honey/cron/workers`    | `workersCron`, `WorkersScheduledController`                                                                                                         |
| `@lovrozagar/honey/queue`           | `queueContract`, `queueMessage`, `defineConsumer`, `deadLetter`, `QueueBodyError`, `QueueDeadLetter`, and their types                               |
| `@lovrozagar/honey/queue/serve`     | `serveQueue`, `memoryQueueStore`, `QueueStore`, `ServeQueueOptions`, `QueueHandle`, `QueueFailure` and the store's types                            |
| `@lovrozagar/honey/queue/workers`   | `workersQueue`, `WorkersQueueOptions` and the binding's types                                                                                       |
| `@lovrozagar/honey/user-agent`      | `parseUserAgent`, `ParsedUserAgent`, `DeviceType`                                                                                                   |
| `@lovrozagar/honey/ws/workers`      | `workersWebSocket`                                                                                                                                  |
| `@lovrozagar/honey/ws/session`      | `createWsSession`: the session runtime a custom WebSocket adapter builds on                                                                         |
| `@lovrozagar/honey/realtime`        | `realtime(app, path, options)`: a resumable connection over WebSocket, SSE and long-poll                                                            |
| `@lovrozagar/honey/mcp`             | `mcp(app, path, handler, options?)`: the app's tools over MCP's Streamable HTTP, the handler `codegen.mcp` writes                                   |
| `@lovrozagar/honey/mcp/oauth`       | `oauth(options)`: `mcp()`'s opt-in OAuth 2.1 resource server (RFC 9728 metadata, Bearer challenges)                                                 |
| `@lovrozagar/honey/mcp/uploads`     | `uploads(options)`, `memoryUploadStore()`: `mcp()`'s opt-in out-of-band file uploads (the file-uploads extension's flow)                            |
| `@lovrozagar/honey/mcp/url-files`   | `urlFiles(options)`: `mcp()`'s opt-in file arguments as https URLs from listed hosts                                                                |
| `@lovrozagar/honey/openapi`         | `serveOpenApi`, `serveManifest`, `generateOpenApi`, `generateManifest`, `toYaml`                                                                    |
| `@lovrozagar/honey/openapi/auth`    | `basic`, `credentialsMatch`: HTTP Basic in front of a served document and its docs pages                                                            |
| `@lovrozagar/honey/openapi/scalar`  | `scalar`, the Scalar API reference page                                                                                                             |
| `@lovrozagar/honey/openapi/static`  | `serveStaticOpenApi`: a document built ahead of time or living elsewhere, served without the generator                                              |
| `@lovrozagar/honey/openapi/swagger` | `swagger`, the Swagger UI page                                                                                                                      |
| `@lovrozagar/honey/errors`          | `defineErrors` (also on the root)                                                                                                                   |
| `@lovrozagar/honey/i18n`            | `errorI18n`, `translateError`                                                                                                                       |
| `@lovrozagar/honey/input`           | `readableStream()`, a streamed request body as input                                                                                                |
| `@lovrozagar/honey/range`           | `rangeResponse`, a `Range` request answered from bytes                                                                                              |
| `@lovrozagar/honey/cache-control`   | `cacheControl`, `httpDate`                                                                                                                          |
| `@lovrozagar/honey/compress`        | `compress`                                                                                                                                          |
| `@lovrozagar/honey/etag`            | `etag`, `notModified`                                                                                                                               |
| `@lovrozagar/honey/rate-limit`      | `rateLimit`, `memoryStore`                                                                                                                          |
| `@lovrozagar/honey/cors`            | `cors`                                                                                                                                              |
| `@lovrozagar/honey/csrf`            | `csrf`                                                                                                                                              |
| `@lovrozagar/honey/body-limit`      | `bodyLimit`                                                                                                                                         |
| `@lovrozagar/honey/timeout`         | `timeout`                                                                                                                                           |
| `@lovrozagar/honey/jwt`             | `signJwt`, `verifyJwt`, `remoteJwks`, `decodeJwtPayload`, `importPkcs8`, `isJwsAlgorithm`                                                           |
| `@lovrozagar/honey/ip-restrict`     | `ipRestrict`, `ipAllowed`, `isIpRule`                                                                                                               |
| `@lovrozagar/honey/request-id`      | `requestId`                                                                                                                                         |
| `@lovrozagar/honey/secure-headers`  | `secureHeaders`                                                                                                                                     |
| `@lovrozagar/honey/server-timing`   | `serverTiming`                                                                                                                                      |
| `@lovrozagar/honey/powered-by`      | `poweredBy`                                                                                                                                         |
| `@lovrozagar/honey/pretty-json`     | `prettyJson`                                                                                                                                        |
| `@lovrozagar/honey/logger`          | `createLogger`                                                                                                                                      |
| `@lovrozagar/honey/curl-logger`     | `curlLogger`, a request logged as a `curl` command                                                                                                  |
| `@lovrozagar/honey/telemetry/otel`  | `otelAdapter`                                                                                                                                       |
| `@lovrozagar/honey/static`          | `staticFiles`                                                                                                                                       |
| `@lovrozagar/honey/proxy`           | `proxy`, a route that forwards to an upstream                                                                                                       |
| `@lovrozagar/honey/accepts`         | `accepts`, content negotiation                                                                                                                      |
| `@lovrozagar/honey/cookie`          | `serializeCookie`, `parseCookieHeader`                                                                                                              |
| `@lovrozagar/honey/cookie-sign`     | `createCookieSigner`                                                                                                                                |
| `@lovrozagar/honey/crypto`          | `timingSafeEqual`                                                                                                                                   |
| `@lovrozagar/honey/request-to-curl` | `requestToCurl`                                                                                                                                     |
| `@lovrozagar/honey/testing`         | `testClient`, an app called in process or over a runtime's `serve`                                                                                  |
| `@lovrozagar/honey/tree`            | the route tree's types and helpers                                                                                                                  |
| `@lovrozagar/honey/plugin`          | `honey()`, the Vite plugin that generates the app's artifacts                                                                                       |
| `@lovrozagar/honey/build`           | `createBuildPlugin`, a production bundle for a deploy target                                                                                        |

## @lovrozagar/honey-clients

| Export                          | What it holds                                        |
| ------------------------------- | ---------------------------------------------------- |
| `@lovrozagar/honey-clients`     | `generateRouteTree`, `generateTypes`, `extractTypes` |
| `@lovrozagar/honey-clients/cli` | the `honey-clients` command's `main`                 |

The SDK, CLI and MCP generators run through `honey-clients generate` ([code generation](codegen.md)).

## Utilities

```ts
import { accepts } from "@lovrozagar/honey/accepts"
import { serializeCookie } from "@lovrozagar/honey/cookie"
import { createCookieSigner } from "@lovrozagar/honey/cookie-sign"
import { timingSafeEqual } from "@lovrozagar/honey/crypto"
import { requestToCurl } from "@lovrozagar/honey/request-to-curl"

declare const req: Request
declare const SECRET: string
declare const OLD_SECRET: string

/* the best match the request accepts, or null */
const type = accepts(req, ["application/json", "text/html"])

const cookie = serializeCookie("theme", { value: "dark", httpOnly: true, path: "/", sameSite: "lax" })

/* one signer per cookie, its name bound into each signature; every secret still accepted, newest first */
const sid = createCookieSigner({ name: "sid", secrets: [SECRET, OLD_SECRET] })
const value = await sid.verify(await sid.sign("abc"))

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
