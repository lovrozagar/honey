# dx — proxy / gateway

`proxy()` forwards a matched route to an upstream (anyrow's gateway uses this). It is KEEP (bit 07), split into `proxy/{proxy,upstream,headers}.ts`.

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| `proxy({ destination, … })` | yes | — | `destination(ctx, url, init)` returns the upstream `Response` — a `fetch()`, a service binding (`c.env.SVC.fetch(...)`) or a DO stub — and honey streams it back. `destination` is a **function**, not a `target: string`, because the gateway consumers (anyrow, lifeonomous) dispatch via service bindings, which a string can't express | `url` is a **single-leading-slash normalized path** (`ctx.path`, so `//`/`\`/`%2F`/`%5C` are already collapsed or 400'd) — that is the SSRF defense, not a host allowlist [F1] | `proxy/proxy.test.ts`, `integration/proxy-upstream.test.ts` |
| `requestHeaders` (record or `(ctx) => record`) | no | pass-through | add/override forwarded request headers | the client's `Host`, `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, hop-by-hop (incl. `Connection`-named), `TE`, `Expect` never reach `destination`; honey sets `X-Forwarded-For`=`ctx.ip` (omitted when null), `-Proto`/`-Host` from the request URL; `CF-Connecting-IP` passes through untouched (H23: no `trustProxy`) | `proxy/headers.test.ts` |
| `onResponse` | no | pass-through | mutate the upstream response (mutable `HoneyOutHeaders`: `set`/`delete`) before it streams back | upstream error-key JSON surfaces byte-for-byte | `proxy/proxy.test.ts` |
| `timeout` / `idleTimeout` | no | 60 s / — | per-request upstream deadline (header + idle); network failure → 502 `bad_gateway`, timeout → 504 `gateway_timeout` | a streaming upstream uses the idle timeout | `proxy/upstream.test.ts` |
| traceparent forwarding | — | on when a span is active | forwards `traceparent` for the current span (G1) | the downstream continues the trace | `telemetry/traceparent.test.ts` |
| downstream error keys | — | surfaced | the gateway documents each downstream route's own error keys (v0 fix `5c20cfb`) | — | `openapi/responses.test.ts` |

## Security corpus
- SSRF (the `url` passed to `destination` is the single-leading-slash normalized `ctx.path`, so `//evil`/`/\evil`/`/%2F%2Fevil` can't escape the upstream origin under either `` `http://x.internal${url}` `` or `new URL(url, base)`; guard: a mutant building `url` from the raw request target), host spoofing, header smuggling to upstream, hop-by-hop leakage — all in the bit-07 `app.fetch` adversarial suite.
