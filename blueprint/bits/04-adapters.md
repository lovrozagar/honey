# Bit 04 — adapters (node / bun / workers)

Closes: — · splits v0 `node.ts` 454, `node-request.ts` 431 · (Deno adapter deleted, H15)
Oracle kept green: the 30-cell e2e matrix (node/bun/cf × dev/prod × 5 apps), `test:consumers`.

## Scope
The three runtime adapters and a **plain `serve(app, options)`**. Each adapter may use only its runtime's builtins (`00-rules.md` environments); the portable core never imports an adapter — which is why `serve` is an explicit import (`@lovrozagar/honey/serve`), **not** an `app.serve()` method (a core method reaching an adapter would need the forbidden slot — H23). The v0 serve-slot/serve-register/feature-load/feature-detect machinery (a module slot + `enableServe()`-at-import + build-time source scanning to inject prelude imports) is **cut** — same self-registering pattern H23 forbids. `serve(app)` detects the runtime and calls the node or bun adapter, returning a handle `{ close(timeout?), hostname, port, runtime, url }` (the Node server's `shutdown(timeout?)` stays on `./node`). **Workers has no adapter module** (`export default app` — `app.fetch(request, env, ctx)` is already the Workers signature; v0's `workers/serve.ts` was only an "export fetch" throw, dropped). `serve` options: `env`, `hostname` (default `0.0.0.0`), `port` (default `3000`), `maxRequestBodySize`, `headersTimeout`/`requestTimeout`/`keepAliveTimeout`, `onError`. **Dropped from v0:** the `cors` serve-option (it set module-global state via `_setGlobal`; CORS is only `app.use(cors())` — H23) and the `runtime` override (detection is exact, so an override can only pick the wrong adapter). The `maxRequestBodySize` default (128 MiB) lives in the **shared serve options**, not `node/request.ts` — so Bun reads it (passed to `Bun.serve`) and Node enforces it without Bun importing `node:*`. `upgradeTimeout` + ws wiring are bit 06. The node adapter sets `PEER_ADDRESS` from the socket, feeding bit-03 `ctx.ip`; it registers no `'upgrade'` listener here (Upgrade requests serve as normal; the ws upgrade path is bit 06). `detect-runtime` is node/bun/cf only (no Deno). `honey init` scaffolding is bit 19 (honey's dev CLI, not an adapter). `optional-peer` guard is bit 06 (its only caller is ws's `ws` load).

**Codegen guard (no globalThis flag).** The generator imports the app module and a top-level `await serve(app)` must not bind a port. v0 used a `globalThis` CODEGEN flag (module-global state — forbidden). v1: the app module **exports** the app and does not serve at import (convention; serving lives in a separate entry or behind `import.meta.main`), so codegen reads the exported app without serving; if a signal is still needed, `serve()` reads an explicit `process.env.HONEY_CODEGEN` (explicit env, not module state), never a global. Finalized at the codegen bit.

## Files (from files.tsv — `adapters` + `runtime`)
- `src/adapters/node/serve.ts` (+test), `src/adapters/node/request.ts` (+test) — the `node:http` ↔ Fetch bridge (node:* allowed here only): route on the request target not the Host header, absolute-form target by path, malformed Host → 400, body streamed both ways, client-close abort, `PEER_ADDRESS` from `socket.remoteAddress`; responses keep multiple Set-Cookie + HEAD, chunked streaming, keep-alive, graceful drain.
- `src/adapters/bun/serve.ts` (+test) — `Bun.serve({ fetch: app.fetch })`, the server as env (`requestIP` → `ctx.ip`).
- `src/adapters/serve.ts` (+test) — the plain `serve(app, options)` (the `./serve` export); holds the shared option defaults (incl. the 128 MiB `maxRequestBodySize`). `src/adapters/fetch-request.ts` (+test) — `toFetchRequest`.
- `src/runtime/detect-runtime.ts` (+test) — node/bun/cf, no Deno. (Workers has no adapter file; `optional-peer` is bit 06.)

## Tests (named, written first)
- siblings for every src row above.
- `tests/integration/node-adapter.test.ts` — a real `node:http` round trip: request target vs Host, absolute-form, malformed Host → 400, streaming both ways, Set-Cookie list, HEAD, keep-alive, socket peer → `ctx.ip`, client abort.
- `tests/integration/serve.test.ts` — `serve(app)` on node/bun: the returned handle, graceful shutdown drain, Workers via `app.fetch`.
- `tests/e2e/run.ts` — the 30-cell matrix passes identically (no Deno cell), CI (toolchains).

## Security corpus
- request smuggling / header-injection at the `node:http` bridge; oversized header set.

## Budget
- perf: adapter overhead vs raw runtime within threshold. token: n/a.
