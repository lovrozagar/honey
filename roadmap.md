<!-- MANAGED by workerc — edit content freely but keep the format conventions intact.
     workerc parses step IDs (1.a.1), statuses ([ ] / [x] / [!]), phase/track headers,
     and the metadata lines. /workerc:done marks steps [x], /workerc:status reads progress. -->

# roadmap — honey

  milestone  reliability
  active     29.a.2
  updated    2026-08-14

## Phase 1 — Truthful default suite
  goal    Default `bun run test` is green because extract leftovers are fixed or gone, not hidden
  status  complete

### Track 1.a — Stale test triage                           [sequential]
  [x] 1.a.1   Classify each vitest `stale` exclude: fix, keep-excluded, or delete
  [x] 1.a.2   Apply triage — restore green tests, delete dead ones, shrink the stale list
  [x] 1.a.3   Confirm `bun run test` stays green after the shrink

## Phase 2 — Playwright e2e
  goal    `bun run test:e2e` is a real-server proof against the bun runtime
  status  complete

### Track 2.a — Bun Playwright                              [sequential]
  [x] 2.a.1   Make `@honey/e2e-bun` Playwright suite green
  [x] 2.a.2   Decide node / deno / cf-workers e2e: CI now, later, or stay opt-in

## Phase 3 — Language SDK harnesses
  goal    `bun run test:harness` is green, or each skip has a stated reason
  status  complete

### Track 3.a — Harnesses                                   [sequential]
  [x] 3.a.1   Green or skip-with-reason: TS / Go / Python / Rust / MCP integration harnesses
  [x] 3.a.2   Green or skip-with-reason: go-cli + per-lang SDK compile tests
  [x] 3.a.3   Green or skip-with-reason: emitter byte-equiv snapshots

## Phase 4 — Ship the extract
  goal    Parked — iterate on the product, not git/npm
  status  parked

### Track 4.a — Git + npm                                   [sequential]
  [x] 4.a.1   Commit remaining standalone-ready work
  [ ] 4.a.2   Push `origin/main` (parked)
  [ ] 4.a.3   npm publish `honey` (parked)

## Phase 5 — OpenAPI YAML
  goal    `honey generate` writes OpenAPI YAML equivalent to the existing JSON spec
  status  complete

### Track 5.a — YAML emit                                   [sequential]
  [x] 5.a.1   Serialize the same OpenAPI document as YAML (no second spec)
  [x] 5.a.2   Write `openapi.gen.yaml` next to `openapi.gen.json` from CLI + plugin
  [x] 5.a.3   Tests + regenerate example / e2e consumers

## Phase 6 — Remaining codegen honesty
  goal    Default suite does not hide schema adapters, SDK emit, or x-internal; rust harness is green or honestly skipped
  status  complete

### Track 6.a — Leftover stale + rust                       [sequential]
  [x] 6.a.1   Fix or restore leftover stale codegen tests (OpenAPI adapters, SDK emit, x-internal)
  [x] 6.a.2   Make `test:harness:rust` green or skip each remaining fail with a stated reason
  [x] 6.a.3   Confirm `bun run test` stays green

## Phase 7 — Harness is one loop, CI runs it
  goal    `bun run test:harness` includes rust; CI runs that loop with Go / Python / Rust present
  status  complete

### Track 7.a — One harness + CI                            [sequential]
  [x] 7.a.1   Fold rust into `test:harness` (keep rust-only alias; skip if no cargo / `HONEY_RUST_INTEGRATION=0`)
  [x] 7.a.2   Run `test:harness` in CI with Go, Python (httpx), and Rust toolchains
  [x] 7.a.3   Clean leftover README / `test:all` stale-list wording

## Phase 8 — WS close codes + other-runtime e2e
  goal    Rust SDK surfaces close code/reason like TS/Go/Python; node / deno / cf Playwright is green or skipped with a stated reason
  status  complete

### Track 8.a — WS close code/reason                        [sequential]
  [x] 8.a.1   Rust `Error::Closed { code, reason }` from close frames (and stream end)
  [x] 8.a.2   Rust harness WS-C / WS-D assert code + reason (parity with TS/Go/Python)

### Track 8.b — Node / Deno / CF Playwright                 [sequential]
  [x] 8.b.1   Classify node / deno / cf-workers e2e: fix, skip-with-reason, or CI
  [x] 8.b.2   Make each suite green or skip with a stated reason
  [x] 8.b.3   Wire green suites into CI; leave the rest opt-in with a reason

## Phase 9 — Named Cloudflare proof
  goal    The live `honey-cf-e2e` worker is a documented proof URL, not a nameless lab deploy
  status  complete

### Track 9.a — Keep and name it                            [sequential]
  [x] 9.a.1   Keep `honey-cf-e2e` on workers.dev as the workerd proof
  [x] 9.a.2   Document URL + smoke + `bun run deploy:e2e:cf` (no secrets in repo)

