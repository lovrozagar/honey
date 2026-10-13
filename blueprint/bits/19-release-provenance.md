# Bit 19 — release + provenance

Closes: F2 (provenance scope) · packaging
Oracle kept green: `test:packaging` (real tarball + strict consumer typecheck), `test:build` (no optional dep leaks into a worker bundle), `unit/build/*`.

## Scope
Publish both packages and the generated SDKs correctly. Split v0 `plugin.ts` 864 / `build/index.ts` into `core/build/`. Under H9 nothing new is published as a runtime package, so provenance is scoped to the two packages that ship: `@lovrozagar/honey` and `@lovrozagar/honey-codegen` (npm provenance). Generated SDKs carry vendored runtime; their publication is the API author's pipeline, documented.

**core/build is a build-time consumer of `honey-codegen` (H18.5).** `build/plugin.ts` calls `generateTypes` and `generateRouteTree*` (homed at `gen/emit/ts/{type-gen,route-tree}.ts`), so it imports `@lovrozagar/honey-codegen` on the build path. This does not violate H1's lean *runtime* core — it is a `devDependency`/build-time import, never shipped to a serving request — but it is stated here so the dependency is explicit. (Alternative considered: move the build plugin to `honey-codegen`; rejected because `honey()` apps call `honey/plugin` by convention.)

**Cutover + real `prod` e2e (H14/H21).** The atomic workspace swap lands here (`_v0` leaves `workspaces`, `packages/core` joins as `@lovrozagar/honey`), and this bit owns the consumer e2e passing identically against v1. v0's `--mode prod` was a no-op grep swap (verified bit 00; `prod ≡ dev`, `cf` always local); v1 makes it real: `prod` builds each app and drives the full Playwright suite against the **served built bundle** (request-time parity of the shipped artifact — beyond `test:build`'s import smoke), and `cf prod` deploys a worker (CF creds, CI). Re-record `blueprint/baselines/e2e-expected.json` against v1, move the 5 `cf-prod` cells to CI, and add the ≥1 genuine `@prod-only` assertion that makes `prod` distinct from `dev`.

## Files (from files.tsv — core `build`)
- `src/build/{index,plugin,targets}.ts` (+test each), `src/build/cli.ts`/`cli-args.ts` (+test), `src/build/{glob,yaml}.ts` (+test).
- release config: exports map, `files`, peer/optional-peer declarations (ts-morph, ws) per `00-rules.md`.

## Tests (named, written first)
- `build/packaging.test.ts` — the packed tarball type-checks under a strict consumer with every flag on.
- `build/runtime-bundle.test.ts` — no optional peer (ts-morph/ws) leaks into a worker bundle.
- `build/targets.test.ts` — node/bun/cf build targets only (no Deno, H15).
- `build/provenance.test.ts` — npm provenance attached for both published packages; no third runtime package exists.
- `build/conformance-gate.test.ts` — no SDK/CLI/MCP artifact publishes while any cell of the conformance matrix is red (`dx/conformance.md`): compile + golden + behavioral-parity-vs-reference-server all green for every target.
- the 30-cell e2e matrix passes against v1 with `prod` = served built bundle (a `@prod-only` cell asserts built-bundle-only behavior), `cf prod` = deployed worker; `e2e-expected.json` re-recorded against v1.

## Security corpus
- supply chain: the shared fuzzed string-escape layer (F2) is the single injection backstop; dependency pin audit.

## Budget
- perf: build time within threshold.
- size/token: the vendored runtime glue template per language (`gen/runtime/<lang>/*`) has a byte budget, and emitted SDK types must share components across operations (no per-op re-inlining) — both bound shipped SDK size and the agent-token surface (gated with H6). A bloated template or un-deduped types fails the gate.
