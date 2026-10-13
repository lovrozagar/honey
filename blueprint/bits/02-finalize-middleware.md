# Bit 02 — middleware + context

Closes: — · splits v0 `middleware.ts` 331, `context.ts` 325
Oracle kept green: `tests/integration/middleware.test.ts`, `tests/integration/cookies.test.ts`, ws2-middleware regression.

## Scope
The middleware core (`use`, compose, short-circuit, telemetry wrap) and the request context (`HoneyContext`, cookies, cookie signing). The edge/security middlewares themselves are bit 07; this bit is the mechanism they plug into.

## Files (from files.tsv)
- `src/middleware/middleware.ts` (+test) — `createMiddleware`/`defineMiddleware`, order, short-circuit, per-mw telemetry.
- `src/context/context.ts` (+test) — `HoneyContext`, `ctx` extension via `.context(fn)`, typed input access.
- `src/context/cookie.ts` (+test), `src/context/cookie-sign.ts` (+test).

## Tests (named, written first)
- `middleware/middleware.test.ts` — registration order, short-circuit stops the chain, a `use()` with no route is reported at finalize, telemetry sees each mw's duration + throw.
- `context/context.test.ts` — `.context(fn)` extends the handler type; a pure context runs once per request.
- `context/cookie.test.ts` — set/get, attributes, signing round-trip, tamper rejected.

## Perf (v1 improvement — from the audit)
- Keep a **sync middleware spine**: v0 always routes the request path through the converting compiler (`middleware.ts:241-264`, forced by `index.ts:1455`), allocating a `called` flag + `next` closure + `Promise.resolve().then()` wrapper **per middleware per request** even when the middleware ran synchronously (the sync/single-mw fast paths in `compileChain` are dead on the request path). v1 returns a non-Promise through layers whose middleware returned sync, and boxes only on an actual `await`/throw. **Caveat (H18/round 2):** this only unboxes a **non-`async`** middleware — a language-`async` function always returns a Promise, so async middleware still carries the boundary. It is still worth doing (sync middleware are common: header setters, guards), but the gate needs a **sync-written-middleware bench scenario** (`mw-sync`) to measure the win — the existing `chain`/`mw-stack` scenarios use async middleware and cannot show it.

## Security corpus
- cookie codec fuzz (malformed attributes, oversized, injection into `Set-Cookie`); signed-cookie tamper.

## Budget
- perf: middleware compose adds no per-request allocation beyond the chain; benchmark ratio within threshold.
- token: n/a.
