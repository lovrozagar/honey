# The app

`honey()` builds an app: a Fetch handler with its routes, middleware and settings. Settings chain on the
app (`.basePath()`, `.context()`, `.use()`, `.onError()`), and every route registered below a handle carries what
the handle added. The app is a plain `fetch(request, env, ctx)` function, so any runtime that speaks Fetch runs it:
`serve(app)` from `@lovrozagar/honey/node` on Node or `@lovrozagar/honey/bun` on Bun, or the app itself as a
Cloudflare Worker.

`telemetry` and `otelAdapter` observe each request: `onRequest`, `onResponse` and `onError` fire once each, and with
OpenTelemetry the spans nest (`http.request`, then each middleware, then the handler).

## Example

```ts
import { honey } from "@lovrozagar/honey"

type Env = { GREETING: string }

const app = honey<Env>().basePath("/api").context({ startedAt: Date.now() })

app.get("/hello").handler((ctx) => ctx.res.json("ok", { greeting: ctx.env.GREETING, since: ctx.startedAt }))

export default app
```

## Presets

Several apps that share their settings write them once as a preset: `definePreset<TEnv>()` takes every setter an app
does, and `use(mw)` for chain middleware, each typed as on an app. `honey(preset)` starts an app from it, with the
same types the chain on `honey()` would give: the meta type, the error factory and its default keys, and what the
middleware adds to `ctx`. Each app copies the preset, so a setter on one app, or on the preset later, changes no other.

```ts
import { defineErrors, definePreset, honey } from "@lovrozagar/honey"
import { createErrorTranslator } from "@lovrozagar/honey/i18n"
import { createLogger } from "@lovrozagar/honey/logger"
import { requestId } from "@lovrozagar/honey/request-id"

type Env = { REGION: string }
type RouteMeta = { team?: string; worker?: "billing" | "search" }

const errors = defineErrors({ internal_server_error: "internal_server_error" })

export const platform = definePreset<Env>()
	.metaType<RouteMeta>()
	.metaSpec({ meta: { team: "x-team", worker: "x-worker" } })
	.logger(createLogger({ base: { service: "platform" } }))
	.errorFactory(errors)
	.errorI18n(
		createErrorTranslator({ errors: { en: { internal_server_error: "Something broke" } }, resolveLocale: () => "en" }),
	)
	.defaultBoundary("internal_server_error")
	.requestLog(true)
	.use(requestId())

const app = honey(platform).meta({ worker: "billing" })

app.get("/whoami").handler((ctx) => ctx.res.json("ok", { id: ctx.requestId, worker: ctx.meta.worker }))
```

## Reference

| Value                       | Default                  | What it does                                                                                                                            | Watch for                                                                                                           |
| --------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `honey<TEnv>()`             | —                        | a fresh app typed to `TEnv`                                                                                                             | `TEnv` is the runtime env (Workers bindings); it is not request data                                                |
| `definePreset<TEnv>()`      | —                        | settings and chain middleware an app starts from, set with the app's own setters and `use(mw)`                                          | a preset serves nothing: routes, `basePath()` and `context()` belong on the app                                     |
| `honey(preset)`             | —                        | a fresh app with its own copy of the preset's settings and middleware, typed as the same chain on `honey()`                             | the copy is taken at the call: setters on the preset afterwards reach apps started later, not this one              |
| `.basePath(prefix)`         | `/`                      | rebases every route and the OpenAPI path under `prefix`                                                                                 | patterns are rebased at `.use` time; registering before `basePath` is a different path                              |
| `.context(values)`          | none                     | static values every route registered through the new handle finds on `ctx`, typed into the handler                                      | values are fixed at registration; per-request data belongs in middleware (`next({ … })`); a reserved ctx key throws |
| `.use(mw)`                  | —                        | installs middleware on this handle and its descendants                                                                                  | a `use()` that never registers a route is reported at finalize                                                      |
| `.onError(handler)`         | native projector         | maps a thrown value to a response before error telemetry                                                                                | a throw inside `onError` is logged and falls back to the native projector                                           |
| `telemetry` adapter         | none                     | `onRequest` (once), `onResponse`/`onError` (once each), `onMiddleware` durations                                                        | `onRequest` fires once; every exit pairs with exactly one response/error                                            |
| `otelAdapter({ tracer })`   | none                     | OpenTelemetry spans — v1 nests them (`http.request` root → `middleware.*` → `http.handler`) and continues an incoming W3C `traceparent` | a flat-root trace or a dropped `traceparent` breaks distributed tracing — v1 fixes both                             |
| log↔trace correlation       | on when telemetry active | `requestId` → span attr `honey.request_id`; logger child binds `trace_id`+`span_id`; ids stay distinct (not collapsed)                  | with telemetry off, `requestId`+logger behave as today; trace id is never used as the client-facing id              |
| `.fetch(request, env, ctx)` | —                        | the Fetch handler an adapter calls                                                                                                      | finalize compiles once; registering after first `fetch` re-finalizes                                                |
