# `@honey/e2e-cf-workers`

Live Cloudflare proof of the kitchen e2e app (`e2e/apps/kitchen`) on workerd.

**Worker:** `honey-cf-e2e`  
**URL:** https://honey-cf-e2e.lovro-zagar5.workers.dev

Same routes as bun / node / deno Playwright (`e2e/apps/kitchen/tests/e2e`). Entry is `src/worker.ts`. Local `test:e2e:cf` can point the worker at another `e2e/apps/*` via `HONEY_E2E_APP`; the live worker stays kitchen.

## Smoke

```bash
curl -sS https://honey-cf-e2e.lovro-zagar5.workers.dev/api/health
# ok

curl -sS -o /dev/null -w "%{http_code}\n" https://honey-cf-e2e.lovro-zagar5.workers.dev/api/docs
curl -sS https://honey-cf-e2e.lovro-zagar5.workers.dev/api/manifest.json | head -c 80
curl -sS https://honey-cf-e2e.lovro-zagar5.workers.dev/api/openapi.yaml
curl -sS https://honey-cf-e2e.lovro-zagar5.workers.dev/api/openapi.yml
curl -sS https://honey-cf-e2e.lovro-zagar5.workers.dev/api/openapi.json

curl -sS -o /dev/null -w "%{http_code}\n" -X OPTIONS \
  -H "origin: https://example.com" \
  -H "access-control-request-method: GET" \
  https://honey-cf-e2e.lovro-zagar5.workers.dev/api/openapi.json
# 204
```

## Live soak

Same worker, public URL. After deploy:

```bash
bun run test:live:cf
```

Default live soak: **8000** `/api/health`, **800** `/api/openapi.json`, **200** CORS preflights (concurrency 250, 8s per-request timeout), then **80** `/api/echo-ws` echo sockets. Override with `HONEY_CF_STORM`, `HONEY_CF_WS`, `HONEY_CF_CONCURRENCY`, `HONEY_CF_LIVE_URL`.

## Local

```bash
bun run test:e2e:cf   # Playwright against wrangler dev
bun run dev           # from this directory
```

## Deploy

Needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment. Do not commit them.

```bash
bun run deploy:e2e:cf
```

This is the named production proof, not a scratch upload. Delete it with `bunx wrangler delete --name honey-cf-e2e` only if that proof should go away.
