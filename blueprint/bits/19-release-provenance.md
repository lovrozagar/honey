# Bit 19 — release + provenance

Closes: F2 (provenance scope) · packaging
Oracle kept green: `test:packaging` (real tarball + strict consumer typecheck), `test:build` (no optional dep leaks into a worker bundle), `unit/build/*`.

## Scope
Publish both packages and the generated SDKs correctly. Split v0 `plugin.ts` 864 / `build/index.ts` into `core/build/`. Under H9 nothing new is published as a runtime package, so provenance is scoped to the two packages that ship: `@lovrozagar/honey` and `@lovrozagar/honey-codegen` (npm provenance). Generated SDKs carry vendored runtime; their publication is the API author's pipeline, documented.

**core/build is a build-time consumer of `honey-codegen` (H18.5).** `build/plugin.ts` calls `generateTypes` and `generateRouteTree*` (homed at `gen/emit/ts/{type-gen,route-tree}.ts`), so it imports `@lovrozagar/honey-codegen` on the build path. This does not violate H1's lean *runtime* core — it is a `devDependency`/build-time import, never shipped to a serving request — but it is stated here so the dependency is explicit. (Alternative considered: move the build plugin to `honey-codegen`; rejected because `honey()` apps call `honey/plugin` by convention.)

## Files (from files.tsv — core `build`)
- `src/build/{index,plugin,targets}.ts` (+test each), `src/build/cli.ts`/`cli-args.ts` (+test), `src/build/{glob,yaml}.ts` (+test).
- release config: exports map, `files`, peer/optional-peer declarations (ts-morph, ws) per `00-rules.md`.

## Tests (named, written first)
- `build/packaging.test.ts` — the packed tarball type-checks under a strict consumer with every flag on.
- `build/runtime-bundle.test.ts` — no optional peer (ts-morph/ws) leaks into a worker bundle.
- `build/targets.test.ts` — node/bun/cf build targets only (no Deno, H15).
- `build/provenance.test.ts` — npm provenance attached for both published packages; no third runtime package exists.
- `build/conformance-gate.test.ts` — no SDK/CLI/MCP artifact publishes while any cell of the conformance matrix is red (`dx/conformance.md`): compile + golden + behavioral-parity-vs-reference-server all green for every target.

## Security corpus
- supply chain: the shared fuzzed string-escape layer (F2) is the single injection backstop; dependency pin audit.

## Budget
- perf: build time within threshold.
- size/token: the vendored runtime glue template per language (`gen/runtime/<lang>/*`) has a byte budget, and emitted SDK types must share components across operations (no per-op re-inlining) — both bound shipped SDK size and the agent-token surface (gated with H6). A bloated template or un-deduped types fails the gate.
