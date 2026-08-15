<!-- MANAGED by workerc — edit content freely but keep the format conventions intact.
     workerc parses step IDs (1.a.1), statuses ([ ] / [x] / [!]), phase/track headers,
     and the metadata lines. /workerc:done marks steps [x], /workerc:status reads progress. -->

# roadmap — honey

  milestone  standalone-ready
  active     4.a.2
  updated    2026-08-13

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
  goal    Remaining work is committed; push and npm stay gated until asked
  status  planned

### Track 4.a — Git + npm                                   [sequential]
  [x] 4.a.1   Commit remaining standalone-ready work
  [ ] 4.a.2   Push `origin/main` (gated — wait for ask)
  [ ] 4.a.3   npm publish `honey` (gated — wait for ask)

## Phase 5 — OpenAPI YAML
  goal    `honey generate` writes OpenAPI YAML equivalent to the existing JSON spec
  status  complete

### Track 5.a — YAML emit                                   [sequential]
  [x] 5.a.1   Serialize the same OpenAPI document as YAML (no second spec)
  [x] 5.a.2   Write `openapi.gen.yml` next to `openapi.gen.json` from CLI + plugin
  [x] 5.a.3   Tests + regenerate example / e2e consumers
