# Bit 04 — adapters (node / bun / workers)

Closes: — · splits v0 `node.ts` 454, `node-request.ts` 431 · (Deno adapter deleted, H15)
Oracle kept green: the 30-cell e2e matrix (node/bun/cf × dev/prod × 5 apps), `test:consumers`.

## Scope
The three runtime adapters and `serve`. Each adapter may use only its runtime's builtins (`00-rules.md` environments); the portable core never imports an adapter. The `node:http` bridge lives here.

## Files (from files.tsv — `adapters` folder)
- `src/adapters/node/serve.ts` (+test), `src/adapters/node/request.ts` (+test) — `node:http` bridge (node:* allowed here only).
- `src/adapters/bun/serve.ts` (+test) — Bun.serve.
- `src/adapters/workers/serve.ts` (+test) — Workers `fetch(request, env, ctx)`.
- `src/adapters/serve.ts` (+test), `src/adapters/serve-register.ts` (index), `src/adapters/serve-slot.ts` (+test), `src/adapters/init.ts` (+test), `src/adapters/fetch-request.ts` (+test).

## Tests (named, written first)
- `adapters/node/serve.test.ts` — a `node:http` request maps to a Fetch `Request` and back; streaming body preserved.
- `adapters/bun/serve.test.ts`, `adapters/workers/serve.test.ts` — the decision function (pure) is covered under the default runner; the runtime test proves the adapter calls it.
- `tests/e2e/run.ts` — the 30-cell matrix passes identically to v0 (no Deno cell).

## Security corpus
- request smuggling / header-injection at the `node:http` bridge; oversized header set.

## Budget
- perf: adapter overhead vs raw runtime within threshold. token: n/a.
