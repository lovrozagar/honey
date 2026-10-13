# dx — observability

A honey server reports what it does: every server-side line goes through a pluggable pino-compatible logger with a per-request child; every server error reaches an `onError` hook that never delays the response; an optional request log records each request; every request carries a validated request id; and optional OpenTelemetry-compatible tracing produces one nested trace per request with no tracing dependency in core. Nothing is swallowed silently, nothing private is logged, and with nothing configured the per-request cost stays within the perf budget. Modeled on flare's observability (bit 16), scoped to an API framework — no browser, so no dev log bridge; honey adds gateway/proxy propagation and SSE/WS span lifecycle.

## Values

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| `logger` | no | pino-pretty debug (dev) / json info (prod) | the sink for every server line; a per-request child binds `requestId`, `method`, `path` (no query), route id | `logger: false` makes `ctx.log` a no-op that never throws | `telemetry/logger.test.ts` |
| `createLogger({ level, format })` | no | — | build the default sink at another level; `level: "silent"` = no-ops | there is no `logLevel` option on the app (H17) | `telemetry/logger.test.ts` |
| default levels | — | `debug` dev / `info` prod | — | not configurable via a `logLevel` knob | `telemetry/logger.test.ts` |
| `app.onError(fn)` | no | native projector | **response-shaping**, awaited: returns `HoneyError`/`Response` to map the response (status + headers + i18n), or `undefined` to fall through to the projector | it is not a background reporter — that is `telemetry.onError`; a throw inside logs once and falls back (no recursion); named statuses (4xx/redirect) do not call it | `errors/on-error.test.ts` |
| `telemetry.onError` | no | none | fire-and-forget error reporting; **never delays the response** | distinct from `app.onError`; use this for background reporting, `app.onError` for mapping | `telemetry/otel.test.ts` |
| `requestLog` | no | **off** | one `info` line per request after the body ends: `method`, `path` (no query), `status`, `durationMs`, `routeId`, `kind`, `cache`, `bytes?`, `requestId`, `runtime`; `requestLog: { skip(entry) }` | `requestLog: true` with `logger: false` throws at startup naming both; a client disconnect logs `status: aborted` | `telemetry/request-log.test.ts` |
| `requestId()` | no | `x-request-id`, `crypto.randomUUID()` | validated id on `ctx`, echoed on the response (errors and mounts too) | an inbound id is reused **only** when `trustProxy ≥ 1` and it matches `^[\w.:+/=-]{1,128}$`; otherwise generated; with a tracer the id is the trace id | `middleware/request-id.test.ts` |
| production error log | — | full detail | the operator's (private) log line holds digest + error name + message + **stack** | the client still receives only a generic message + digest — the stack is never forwarded | `errors/on-error.test.ts` |

## Tracing (`otelAdapter({ tracer })`, subpath export)

Structural `Tracer` — core imports no tracing package. The OTel mapping lives at the `./telemetry/otel` subpath with `@opentelemetry/api` an optional peer; importing it without that package throws at import with an install hint.

Interface: `startSpan(name, attributes, parent?) → { setAttribute, setStatus, recordException, end }`, optional `run(span, fn)`.

| rule | outcome | test |
| --- | --- | --- |
| nested tree | `http.request` (root: `http.request.method`, `url.path`, `http.route`=route id, `http.response.status_code`, `honey.cache`) → children `middleware.<name>`, `http.handler`, `http.proxy` (gateway upstream), `http.error` | `telemetry/otel.test.ts` |
| explicit parenting | the parent is passed explicitly, never via an async context manager (Workers has none, Bun partial); `run(span, fn)` sets OTel's active context only so app instrumentation nests under honey's spans | `telemetry/otel.test.ts` |
| traceparent, trust-gated | `trustProxy ≥ 1` + valid W3C `traceparent` → **continue** the trace; untrusted → **link, never continue**, and the request id is the trace id so a client can never pick your request id; no tracer → `traceparent` does not set the request id | `telemetry/traceparent.test.ts` |
| outbound propagation | `proxy`/gateway forwards `traceparent` for the current span | `telemetry/traceparent.test.ts` |
| span lifecycle | the root ends when the body finishes or is cancelled (not at headers); a disconnect ends it with `status: aborted` | `telemetry/span-lifecycle.test.ts` |
| zero cost off | no tracer ⇒ no span object is created (a counting factory sees zero); a non-recording/sampled-out span builds no attributes | `telemetry/otel.test.ts` |
| correlation | `requestId` → span attr `honey.request_id`; logger child binds `trace_id`+`span_id`; ids stay distinct | `telemetry/correlation.test.ts` |

## Privacy (enforced by tests)

No cookie, `Authorization`, `Set-Cookie`, query string, request body, or handler input appears in any log field or span attribute. Paths are logged without the query. Route ids, not raw paths, name spans. A grep of every log/span call site for `cookie`/`authorization`/`query`/`body` finds nothing that carries them.

## Consumer-pinned cases (anyrow)

The oracle must include, because real consumers depend on them and honey's own suite may not:
- **response-returning `app.onError`** — a handler that returns a `HoneyError` with a status and a header (e.g. `Retry-After`) maps the response exactly, and the error-key's i18n is applied on the default response path; returning `undefined` falls through to the projector. (anyrow `createDbErrorHandler`.) `errors/on-error.test.ts`.
- **`trustProxy`-off requestId** — with no `trustProxy`, an inbound `x-request-id` is **not** reused (a fresh id is generated); with `trustProxy ≥ 1` a safe inbound id is reused. (anyrow gateway→service propagation.) `middleware/request-id.test.ts`.

## Configuration matrix (the proof)

Every combination of `logger` (default / custom / off) × `onError` (absent / present) × `requestLog` (off / on) × `tracer` (absent / present) × `trustProxy` (0 / ≥1), in dev and prod — 96 in-process cases. Each serves a request, a handler error, a streamed/SSE response, and a gateway/proxy hop, and asserts: status + body identical to an unconfigured server; nothing throws; `x-request-id` present and safe; each line lands exactly where this contract says; `onError` fires exactly once per error; the span set matches; nothing private leaks. `telemetry/observability-matrix.test.ts`.

## Cost

Unconfigured observability stays within 2% of the pre-observability baseline (the default logger checks the level before building fields; no span object exists without a tracer). `telemetry/bench-observe` + the perf gate.
