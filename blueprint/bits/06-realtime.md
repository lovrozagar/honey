# Bit 06 — realtime + reference server

Closes: H8 (SSE typing, reconnect parity, reference server)
Oracle kept green: `tests/integration/realtime.test.ts`, the ws adapter suites.

## Scope
The resume client and server stay; fix the gaps. The WS adapters (node/bun/cf — Deno deleted) and session logic, the realtime bus/route/server, and a **reference resume server** shipped in `tests/` so SSE/WS reconnect is actually exercised. honey never emits `x-realtime`; the consumer opts in via `.meta({})`.

## Files (from files.tsv — `realtime` + `ws`)
- `src/realtime/bus.ts` (+test), `src/realtime/route.ts` (+test), `src/realtime/server.ts` (+test), `src/realtime/register.ts` (index).
- `src/realtime/reference-server.ts` (+test) — the conformance target (new, H8).
- `src/realtime/invoke-user.ts` (+test) — callback containment (`invokeUser`/`reportUserError`/`createEventQueue`) for ws/realtime event callbacks (re-homed from bit 02; its consumers are ws/realtime, and the request-handler path is `runHandler` in `middleware.ts`). The console fallback routes through the bit-07 logger.
- `src/ws/{node,bun,cloudflare}.ts` (+test each), `src/ws/session.ts` (+test), `src/ws/shared.ts` (+test), `src/ws/origin.ts` (+test).
- the TS resume-client runtime emitted by codegen (`gen/emit/ts/realtime.ts`: `createResumableConnection`, keepalive loop, fallback chain, `RealtimeError` types) is built with the TS SDK in bit 11; this bit owns the server + reference server it talks to.

## Tests (named, written first)
- `realtime/resume.test.ts` — a dropped SSE/WS stream resumes from `Last-Event-ID`; no gap, no dup beyond the declared delivery guarantee.
- `realtime/reference-server.test.ts` — the reference server drives reconnect for every SDK (parity).
- `ws/origin.test.ts` — upgrade denied for a disallowed `Origin`; **same-origin compares the full origin (scheme+host+port)** — an `http://` origin is NOT same-origin to an `https` host (H18.12; v0 `ws-origin.ts:49` compared host only).
- `realtime/sse-reset.test.ts` — an explicit empty `id:` is emitted to reset the client's last-event-id (H18.6; v0 `response.ts:238` skipped `id===""`), distinct from "unset".
- `ws/adapters.test.ts` — node/bun/cf each perform the 101 upgrade; no Deno path.

## Security corpus
- cross-site WS (missing/forged `Origin`); unbounded WS session memory; resume-id forgery.

## Budget
- perf: reconnect storm handling within threshold.
- token: the realtime markers in the IR stay within the per-operation token budget.
