# Bit 03 — request trust

Closes: — · (Deno removed in bit 00) · keeps node/bun/cf detection
Oracle kept green: `tests/integration/trust.test.ts`, ws3-request regression.

## Scope
Client identity and trust: `trustProxy` resolution, effective client IP/scheme/host from `X-Forwarded-*` within the trusted hop count, IP restriction policy, and `clientInfo`. Runtime detection is a pure value consumed by the adapters (bit 04); this bit proves node/bun/cf detection survives the Deno purge.

## Files (from files.tsv — `trust` + `runtime`)
- `src/trust/trust.ts` (+test) — compile a `TrustProxy` setting; resolve the effective client.
- `src/trust/ip.ts` (+test), `src/trust/client-info.ts` (+test, `clientInfo()`). It also exposes `ctx.trustsForwarded` — the seam `requestId` reuse and `traceparent` continuation read (H17). `ipRestrict` is middleware, built in bit 07 (`middleware/ip-restrict.ts`).
- `src/trust/client-info.ts` (+test) — `clientInfo()` from the resolved request.
- `src/runtime/detect-runtime.ts` (+test) — returns node | bun | cf; no Deno branch.

## Tests (named, written first)
- `trust/trust.test.ts` — off by default = direct peer only; N trusted hops reads the Nth-from-right `X-Forwarded-For`.
- `trust/client-info.test.ts` — `clientInfo()` and `ctx.trustsForwarded` reflect whether a forwarded value was **actually consumed** this request (H18.4), one extra field on the already-cached `ClientInfo` — not a static "is trustProxy configured" flag. Cases: `| ranges mode, peer out of range | trustsForwarded=false |`; `| hops:1, no X-Forwarded-For | trustsForwarded=false (fell back to direct peer) |`; `| hops:1, one XFF entry | true |`. So `requestId`/traceparent never reuse a client-supplied id on a direct hit against a `trustProxy:N` app. (`ipRestrict` allow/deny is tested in bit 07.)
- `trust/resolve-once.test.ts` — the client is resolved **once per request** and cached on the request context; N reads (`ctx.ip`, `ipRestrict`, logger, `proxy()`) = 1 compute. The cache holds the small `{ host, ip, protocol }` object; the `Request` is never cloned and its body is never touched (headers are read in place via `req.headers.get`).
- `runtime/detect-runtime.test.ts` — node/bun/cf each detected; no Deno path.

## Security corpus
- `X-Forwarded-*` spoofing: an untrusted hop must not set the client IP; header-injection via forwarded values rejected.

## Budget
- perf: trust off (default) = free; resolution is O(hops), computed once per request and cached, within threshold. No `Request` clone on the trust/ip path. token: n/a.
