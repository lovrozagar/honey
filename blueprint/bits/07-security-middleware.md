# Bit 07 — security + edge middleware

Closes: A5 (rate-limit) · A6 (compress) · F1 (adversarial gate per middleware) · G1 (telemetry nesting + traceparent) · H17 (observability surface)
Oracle kept green: `tests/integration/cors.test.ts`, `tests/integration/proxy.test.ts`, `tests/integration/static.test.ts`, hostile-client suite.

## Scope
The composable edge middlewares: cors, secure-headers, csrf, request-id, timeout, server-timing, powered-by, ip-restrict, plus the two new ones — `rateLimit` (A5) and `compress` (A6). Also proxy/gateway, static files (with range from bit 05), i18n, crypto, observability (curl-logger, request-to-curl, logger). Each middleware carries an adversarial case (F1).

## Files (from files.tsv — `middleware`, `proxy`, `response/static`, `i18n`, `security`, `observability`)
- `src/middleware/{cors,secure-headers,csrf,request-id,timeout,server-timing,powered-by,ip-restrict}.ts` (+test each).
- `src/middleware/rate-limit.ts` (+test) — pluggable store; the **memory default is bounded (LRU/TTL + max-entries)** so a key-spray can't OOM it (H18.8); `Retry-After` + `X-RateLimit-*` (A5).
- `src/middleware/compress.ts` (+test) — Accept-Encoding negotiation; skip encoded/streamed; **default-exclude cookie-setting / auth-secret-bearing responses (BREACH/CRIME)** (H18.7), or length-mask (A6).
- `src/proxy/proxy.ts` (+test, split from v0 370), `src/response/static.ts` (+test), `src/i18n/*` (+test), `src/security/crypto.ts` (+test), `src/observability/{curl-logger,request-to-curl,logger}.ts` (+test each).
- `src/telemetry/otel.ts` (+test) — the `otelAdapter`; v1 nests spans and continues W3C `traceparent` (G1); `src/telemetry/traceparent.ts` (+test) — parse/validate/emit `traceparent` + `tracestate`.
- observability (H17, contract = `dx/observability.md`): `src/telemetry/logger.ts` (+test, `createLogger`, levels, child, pino shape, json/pretty, defaults), `src/telemetry/request-log.ts` (+test, off by default, field catalog, skip, aborted), `src/errors/on-error.ts` (+test, the **awaited response-shaping** `app.onError` — returns HoneyError/Response/undefined), `src/telemetry/fields.ts` (+test, the privacy-safe field catalog), `src/telemetry/span-lifecycle.ts` (+test, body-end/aborted). The **background `telemetry.onError` reporter** (fire-and-forget, never delays) is the telemetry adapter callback invoked from the dispatch telemetry seam (`src/telemetry/otel.ts` + `routing/dispatch.ts`), not a separate file. The `./telemetry/otel` subpath keeps `@opentelemetry/api` an optional peer with an import-time error hint.

## Tests (named, written first)
- `middleware/cors.test.ts` — preflight; `*` origin never reflected with credentials (F1).
- `middleware/rate-limit.test.ts` — window/bucket math; headers; keyed by resolved ip/user; **bounded store**: N distinct keys past the cap evict LRU, memory stays capped (store-growth DoS guard). Cases: `| 100 req, limit 100 | all pass, X-RateLimit-Remaining 0 |`; `| 101st | 429 + Retry-After |`; `| window elapsed | counter resets |`; `| cap+1 distinct keys | oldest evicted, memory flat |`.
- `middleware/compress.test.ts` — negotiates br/gzip; skips already-encoded; never corrupts a stream; **BREACH: a response that sets a cookie or carries an auth secret is not compressed** (default-exclude), so body length is not a secret oracle.
- `proxy/proxy.test.ts` — upstream error keys surface; no header smuggling to upstream.
- `telemetry/otel.test.ts` — `middleware.*` + `http.handler` spans are children of the `http.request` root (span tree, not flat roots).
- `telemetry/traceparent.test.ts` — a valid incoming `traceparent` is continued (same trace id, root's parent = caller's span); a malformed one starts a fresh trace; outbound proxy/fetch emits a `traceparent`.
- `telemetry/correlation.test.ts` — with telemetry on, `requestId` sets `honey.request_id` on the root span and the per-request logger child binds `trace_id`+`span_id`; with telemetry off, `requestId` + logger behave exactly as today (ids stay distinct, not collapsed).
- `telemetry/logger.test.ts` — levels build nothing below threshold; child bindings; pino shape; json/pretty; defaults debug(dev)/info(prod); no `logLevel` knob; `logger:false`/`silent` = no-ops that never throw.
- `errors/on-error.test.ts` — `app.onError` is response-shaping and awaited: returning a `HoneyError`/`Response` maps the response (status + headers like `Retry-After` + i18n, as anyrow's db-error handler needs); returning `undefined` falls through to the native projector; a throw inside is logged once and falls back (no recursion); named 4xx/redirect do not fire it. Separately, `telemetry.onError` reports fire-and-forget and never delays the response. Prod bug line carries the full stack while the client gets generic+digest.
- `telemetry/request-log.test.ts` — off by default; field catalog (no query); `skip`; `aborted` on disconnect; `requestLog:true`+`logger:false` throws at startup naming both.
- `telemetry/privacy.test.ts` — no cookie/authorization/set-cookie/query/body/handler-input in any log field or span attribute; route ids name spans (grep gate).
- `telemetry/silent-failure.test.ts` — every `catch` in core logs (tag + `onError` when a server error) or carries a comment naming who reports it; no unclassified swallow remains.
- `telemetry/observability-matrix.test.ts` — the 96-combination matrix from `dx/observability.md`: response identical to unconfigured, nothing throws, id present, each line lands per the table, `onError` once per error, span set matches, nothing private leaks.
- `telemetry/span-lifecycle.test.ts` — root span ends at body finish/cancel (not headers); disconnect → `status: aborted`.

## Security corpus
- CORS credential reflection, CSP bypass, prototype pollution via query/body keys, header injection, proxy SSRF/host spoofing, rate-limit bypass via spoofed key, **compression side channel (BREACH: secret length oracle)**, **rate-limit store growth (key-spray OOM)** — all in the `app.fetch` adversarial suite.

## Perf contract (from the audit — edge middleware must not defeat the fast paths)
- **Mutate the plain header record, never force native Headers.** Response-header-writing middleware (`rateLimit`'s `X-RateLimit-*`/`Retry-After`, `compress`'s `Content-Encoding`, plus `requestId`/`secureHeaders`/`poweredBy`/`serverTiming`/`cors`) write through `HoneyOutHeaders`'s plain-record path, not `#ensureNative()` — otherwise one header write collapses the lazy-header optimization and often triggers a response rebuild. The `mw-stack` bench scenario (all of them on one response) is the gate.
- **`compress` must honor the no-clone pin (bit 08):** encode from the retained raw, and hard-skip a produced stream (sse/stream/generate) — never buffer a body that may never end. Each edge middleware has a per-request cost ceiling in the perf gate; `rateLimit` store ops are O(1).

## Budget
- perf: each middleware's per-request cost measured against the `mw-stack` scenario; rate-limit store O(1).
- token: n/a.