## Phase 10 — First-class OpenAPI serve
  goal    `app.openapi({ title, version })` mounts JSON + YAML aliases from one spec
  status  complete

### Track 10.a — Builder mount                              [sequential]
  [x] 10.a.1   `Honey.openapi()` serves `/openapi.json`, `.yml`, and `.yaml` (cached)
  [x] 10.a.2   e2e app uses it; Playwright stays green

## Phase 11 — OpenAPI docs UI
  goal    `app.openapi({ docs })` mounts Scalar or Swagger and hides spec/docs routes from the document
  status  complete

### Track 11.a — Docs + hide internals                      [sequential]
  [x] 11.a.1   Spec endpoints are `honey.internal` (not in generateOpenApi / manifest)
  [x] 11.a.2   `docs: "scalar" | "swagger"` mounts HTML at `/docs` (or `docsPath`)
  [x] 11.a.3   e2e app + Playwright cover `/docs` and exclusion

## Phase 12 — OpenAPI serve cache
  goal    Served spec retries after generate failure and includes routes registered after the first fetch
  status  complete

### Track 12.a — Epoch cache                                [sequential]
  [x] 12.a.1   Rejected generate is not cached
  [x] 12.a.2   Late route inserts invalidate the served JSON + YAML cache

## Phase 13 — First-class manifest serve
  goal    `app.manifest()` mounts a cached, internal `/manifest.json`
  status  complete

### Track 13.a — Builder mount                              [sequential]
  [x] 13.a.1   `Honey.manifest()` serves JSON, skipped from spec/manifest, epoch-cached
  [x] 13.a.2   e2e app uses it; Playwright stays green

## Phase 14 — CORS preflight on method-specific routes
  goal    OPTIONS preflight runs the matched method's middleware when fetch is on a parent instance
  status  complete

### Track 14.a — Preflight dispatch                         [sequential]
  [x] 14.a.1   Parent fetch + child `cors()` GET/POST → 204; no handler; missing path 404
  [x] 14.a.2   Playwright: OPTIONS `/api/health` and `/api/openapi.json`

## Phase 15 — Examples serve spec + manifest
  goal    Example apps use `app.openapi()` and `app.manifest()` the way a consumer would
  status  complete

### Track 15.a — Demos + README                             [sequential]
  [x] 15.a.1   demo-1 (and other examples) mount openapi + manifest
  [x] 15.a.2   Consumer test + README builder snippet

## Phase 16 — Live proof matches current app
  goal    honey-cf-e2e serves docs, manifest, and CORS preflight; dead once-async is gone
  status  complete

### Track 16.a — Redeploy + cleanup                         [sequential]
  [x] 16.a.1   Redeploy `honey-cf-e2e`; smoke health, docs, spec, OPTIONS
  [x] 16.a.2   Delete unused `e2e/app` once-async helper + test

## Phase 17 — Share static route map across clones
  goal    `use()` / `basePath` / `context` / `meta` share the O(1) static map with the parent
  status  complete

### Track 17.a — Shared holder                              [sequential]
  [x] 17.a.1   Child registrations visible on parent map; late parent regs visible on child

## Phase 18 — Parent/child clone hunt
  goal    Fetch on the parent sees scoped middleware and merged static keys from children
  status  complete

### Track 18.a — Scoped + route()                           [sequential]
  [x] 18.a.1   `use(path, mw)` appends to the shared scoped list (parent fetch runs it)
  [x] 18.a.2   `route(sub)` copies the sub's static map onto the parent

## Phase 19 — Clone/merge hunt continued
  goal    `route()` carries realtime + taps; clones share the route graph
  status  complete

### Track 19.a — Merge leftovers                            [sequential]
  [x] 19.a.1   `route(sub)` merges realtime map/bus and tap handlers
  [x] 19.a.2   `use()` / `basePath` / `context` / `meta` share graph (`routeTree` after clone)

## Phase 20 — Generate pipeline coverage
  goal    `generateAndWrite` + `honey generate` (+ `--watch`) are tested as the Honey layer
  status  complete

### Track 20.a — CLI + write path                           [sequential]
  [x] 20.a.1   generateAndWrite writes tree/manifest/spec/SDK; checksum; errors
  [x] 20.a.2   CLI generate, --app, --watch; jiti no longer caches the app module

## Phase 21 — Per-target production build
  goal    Vite + `createBuildPlugin` emits a runnable artifact for bun / node / deno / cloudflare
  status  complete

### Track 21.a — Build then smoke                            [sequential]
  [x] 21.a.1   Build fixture for each target; hit `/health` and `/openapi.json` on the artifact

