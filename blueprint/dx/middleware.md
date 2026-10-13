# dx — middleware

`use(mw)` installs middleware; the edge/security set is composable middleware, not hidden steps. Each runs in registration order and may short-circuit. New entries (rate-limit, compress) are A5/A6.

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| `createMiddleware` / `defineMiddleware` | — | — | a typed middleware that can extend `ctx` and short-circuit | extending `ctx` changes the handler type downstream | `middleware/middleware.test.ts` |
| `cors(options)` | no | — | CORS headers + preflight | credential reflection with `*` origin is rejected under the adversarial gate [F1] | `middleware/cors.test.ts`, `integration/cors.test.ts` |
| `secureHeaders(options)` | no | sane set | HSTS, X-Content-Type-Options, frame, referrer, etc. | overriding a header to a weaker value is the user's choice, documented | `middleware/secure-headers.test.ts` |
| `csrf(options)` | no | — | CSRF origin/token check | pairs with cookie settings; GET is exempt | `middleware/csrf.test.ts` |
| `rateLimit(options)` | no | off | **[A5]** **fixed-window** limiter (pinned); default key = resolved `ctx.ip`; emits `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (epoch seconds) + `Retry-After` (delta seconds) on 429; `store` is a `RateLimitStore { hit(key): { count, resetAt } \| Promise<…> }`, default **bounded** in-process (LRU/TTL + max-entries) | memory store is per-process and capped (key-spray can't OOM it, H18.8); use a shared store behind multiple instances | `middleware/rate-limit.test.ts`, `integration/rate-limit.test.ts` |
| `compress(options)` | no | off | **[A6]** gzip/br by `Accept-Encoding` | skips already-encoded/streamed bodies; the edge may already compress | `middleware/compress.test.ts` |
| `requestId(options)` | no | — | assigns/propagates a request id | reuse an upstream id only when the hop is trusted (`ctx.trustsForwarded`, bit-03 seam) | `middleware/request-id.test.ts` |
| `timeout(ms)` | no | off | aborts a slow handler | a streaming response needs no timeout | `middleware/timeout.test.ts` |
| `bodyLimit(bytes)` | no | app default | caps request body | an unbounded body is a DoS vector [F1] | `input/body-limit.test.ts` |
| `serverTiming()` | no | off | `Server-Timing` header | adds timing visibility; off by default | `middleware/server-timing.test.ts` |
| `poweredBy(value?)` | no | off | `X-Powered-By` | off by default; opt in | `middleware/powered-by.test.ts` |
| `ipRestrict(policy)` | no | — | allow/deny by client IP (uses `trustProxy`) | depends on a correct `trustProxy` setting | `middleware/ip-restrict.test.ts` |
