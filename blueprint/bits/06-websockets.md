# Bit 06 — websockets + realtime

Closes: H8 (realtime: keep and fix) · H18.12 (ws full-origin) · the 101 upgrade path deferred from bit 04
Oracle kept green: `tests/regression/ws4-8/*`, `conformance/ws`, the realtime integration + reconnect suites.

## Scope
The three-runtime WebSocket surface (`app.ws(path)` route builder + node/bun/cloudflare adapters + a runtime-agnostic session) and the realtime pub/sub layer built on top of it (`realtime(app, path, opts)`). The optional `ws` npm peer loads through `optional-peer.ts` (a plain dynamic import, never a registry). This bit also wires the 101 upgrade path the node adapter deferred at bit 04.

**Rulings (bit 06):**

1. **`feature-slots.ts` is cut entirely (H23) and never recreated.** v0's registry — `registerFeature`/`requireFeature`/`loadFeature`/`resetFeature` with self-registering `proxy`/`realtime`/`trust`/`ws` slots — is the exact pattern H23 forbids, the same shape as the serve-slot cut at bit 04. trust is already gone (bit 03); realtime, proxy and ws become plain code reached by ordinary imports. No v1 row exists for it; it must not return. Retire the inventory's `feature-slots` case under H23.

2. **realtime is a plain function, not a method or a slot.** `realtime(app, path, opts): RealtimePublisher` is the `./realtime` export (`src/realtime/realtime.ts`, renamed from v0's self-registering `register.ts`). It registers the route through the public `app.ws(path)` API and wires the bus/session/publisher; it returns a publisher. The core never imports realtime, so an app without a realtime route bundles none of its ~600 lines. Rejected: `app.realtime()` as a core method — it would force a static core import of the realtime server or resurrect the slot. (Consistent with `serve(app)` being a free function, bit 04, for the same reason.)

3. **The ws contract lives in a plain module (`src/ws/contract.ts`), not in the cf adapter.** v0 housed `WSContext`/`WSHandler`/`WSAdapter`/`WSPreUpgrade`/`RawSocket`/`WSContextImpl`/`fireHandler` in `cloudflare.ts` and made node/bun/session reach them through `import "./session.ts"` (a side-effect import that fired `registerFeature("ws", …)`). v1 puts the contract in `contract.ts`; node/bun/cloudflare/session import it with no side effect and no `registerFeature`. Every `import "./session.ts"` is dropped.

4. **`app.wsAdapter(adapter)` is an explicit app setting** — a value the user passes, in the same class as `onError`, with no module state and no registry. The app is the single artifact present on all three runtimes, and `app.fetch` must reach the adapter to upgrade, so the adapter belongs on the app (Workers has no `serve`, so it can't live only in serve options). `serve(app)` on node/bun auto-fills the runtime's adapter — via serve's blessed dynamic `import()` (the one dispatcher exception in the boundaries rule, bit 04) — when none is set, because Bun needs the `websocket` handler object at `Bun.serve()` time and Node wires the deferred `'upgrade'` listener; a wrong-runtime adapter throws. On Workers the user writes `app.wsAdapter(cfWebSocket())`. Auto-fill is a dynamic import, not a registry.

5. **The Node upgrade reaches the adapter by a `NODE_UPGRADE` symbol on the request view, not `env.__nodeUpgrade`.** v0 did `{ ...env, __nodeUpgrade: state }` (`node.ts:369`), polluting the user's `ctx.env` with the socket/head. v1 stashes `{ socket, head, req, upgraded }` under a `Symbol.for`-keyed property on the Node request view — the same pattern as bit-03/04 `PEER_ADDRESS` — and the node adapter reads it there; `ctx.env` stays the user's own.

6. **H18.12 — ws same-origin compares full origin (scheme+host+port).** `originAllowed` drops v0's trustProxy-derived `host` argument (trust is cut, H23). The same-origin shortcut compares the `Origin` header's origin against the request's own canonical origin (`new URL(ctx.req.url).origin` — scheme+host+port as the runtime spells it, bit 03/04 canonical URL). An `http://` Origin is not same-origin to an `https` server. Behind untrusted TLS termination the server sees plaintext, so the shortcut fails **closed**; such an app uses an explicit `allowedOrigins` allowlist, which already matches the full origin exactly. The default policy (reject a cross-origin upgrade that carries `Cookie`/`Authorization`, pass a request with no `Origin`) is kept.

7. **`truncateUtf8` moves to `ws/shared.ts`.** Close-reason truncation (≤123 UTF-8 bytes, no split code point) is a ws-transport concern; realtime imports it from `shared.ts`, which removes the v0 ws→realtime import.

8. **The 101 upgrade path (deferred from bit 04) lands here.** An adapter's `upgrade()` returns a `Response` the dispatch recognizes as an upgrade (the 101 sentinel plus the runtime's socket handle) and completes the handshake instead of writing a body. On Node, `serve` wires the `'upgrade'` listener (deferred at bit 04) and routes it to `wsAdapter.upgrade`, handing the socket/head through the `NODE_UPGRADE` symbol. `preUpgrade(req)` — the same-turn fast path Bun and Workers need — is a plain adapter method, not a slot.

9. **No separate `realtime/sse-reset.test.ts`.** H18.6 (an empty `id:` is the reset directive) already ships in bit-05 `response/sse.test.ts`. Realtime resume (H8) tests its own id/resume semantics in `realtime/server` and the realtime integration suite.

## Files (from files.tsv — `ws` + `realtime` + `runtime/optional-peer`)
- `src/ws/contract.ts`, `src/ws/shared.ts`, `src/ws/session.ts`, `src/ws/origin.ts` — the portable core (contract types + `WSContextImpl`, option/protocol/payload/close-code/`truncateUtf8` helpers, the ordered contained session, the origin policy).
- `src/ws/node.ts`, `src/ws/bun.ts`, `src/ws/cloudflare.ts` — the three adapters; each imports the contract, none self-registers. node uses the `ws` peer via `optional-peer.ts`.
- `src/ws-builder.ts` — `WSRouteBuilder` (the `app.ws(path)` route API).
- `src/realtime/realtime.ts` (the `./realtime` plain-function export), `bus.ts`, `route.ts`, `server.ts`, `reference-server.ts` (H8), `invoke-user.ts` (callback containment, shared with ws).
- `src/runtime/optional-peer.ts` — the friendly "install ws" error on a missing optional peer; a dynamic import of a real dependency, not a registry.

## Tests (named, written first)
Co-located unit siblings, one per src file, named by the sub-behavior that file owns (no numbered splits):
- `ws/contract.test.ts` — `WSContextImpl`: JSON-object send, string/binary passthrough, the open-queue (≤32, drop-oldest, flush on open), backpressure (close 1013 / drop), close (reason truncation, buffer cleared), readyState/bufferedAmount.
- `ws/shared.test.ts` — option resolution + validation, protocol selection, payload-size check, close-code sanitizing, `bufferedAmount`, `toArrayBuffer`, `truncateUtf8`.
- `ws/session.test.ts` — the ordered queue (open→message→close), containment (a throwing callback is caught and reported, never thrown into the runtime), `onError` routing, pending-message cap (1008), reconnect→`onReconnect`.
- `ws/origin.test.ts` — policy (`"*"`, list, predicate, default credentialed-reject), H18.12 full-origin same-origin (http vs https rejected), `validateOriginPolicy` errors, no-`Origin` pass, `"null"` origin.
- `ws/node.test.ts` — the `ws` lazy load (optional-peer, not cached on failure, friendly message), keepalive ping/pong/terminate, idle timeout, handshake-failure reject, `NODE_UPGRADE` read, binary→ArrayBuffer, `closeAll`.
- `ws/bun.test.ts` — `server.upgrade`, the `websocket` handler object (open/message/close), idleTimeout clamp (seconds, ≤960), the 101 sentinel, lazy socket (assigned before user code).
- `ws/cloudflare.test.ts` — `WebSocketPair` + `server.accept`, 101 + `webSocket`, message/close/error events, close-echo (sendable codes), payload-too-big close, protocol header.
- `realtime/bus.test.ts`, `realtime/route.test.ts`, `realtime/server.test.ts`, `realtime/invoke-user.test.ts` — pub/sub + namespace isolation; config defaults + limit validation + legacy-option rejection + `ConnContext`; publisher + resume (H8) + slow-consumer + limit enforcement; `invokeUser` containment + `createEventQueue` ordering.
- Integration: `tests/integration/websockets.test.ts`, `tests/integration/realtime.test.ts` (rows above). Typetest: `tests/types/websockets.typetest.ts`. Regression: `tests/regression/ws4-node-adapter.regression.test.ts`, `tests/regression/ws4-in-process.regression.test.ts` (v1-named ports of v0 `ws4-8/*`, `// v0:` tagged); `ws2-middleware`, `review`/`review2` grow their ws cases.

## Security corpus (adversarial.test.ts grows)
- Cross-site WebSocket hijacking: a credentialed cross-origin upgrade is rejected (H18.12); an `http://` origin is not same-origin to an `https` server. Guard across `ws/origin.ts` → the builder.
- Payload/pending floods: an oversized frame closes 1009; a client that never drains its handler queue closes 1008 at the pending cap; a slow consumer hits the backpressure policy. Guard on the session + contract.

## Budget
- perf: ws upgrade + message round-trip and realtime fan-out within threshold (proposal before wiring, like the streaming gate).
- token: the ws/realtime client emitters are bits 11–16; no core token cost here.
