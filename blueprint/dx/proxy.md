# dx — proxy / gateway

`proxy()` forwards a matched route to an upstream (anyrow's gateway uses this). It is KEEP (bit 07), split into `proxy/{proxy,upstream,headers}.ts`.

| value | required | default | outcome | pitfall | test |
| --- | --- | --- | --- | --- | --- |
| `proxy({ target })` | yes | — | forward the request to `target`, stream the response back | `target` is resolved under `trustProxy`; an open target is an SSRF vector [F1] | `proxy/proxy.test.ts`, `integration/proxy.test.ts` |
| `requestHeaders(ctx, headers)` | no | pass-through | mutate forwarded request headers (auth, client info, consistency) | hop-by-hop headers are stripped; do not forward `Host` blindly | `proxy/headers.test.ts` |
| `responseHeaders` | no | pass-through | mutate the upstream response headers | upstream error-key JSON surfaces as honey errors | `proxy/proxy.test.ts` |
| `timeout(ctx)` | no | app default | per-request upstream deadline | a streaming upstream needs no timeout | `proxy/upstream.test.ts` |
| traceparent forwarding | — | on when a span is active | forwards `traceparent` for the current span (G1) | the downstream continues the trace | `telemetry/traceparent.test.ts` |
| downstream error keys | — | surfaced | the gateway documents each downstream route's own error keys (v0 fix `5c20cfb`) | — | `integration/proxy.test.ts` |

## Security corpus
- SSRF (target host allowlist/resolution), host spoofing, header smuggling to upstream, hop-by-hop leakage — all in the bit-07 `app.fetch` adversarial suite.
