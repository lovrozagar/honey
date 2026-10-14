# Bit 03 — client IP

Closes: — · (Deno removed in bit 00) · `trustProxy` CUT (H23)
Oracle kept green: `tests/integration/client-ip.test.ts` (the bit-03 oracle); `_v0`'s frozen `ws3-request` regression stays green automatically (bit 03 doesn't touch `_v0`), and ws3's v1 cases are owned by bits 04/08, not 03.

## Scope
Just `ctx.ip`: the client address, resolved from the **platform peer** and canonicalized. **`trustProxy` is cut (H23)** — no `X-Forwarded-*`, no CIDR ranges, no hop counting, no `trustsForwarded`, no config, no `clientInfo` host/proto-from-forwarded. The peer is whatever the runtime reports: `CF-Connecting-IP` on Workers (edge-set, unspoofable; read only when `navigator.userAgent === "Cloudflare-Workers"`, else it is client text and ignored), the socket `remoteAddress` on node (the bit-04 adapter exposes it via the `PEER_ADDRESS` symbol), `server.requestIP(req)` on Bun. Behind a self-hosted reverse proxy that is the proxy's address — correct-by-default, since honey never trusts a client-supplied header. (If a self-hosting consumer ever needs the `X-Forwarded-For` override, it comes back as plain code, never machinery — H23.) No import side effects, no registry, no injection (H23/H19.3). `detect-runtime.ts` is bit 04 (adapter-side).

## Files (from files.tsv)
- `src/context/peer.ts` (+test) — `ctx.ip` = the canonical platform peer. `PEER_ADDRESS` symbol (the node adapter sets it in bit 04), `peerAddressOf(req, env)` over the three sources above, and canonical form (unwrap `::ffff:a.b.c.d`, lowercase IPv6) so a client reads identically on every runtime. Lazy, resolved once per request and cached on the request state; `ip` is a reserved ctx key. Pure, side-effect-free, reached through an ordinary import.

## Tests (named, written first)
- `context/peer.test.ts` — `peerAddressOf` over each source (a manually-set `PEER_ADDRESS` = the node-adapter contract; a Bun `env.server.requestIP`; `CF-Connecting-IP` only under the Workers UA, ignored otherwise); canonicalization (`::ffff:1.2.3.4` → `1.2.3.4`, IPv6 lowercased); missing peer → `null`.
- `tests/integration/client-ip.test.ts` — `ctx.ip` through `app.fetch`: the Workers header path, the Bun env peer, a set `PEER_ADDRESS` (node-adapter sim), canonical cross-runtime, **resolve-once** (the client is read once per request and cached on the request state — N reads of `ctx.ip` = 1 compute, no `Request` clone), behind-a-proxy `ctx.ip` = the proxy address (no trust), and `ip` reserved (`context()` refuses it).

## Security corpus
- `ctx.ip` never reads a client-suppliable header off-Workers: a request setting `CF-Connecting-IP` on node/bun does not move `ctx.ip` off the real peer (the Workers-UA guard). (The `X-Forwarded-*` spoofing surface is gone with `trustProxy` — H23.)

## Budget
- perf: `ctx.ip` unread = free (lazy); read = one peer lookup + canonicalize, cached per request, no `Request` clone. token: n/a.