## Phase 22 — One serve call
  goal    `app.serve()` binds the process, attaches the runtime WS adapter, and can apply CORS on the instance that fetches
  status  complete

### Track 22.a — Listen + adapter                           [sequential]
  [x] 22.a.1   `app.serve({ port, hostname, runtime? })` for bun / node / deno; CF stays `export default { fetch }`
  [x] 22.a.2   Serve picks `honey/ws/{runtime}` so callers do not import an adapter
  [x] 22.a.3   `serve({ cors: true | CorsOptions })` mounts cors on the listen instance (happy path has no parent/child split)
  [x] 22.a.4   TDD + e2e bun/node/deno switch off hand-rolled `Bun.serve` / `tsx` / `Deno.serve`

## Phase 23 — `honey init`
  goal    A new directory gets an app, vite honey() config, and a serve stub without tribal knowledge
  status  complete

### Track 23.a — Scaffold                                   [sequential]
  [x] 23.a.1   `honey init` writes `src/app.ts` with a health route + `openapi({ docs: "scalar" })`
  [x] 23.a.2   Writes `vite.config.ts` (`honey()` plugin) and a `dev` / `generate` script pair
  [x] 23.a.3   Optional `--cf` stub (`wrangler.jsonc` + worker entry that calls `app.fetch`)

## Phase 24 — Framework README is the package face
  goal    `honey` on npm / GitHub opens on a ten-line start, not the SDK matrix
  status  complete

### Track 24.a — Docs face                                  [sequential]
  [x] 24.a.1   Root README: install, first route, `/docs`, `app.serve()`, curl
  [x] 24.a.2   Move the four-language SDK matrix to `packages/core/docs` (or keep it as a linked page)
  [x] 24.a.3   Published `packages/core/README.md` matches the framework start, links SDK docs

## Phase 25 — `app.serve()` soak
  goal    bun / node / deno listen, abort, close, and bind again; CF stays export `fetch` (Workers cannot listen)
  status  complete

### Track 25.a — Listen soak                                [sequential]
  [x] 25.a.1   bun / node / deno: bind, request, abort mid-body, `close()`, bind again, `port: 0`, `cors: true`
  [x] 25.a.2   `runtime: "cloudflare"` (and workerd detect) still throws the export-`fetch` message — no fake listen
  [x] 25.a.3   CF proof stays `export default { fetch }` + `test:e2e:cf` (local wrangler) + `test:live:cf` (deployed workers.dev)

## Phase 26 — In-process fetch storm
  goal    Hundreds of concurrent `app.fetch` stay correct on validation, errors, scoped middleware, and `route()`
  status  complete

### Track 26.a — Concurrent fetch                           [sequential]
  [x] 26.a.1   Storm happy + validation-fail + typed error paths (local `app.fetch` + live `test:live:cf`)
  [x] 26.a.2   Storm parent/child `route()` and scoped `use(path)` — 404+CORS and child `onError` leftovers
  [x] 26.a.3   No leaked handlers / growing tree epoch / unbounded OpenAPI cache across the storm

## Phase 27 — WS under load
  goal    Many sockets, half-close, close code/reason, reconnect — bun / node / deno / cf
  status  complete

### Track 27.a — Fan-in / fan-out                           [sequential]
  [x] 27.a.1   Many concurrent sockets + broadcast / per-conn send on node listen (bun e2e already covers WS)
  [x] 27.a.2   Half-close, close code/reason, reconnect — parity with existing WS-C / WS-D
  [x] 27.a.3   Deployed workerd: `bun run test:live:cf` storms HTTP + `/api/echo-ws` on honey-cf-e2e

## Phase 28 — Generate `--watch` honesty
  goal    Init → generate → second generate / `--watch` is never stale (jiti + checksum)
  status  complete

### Track 28.a — File layer                                 [sequential]
  [x] 28.a.1   `honey init` then `honey generate` twice with a real route add (not a handler-body-only edit)
  [x] 28.a.2   `--watch` regenerates when the tree checksum changes; ignore `_gen` / `.gen.*`
  [x] 28.a.3   Jiti `fsCache` / `moduleCache` stay off; flake of "generated" log without new routes is gone

## Phase 29 — Bench baseline (after reliability)
  goal    Record the existing bun bombardier matrix vs Hono / Elysia so later perf work has a number to beat
  status  in-progress

### Track 29.a — Record, then chase                         [sequential]
  [x] 29.a.1   Run `bench` json / params / validate / middleware; write numbers + bundle sizes next to `bench/`
  [ ] 29.a.2   Decide: CI opt-in job, or local-only with a checked-in snapshot
  [x] 29.a.3   Keep codegen / Effect off `honey()` — runtime spec is `import "honey/openapi"`
  [ ] 29.a.4   Only then hunt a real cliff (router / middleware / validation) — no rewrite without a delta
