# dx — app settings

`honey<TEnv>()` returns an app. Settings are applied through the chain; each handle derived with `use()` / `basePath()` / `context()` shares the app's settings graph.

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| `honey<TEnv>()` | yes | — | a fresh app typed to `TEnv` | `TEnv` is the runtime env (Workers bindings); it is not request data | `routing/app.test.ts` |
| `.basePath(prefix)` | no | `/` | rebases every route and the OpenAPI path under `prefix` | patterns are rebased at `.use` time; registering before `basePath` is a different path | `routing/request-path.test.ts`, `integration/routing.test.ts` |
| `.context(values)` | no | none | static values every route registered through the new handle finds on `ctx`, typed into the handler | values are fixed at registration; per-request data belongs in middleware (`next({ … })`); a reserved ctx key throws | `context/context.test.ts` |
| `.use(mw)` | no | — | installs middleware on this handle and its descendants | a `use()` that never registers a route is reported at finalize | `middleware/middleware.test.ts`, `integration/middleware.test.ts` |
| `.onError(handler)` | no | native projector | maps a thrown value to a response before error telemetry | a throw inside `onError` is logged and falls back to the native projector | `errors/on-error.test.ts`, `integration/errors.test.ts` |
| `telemetry` adapter | no | none | `onRequest` (once), `onResponse`/`onError` (once each), `onMiddleware` durations | `onRequest` fires once; every exit pairs with exactly one response/error | `telemetry/otel.test.ts` |
| `otelAdapter({ tracer })` | no | none | OpenTelemetry spans — v1 nests them (`http.request` root → `middleware.*` → `http.handler`) and continues an incoming W3C `traceparent` (G1) | a flat-root trace or a dropped `traceparent` breaks distributed tracing — v1 fixes both | `telemetry/otel.test.ts`, `telemetry/traceparent.test.ts` |
| log↔trace correlation | — | on when telemetry active | `requestId` → span attr `honey.request_id`; logger child binds `trace_id`+`span_id`; ids stay distinct (not collapsed) | with telemetry off, `requestId`+logger behave as today; trace id is never used as the client-facing id | `telemetry/correlation.test.ts` |
| `.fetch(request, env, ctx)` | yes (entry) | — | the Fetch handler an adapter calls | finalize compiles once; registering after first `fetch` re-finalizes | `routing/dispatch.test.ts` |

Deno is not a target (H15). Runtime is node / bun / cf, resolved by `detectRuntime` and the adapters.
