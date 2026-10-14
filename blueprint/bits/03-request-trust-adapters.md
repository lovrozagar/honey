# Bit 03 — request trust

Closes: — · (Deno removed in bit 00) · trust as the first optional entry
Oracle kept green: `tests/integration/trust.test.ts` (the bit-03 oracle); `_v0`'s frozen `ws3-request` regression stays green automatically (bit 03 doesn't touch `_v0`), and ws3's v1 cases are owned by bits 04/08, not 03.

## Scope
Client identity and trust: `trustProxy` resolution, effective client IP/scheme/host from `X-Forwarded-*` within the trusted hop count, and `clientInfo`. **Trust is the first OPTIONAL entry (`@lovrozagar/honey/trust`):** hops/ranges compile only after that subpath import registers a feature slot, so `trust.ts` is not eagerly bundled into core (H1 lean/tree-shakeable). `feature-slots.ts` (the minimal slot registry) is pulled to this bit because trust is the first consumer; later features (adapters bit 04, ws bit 06) add their own slots. `ipRestrict` allow/deny is middleware, bit 07. `detect-runtime.ts` stays bit 04 (adapter-side, born with its consumers; bit-00 `no-deno.test` already guards that node/bun/cf detection survived the purge).

## Files (from files.tsv — `trust` + `runtime`)
- `src/trust/trust.ts` (+test) — compile a `TrustProxy` setting (config-time validation); resolve the effective client per H18.4. The optional `@lovrozagar/honey/trust` entry registers the feature slot.
- `src/trust/ip.ts` (+test) — parse/format/canonical IP (RFC 5952, IPv4-mapped + `IPv4:port` unwrapped), CIDR parse + membership.
- `src/trust/client-info.ts` (+test) — `ClientInfo {host, ip, protocol}` + `trustsForwarded`, `clientInfo(ctx)`, the peer lookup (`PEER_ADDRESS` symbol the Node adapter sets in bit 04, or Bun's `server.requestIP`). Exposes `ctx.trustsForwarded` — the seam `requestId` reuse + `traceparent` continuation read (H17).
- `src/runtime/feature-slots.ts` (+test) — the slot registry (born here; see Scope).

## Tests (named, written first)
- `trust/trust.test.ts` — compile + config-time validation; off by default = direct peer only; N trusted hops reads the Nth-from-right `X-Forwarded-For`; hop and range walks.
- `trust/ip.test.ts` — parse/canonicalize vs the platform, CIDR membership.
- `trust/client-info.test.ts` — `clientInfo()` and `ctx.trustsForwarded` reflect whether a forwarded value was **actually consumed** this request (H18.4), one extra field on the already-cached `ClientInfo` — not a static "is trustProxy configured" flag. Cases: `| ranges mode, peer out of range | trustsForwarded=false |`; `| hops:1, no X-Forwarded-For | trustsForwarded=false (fell back to direct peer) |`; `| hops:1, one XFF entry | true |`. So `requestId`/traceparent never reuse a client-supplied id on a direct hit against a `trustProxy:N` app. (`ipRestrict` allow/deny is tested in bit 07.)
- `tests/integration/trust.test.ts` — `ctx.ip`/`clientInfo()`/`trustsForwarded` through `app.fetch`: off by default; hops; ranges; garbage at the read position → null; scheme/host only via a trusted hop; a Bun-server env peer; `ctx.ip` reserved; and **resolve-once** (the client is resolved once per request, cached on the request state — N reads via `ctx.ip`/logger/`proxy()` = 1 compute, no `Request` clone, headers read in place). resolve-once is a describe here, not a separate file.
- `tests/integration/security/trust-fuzz.test.ts` — seeded ip-trust fuzz (ip parse/canonicalize vs `node:net`/WHATWG, CIDR vs a bit-by-bit reference, hop walk); property-based, distinct from the hostile-input cases in `adversarial.test.ts`.

## Security corpus
- `X-Forwarded-*` spoofing: an untrusted hop must not set the client IP; header-injection via forwarded values rejected.

## Budget
- perf: trust off (default) = free; resolution is O(hops), computed once per request and cached, within threshold. No `Request` clone on the trust/ip path. token: n/a.
