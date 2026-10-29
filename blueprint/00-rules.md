# 00 — Construction rules

Both packages (`@lovrozagar/honey` = `packages/core`, `@lovrozagar/honey-codegen` = `packages/gen`) obey these rules. Where a rule differs by package it says so.

## What "done" means for a file

A source file is done when all of the following hold:

1. Its row is in `files.tsv`, with the bit that gave birth to it.
2. Its sibling test exists, was written first, and was seen failing before the source satisfied it.
3. The bit lists every case the test covers.
4. Coverage for that file is 100% lines, branches, functions, and statements.
5. The file respects the limits and the environment rules below.
6. If the file emits target-language source (a codegen emitter), its output passes that language's formatter (see "The formatter post-pass").

The commit that adds the source also adds the test. `main` stays green. The failing run happens in the working tree before the source is written, recorded in the commit message (`red: <test name>`).

## Where tests live

v1 adopts flare's layout; v0's detached `tests/unit/**` and session-dump names (`bug-hunt-2..21`, `client-edge-cases-2..5`, `edge-cases`, `core/edge-cases-2..10`, `codegen/type-emitter-debug2..5`) do not come back.

Unit tests sit next to the file they exercise, in both packages:

```
packages/core/src/cookie.ts
packages/core/src/cookie.test.ts
packages/gen/src/emit/go/client.ts
packages/gen/src/emit/go/client.test.ts
```

`files.tsv` lists both. A `src` or `lint` or `script` row with no sibling test row is a blueprint error.

These files have no sibling test, and coverage excludes them:

- `kind = index` — a folder's `index.ts` or an `src/exports/*.ts`: only `export { ... } from "./..."`. A structure test fails the build if any other statement appears.
- `kind = types` — `import type` / `export type` only. A value export moves the file to `kind = src` and adds a test.
- `kind = app` — a `tests/e2e/apps/*` consumer app, exercised by the e2e matrix named in its bit, not by a unit sibling.
- `kind = corpus` — data read by the sibling test of a module (fixtures, adversarial specs).

Tests that boot a server, a runtime, or a language toolchain span many files. They live under each package's `tests/` as rows of `kind = test`, and they do not replace unit siblings:

- `packages/core/tests/integration/*` — **feature-named** suites (`auth`, `routing`, `middleware`, `streaming`, `cookies`, `cors`, `errors`, `proxy`, `static`, `realtime`, `validation`, `i18n`, `telemetry`, `trust`, …) that together give 100% feature coverage of core as integrations. A case is homed by the feature it exercises, never by the session that found it.
- `packages/core/tests/e2e/apps/*` + `tests/e2e/run.ts` — the 5 consumer apps and the 30-cell runner (the oracle; see "The oracle").
- `packages/core/tests/types/*` — type-level tests.
- `packages/core/tests/regression/*` — the frozen 313-finding guard. Names are kept stable for traceability to `packages/core/docs/regression-matrix/`.
- `packages/gen/tests/integration/*` — the SDK harness, polyglot compile/runtime/conformance, MCP and CLI harnesses.

## Coverage

Vitest, `@vitest/coverage-v8` (v0 ran no coverage gate; v1 adds it).

- Include: `packages/{core,gen}/src/**`.
- Exclude: `**/*.test.ts`, `**/*.d.ts`, `**/index.ts`, `**/__fixtures__/**`, **`packages/gen/src/runtime/**`** (the vendored SDK templates — never executed by vitest; package-scoped, so `packages/core/src/runtime/*` stays covered), and the type-only files (`routing/types.ts`, `emit/ts/types.ts`, `emit/mcp/types.ts` and any `kind=types` row — `import type`/`export type` only, zero statements). There is no `src/exports/**` (H18/round-2: subpaths map to module files, no exports folder).
- Thresholds, per file: lines 100, branches 100, functions 100, statements 100.
- `v8 ignore` is forbidden; the lint rule rejects the comment. Uncovered code is deleted or given a case.
- A branch that can run only inside one runtime (node/bun/cf) is written so the decision function is pure and covered under the default runner; the runtime test proves the adapter calls that function. No file depends on a non-default runtime for its coverage number.

Oxlint turns on the vitest rules that reject a test with no assertion, a conditional assertion, and a focused or skipped test.

## TDD inside one file

For each case in the bit, in the order the bit lists them: add the `it(...)`; run it and see it fail; write the smallest source that passes; re-run the file's tests. A case not in the bit is not added. A branch that exists only to satisfy coverage, with no case in the bit, is not added.

## How a file is shaped

A file has one reason to exist, and that reason is the responsibility column in `files.tsv`. When a second reason appears, the blueprint gains a new row and the code goes in the new file. The v0 shapes that made code hard to read — deep nesting, a flag that changes the meaning of the rest of a function, a function that both decides and performs I/O, the 2,600-line `Honey` class — are split: a pure decision function with a table of cases, and a caller that performs the I/O.

Comments are for a constraint the code cannot show: a security reason, a platform bug, a pitfall named in `dx/`. A comment that restates the next line is deleted.

## File limits

| | |
| --- | --- |
| Source file | 300 lines |
| Test file | 500 lines |
| Function | 60 lines |
| Cyclomatic complexity | 15 |
| Parameters | 3, plus one `ctx` object when a function needs more |
| Nesting depth | 4 |

A file that would pass a limit by growing is split in the blueprint first: new row, new sibling test, then code. Names are kebab-case files, camelCase functions, PascalCase classes and errors. No file named `utils`, `helpers`, or `misc`. No barrel `export *`.

## Environments

`packages/core` targets the Fetch platform and must run on Node, Bun, and Cloudflare Workers from one source. Deno is removed in v1 (bit 00).

| folder | may use | must not use |
| --- | --- | --- |
| `src/` (portable core) | ECMAScript, `URL`, `TextEncoder`, `Request`/`Response`/`Headers`, Web Streams, `crypto.subtle` | `process`, `Buffer`, `node:*`, `Bun`, DOM globals |
| `src/adapters/node/` | portable core, plus `node:*` | `Bun`, Workers-only globals |
| `src/adapters/bun/` | portable core, plus `Bun` | `node:*` builtins beyond what Bun polyfills, Workers-only globals |
| `src/adapters/workers/` | portable core, plus Workers runtime | `node:*`, `Bun` |
| `packages/gen/src/` | Node (it is a build-time tool) | runtime coupling to a served request |

Runtime detection (`detect-runtime`) returns a pure value; adapters branch on it. A portable-core file never imports an adapter. `ts-morph` is imported only by the type-extraction entry of `honey-codegen`, and `ws` only by the Node WebSocket adapter — both optional peers (see Dependencies).

## Dependencies

`@lovrozagar/honey` keeps its runtime lean. Required runtime deps stay minimal; a library the package imports conditionally is an **optional `peerDependency`** with `peerDependenciesMeta.optional = true`, and a `devDependency` pinned to the exact tested version.

| package | role | manifest | devDependency (exact) | peerDependency | imported from |
| --- | --- | --- | --- | --- | --- |
| `jiti` | runtime dep | core | 2.7.0 | — | config/plugin loading |
| `ws` | optional peer | **core** | the exact tested version | `>=` that version | the Node WebSocket adapter only |
| `ts-morph` | optional peer | **gen** (not core) | the exact tested version | `>=` that version | `honey-codegen` type-extraction entry only — `honey/boundaries` keeps it out of core |
| `oxfmt` | optional peer | **gen** | the exact tested version | `>=` that version | `honey-codegen`'s CLI only, imported lazily for the TS post-pass (Q12); absent, TS goes out as emitted |
| `@lovrozagar/honey-codegen` | optional peer | **core** | `workspace:*` | `>=` the release | `src/build/` only, through `import()` or a type-only import (Q2) |

(Exact dev versions are filled from the repo's lockfile at bit 00; the shape — exact dev + `>=` peer — is the pin.) `@lovrozagar/honey` declares `"sideEffects": false` for tree-shakeability (H19.3) — the whole runtime is side-effect-free, including `trust` (plain core code, no self-registration).

**Runtime floor (H19.2):** Node ≥ the first LTS with stable `fetch`/WebStreams/`crypto.subtle` (Node 20), Bun ≥ the tested version, Cloudflare Workers = current. Deno is not a target (H15).

Generated SDKs do **not** add a honey runtime package: the runtime glue is vendored inline into each SDK and depends on that ecosystem's standard transport/JSON lib by version-range floor — TS `fetch` (platform), Python `httpx2`, Go `net/http` + a WS lib, Rust `reqwest`+`tokio`+`tokio-tungstenite`, C# BCL only, Java `java.net.http`+Jackson. Each floor is pinned in the emitter's bit. See `01-decisions.md` (H9, H19.1) and `03-surface.md`.

## Toolchain resources (polyglot harness — memory & tmp hygiene)

The SDK/CLI/MCP conformance + compile tests run real language toolchains (go, cargo, dotnet, javac/gradle, python). On this machine **`/tmp` is a RAM-backed tmpfs** — writing build artifacts there consumes memory, not disk. The harness must therefore:

- **Never write build/target/cache dirs to `/tmp`** (a RAM-backed tmpfs with a per-user quota here — concurrent sessions hit `EDQUOT`). Toolchain output goes on real disk: `CARGO_TARGET_DIR`, `GOCACHE`/`GOPATH`, `DOTNET_CLI_HOME`, Gradle `GRADLE_USER_HOME`/`--project-cache-dir`, generated SDK scratch, and `TMPDIR` all point at a directory **outside any git checkout** — use **`$HOME/.cache/honey-tmp/<area>`**, not an in-repo `.cache/` (oxlint applies a checkout's `.gitignore` even under `--no-ignore`, so an in-repo `TMPDIR` makes spawned-oxlint lint nothing; the harness throws if `TMPDIR` is inside a checkout). v0's `.cache/cargo-target` convention moves there too.
- **Bound parallelism.** Do not compile all six languages at once on a ~30 GB box — the toolchain matrix runs serially (or 2 at a time max), one language's conformance run completing and **cleaning its artifacts** before the next starts.
- **Delete-or-wait on pressure.** A harness step checks free memory/disk before a heavy compile; if low, it cleans the previous language's `.cache/<lang>` and waits rather than piling on. The harness is opt-in (`test:harness`), never part of `bun run test`.
- These toolchain tests are CI/opt-in; `.cache/` is gitignored.

## Module state (H19.3)

A module-scope `let`, mutable map, or cache is forbidden unless the line carries `// per-process-constant: <reason>` and the reason is on the allowlist: the RAW_BODY `WeakMap` (`response`), the `TextEncoder`/`TextDecoder` singletons, the rate-limit default store, the i18n `dict` cache, the build id. The `honey/no-module-state` lint rule rejects anything else; `honey/no-module-side-effects` keeps the runtime tree-shakeable. Request state lives on the request context, never module scope.

**No self-registering entries, no feature registry, no DI threading (ruled bit 03).** An optional capability is just ordinary code reached through an ordinary import — never a module that registers itself on import, never a global slot registry. `trust` is the example: it is plain core code (`app.trustProxy(value)` stores config; `ctx.ip`/`clientInfo` call a pure `resolveClient(req, config)` imported normally). Features reached through an explicit user import (`proxy()` middleware, the ws/realtime adapters) tree-shake via ordinary dead-code elimination with no registry. Trust costs ~1 KB gz in core, which is not worth any opt-in machinery.

## The formatter post-pass

honey-codegen emits target source by structured string assembly guarded by the `codegen-lang` sanitizer (no AST for emission — see `01-decisions.md`). Every emitter runs its language's canonical formatter as a post-pass before the output is considered done: gofmt, rustfmt, ruff (or black), `dotnet format`, google-java-format, oxfmt for TS. The pass is mandatory in publish CI so every shipped SDK is formatter-clean; pure-JS generation (a worker with no toolchain) emits valid-but-unformatted code as a documented fallback. Type **extraction** is the exception that uses a real AST (the TypeScript compiler API via ts-morph) because resolving types needs the checker.

## Gates that exist from the first source file

`bun run typecheck`, `bun run lint` (oxlint), `bun run fmt:check` (oxfmt), `bun run test`, the coverage thresholds, a tree check, and the boundary lint (the import arrows above). The **tree check is phase-aware** (H19.4, three-tier): reading the `COMPLETE` constant, **completed bits (`≤ COMPLETE`) must be whole** (every row present, a missing one fails), **the in-progress bit (`COMPLETE + 1`) may land file by file** (its files are neither required-whole nor flagged `early`, so each TDD'd file is its own green commit), and **anything beyond (`> COMPLETE + 1`) is `early`** and fails. A file born in a not-yet-active later bit being absent is not a failure; a file appearing more than one bit early is. The completing change flips `COMPLETE`, enforcing that bit whole from then on. Its **scope** is `packages/core/{src,tests,lint}` + `packages/gen/{src,tests}` + the e2e support files under `packages/core/tests/e2e/`, plus the `files.tsv` config/infra rows (manifests, configs, baselines) — **not** the whole repo (`_v0/**` is excluded by H21; `docs/`, `examples/`, `scripts/` beyond listed ones, `bin/`, CI workflows, and stray `bench/**` are out of scope unless they have a row). Lint is all oxlint, run by `bun run lint`: (a) the standard rules (`typescript`, `unicorn`, `oxc`, `vitest` — no-empty/conditional/focused-test, style); (b) the **custom `honey/*` rules as oxlint JS plugins** — `packages/core/lint/<name>.js` rule modules wired in via `.oxlintrc.json` `"jsPlugins": [{ "name": "honey", "specifier": "./lint/<entry>.js" }]`, each with a `lint/<name>.test.ts` that unit-runs the rule (via `oxc-parser`) and spawns oxlint with `jsPlugins` on a fixture. This is the real flare pattern (verified: `flare/packages/core/lint/*.js` + its `.oxlintrc.json` `jsPlugins`; honey's oxlint `^1.78.0` loads a TS/JS rule module and reports `honey(<rule>)`) — **not** a vitest tree-scan. So the per-step `bun run lint` enforces them and editors flag violations live. The custom rules, from the first file: `no-v8-ignore`, `boundaries` (the import arrows; one named exception — the serve dispatcher `src/adapters/serve.ts` may reach a per-runtime adapter through **dynamic `import()` only**, so `serve()` code-splits node:*/bun out of the other runtimes' graphs; a static import from it, and any reach from any other file, static or dynamic, is still an error, bit 04), `no-console` (only `telemetry/logger.ts`), `no-module-state` + `no-module-side-effects` (H19.3), `content-type-exact-essence` (ban `startsWith` on a media type — H18.2), `no-header-mode` (no request header selects an internal mode — H19.7). They exclude `_v0/**` (v0 keeps its console calls + module state until cutover). `bun run test` does not start the browser matrix or the language harnesses.

**Per-step cadence (mandatory).** After **every** step — every TDD case, every leaf, every bit — run, in order, `bun run fmt` → `bun run lint` → `bun run typecheck`, and they must all be clean before the next step starts. Not just at the end of a bit: a broken type or lint error never rides into the next step. A bit is not complete while one of its named tests is red or any of fmt/lint/typecheck is red. **Write a custom invariant check whenever something is better enforced mechanically than caught in review** — as an oxlint JS-plugin rule: a `lint/<name>.js` rule module (wired through `jsPlugins`) plus its `lint/<name>.test.ts`. The seven above are the starting set; add more as the rewrite surfaces invariants worth pinning (each is a `lint/<name>.js` + `lint/<name>.test.ts` pair of rows in `files.tsv`, enforced by `bun run lint`).

## The oracle

v0's suite is the pass/fail oracle v1 is held to. e2e must pass **identically**; unit tests are updated only for file splits or a TDD bug-fix.

- **e2e matrix (30 cells):** `tests/e2e/run.ts` over 3 runtimes × 2 modes × 5 apps — node / bun / cf × {dev = source, prod = built bundle} × {compose, defaults, gateway, kitchen, surface}. `cf dev` = wrangler/miniflare local; `cf prod` = deployed worker (CF creds in CI). No Deno cell.
- **consumers:** `bun run test:consumers` (the per-app smoke tests).
- **differential / builds:** `tests/e2e/differential.ts`, `tests/e2e/builds.ts`.
- **unit + regression:** every colocated unit test and the frozen `tests/regression/*` (313-finding guard) stay green.
- **observability matrix:** the 96-combination `telemetry/observability-matrix.test.ts` (H17) is green — every logger/onError/requestLog/tracer/trustProxy × dev/prod combination behaves per `dx/observability.md`, with no private field leaked.
- **consumer-pinned cases:** a response-returning `app.onError` (returns a `HoneyError` with status + header + i18n) and a `trustProxy`-off `requestId` (inbound id not reused) stay green — anyrow depends on both (`dx/observability.md` → "Consumer-pinned cases").
- **SDK conformance matrix:** every feature × every target (ts/go/rust/python/csharp/java/cli/mcp) is green against the live reference server — compile + golden + behavioral parity (`dx/conformance.md`). A target missing a feature row, or a row whose decoded result/wire diverges between languages, fails CI; no SDK ships with a red cell (bit 19).

The baseline count lives **in version control** at `blueprint/baselines/oracle-baseline.txt` (and `perf-baseline.txt`) — not gitignored `.tmp/`, so the number v1 is held to can't vanish. A **`tests/structure/oracle-count.test.ts`** asserts the global `passed`/`skipped` totals against that committed baseline and fails on drift — including a **silently skipped** test that lowers the count with no red (the number, not just a human diff, is the gate). The baseline steps once (6767→6768) when bit 19 fixes the `cli-generate` port flake; that step is a committed baseline change with a reason, not silent. The 30-cell e2e matrix's per-cell expected pass set is captured on CI (needs the per-runtime toolchains) and committed beside the baseline; bit 00 records the command + the expected set so "pass identically" has a number to compare.

## Token budget gate (H6)

The agent-token metric is measured and enforced, not asserted.

- **What is measured, per operation:** the emitted MCP tool schema (`inputSchema` + `outputSchema`), and the SDK + CLI help/signature for that operation (the surface an agent must read to call it once).
- **Tokenizer (pinned):** a committed, vendored tokenizer with its own `files.tsv` row — `o200k_base` (the GPT-4o/Claude-era BPE, via a pinned `gpt-tokenizer`/`tiktoken` build at an exact version). Run over the generated artifacts so a count is reproducible across machines. Pinning the *tokenizer* is a spec act (done here); the *number* is captured from v0 in bit 00.
- **Threshold (method pinned; number captured in bit 00):** a per-operation token ceiling set by running the pinned tokenizer over v0's **current** emitted MCP tool schema + SDK/CLI help, taking the max per operation + ~15–20% headroom, recorded in the committed baseline (`blueprint/baselines/`). Provisional starting ceilings to confirm against that capture: **~400 tokens for the MCP tool schema** (`inputSchema`+`outputSchema`, the strictest — bit 18), and a looser per-operation SDK+CLI-help ceiling. Plus the runtime-template byte budgets and the shared-component dedup invariant (bit 19). Capture + number owned by **bit 00** (then MCP ceiling enforced in bit 18).
- **How CI fails:** the token gate runs in the generate/test pipeline; an operation over its ceiling fails the build with the operation id and the overage. Lowering a schema's size (flatter types, shared components, terser descriptions) is the fix, never raising the ceiling without a decision.
- **Also gated (bytes, not per-operation tokens):** the vendored runtime glue template per language (`gen/runtime/<lang>/*`) has a size budget, and SDK type output must share components across operations (no re-inlining a schema per op). Both bound the shipped SDK size and the agent-token surface; a bloated runtime template or un-deduped types fails the gate.

## Security gate (H7, F1)

Runs as a per-bit CI gate, not a one-off review. Legitimate defensive testing of our own framework.

- **Advisory corpora:** known hono / elysia / express advisory classes, replayed as cases (path traversal, header injection, request smuggling, CORS credential reflection, CSP bypass, prototype pollution, SSRF via proxy, cookie forgery) — plus the round-2 additions: **compression side channel (BREACH)**, **rate-limit store growth (key-spray OOM)**, **MCP path-param traversal** (agent tool input with `/`/`..`/`%2f`), **WS same-origin scheme-downgrade** (`http` origin vs `https` host), and **webhook-verify timing** (asserted constant-time structurally, since timing can't be fuzzed).
- **Fuzz targets:** the pattern parser, the router/tree, the cookie codec, the SSE/WS parsers, the YAML/JSON emitter, and the one shared string-escape layer (F2) every emitter inherits. **The escape-layer fuzz oracle (pinned):** for a random input string, the emitted literal must (a) round-trip through the target language's own lexer/parser back to the original bytes, (b) be provably closed (no way to end the literal early) and (c) contain no control/escape sequence the spec text didn't ask for. Seed is fixed and logged; ≥10⁶ iterations per target in CI (the re-homed `rng.ts` harness). A failure prints the seed+input to reproduce.
- **Named corpus classes get concrete assertions, not just names:** CSP-bypass, prototype-pollution-via-keys, header-injection/response-splitting, and proxy SSRF/host-spoof each have an explicit input→expected-rejection case in the bit's Tests (not a bare list), so the gate can fail. Failing-input-first is reinforced by a **mutation check**: the suite is run once with each guard disabled and must go red, proving the guard is load-bearing (not just a test that passes regardless).
- **The adversarial probe harness:** an in-process `app.fetch` regression suite (not a standalone network tool) — scope-bypass via path normalization, prototype pollution, CORS credential reflection, SSE/WS memory growth, header injection, rate-limit bypass. Scaffolded in bit 00; every middleware bit adds its cases.
- **Failing-input-first:** each case is written as a failing input before the guard exists; the guard makes it pass. A removed guard re-reds its case.

## Perf gate — no regression, and we benchmark

honey's own benchmarks must not regress. A +25% threshold is **not** acceptable as a regression ceiling — a real 20% slowdown would pass silently. The problem the inherited +25% papered over is measurement noise, not tolerance: three back-to-back `hotpath.ts` runs on one machine jittered up to ~15–17% per scenario (`param` 2.17→2.41→2.54; `chain` 3.17→2.75→2.84; `static` 1.97→1.86→1.68), and the committed baseline is off-machine (measured `chain` 3.17 vs baseline 2.57). You cannot gate tightly on a noisy signal; v1 fixes the signal first, then tightens the number. Baseline: `.tmp/grunt/v1-perf-baseline.txt` + `bench/hotpath-baseline.json`.

1. **Cut the noise, then tighten.** Increase iterations and interleaved samples, discard warmup, and run the gate on a **pinned CI runner** with CPU affinity (`taskset`) and turbo disabled, so same-runner run-to-run jitter drops to low single digits. Re-record the baseline on that runner (the current one is stale/off-machine).
2. **CI ceilings (bit 20 e3).** Every bench (hotpath, finalize, streaming, websockets, adapter) is v1 as a ratio to a raw twin on the same machine, judged in CI against `blueprint/baselines/bench.json` on the median of its 3 pass medians, the passes interleaved across the bench's scenarios and each round held to at least 2.6 s (the longest CI burst seen, 1.72 s, plus 50%), so a runner burst inflates one pass, not the measurement (bit 21 k-pass; `bench/src/gate.ts`): the baseline is the median of 6 green CI runs, the ceiling the worst × 1.10, and the note states each scenario's sensitivity (`catches`). One CI run, no retry; a scenario whose CI spread is too wide to catch its own slowed mutant is `reportOnly`; one bimodal by a per-process level of its raw twin gates only when its record set holds both levels, with its reason naming them. (The earlier local +10% significance gate never held off-machine; the bit-01 scenario list it named lives on in hotpath.)
3. **Steady-state throughput is the authoritative absolute gate.** `bench/src/run.sh` (honey vs hono/elysia/express/nest, naked+zod, bun+node, json/params/validate/middleware, bombardier 10s × 100 conns) is far less noisy than a 50k-iteration microbench; it carries the tight honey-vs-its-own-v0 gate in CI (`bun run bench`, `bun run bench:node`). `hotpath.ts` stays the cheap per-PR structural tripwire.
4. **No silent drift.** A baseline moves only by record-mode CI runs (dispatch ci.yml with `bench_mode=record`; their RATIO lines collected; a record run refuses any scenario whose pass medians spread past `SPREAD_TOLERANCE`, 0.5, and such a scenario is fixed in its bench, never recorded) and a committed bench.json with its run ids and a one-line reason, reviewable in the diff.

**Current state and the capture act (bit 00, previously unassigned).** Today the gate is partly inert: only 5 of the 11 scenarios have a committed baseline (the other 6 read `limit = +Infinity` and can't fail), the baseline is off-machine, and `hotpath.ts` still compares a median to `base*(1+0.25)` — the confidence-interval/significance logic in step 2 is **not yet implemented**. **Bit 00 owns making it enforceable:** implement the significance test in `hotpath.ts` (median + sample stddev → fail only when the regression exceeds both +10% and the CI band), add the **finalize-cost bench** (a separate script measuring `_resolve`'s O(routes×scopes) scan — the warm per-request loop can't), capture all 11 scenarios × both bun minors on the pinned CI runner (`taskset`, turbo off), flip `HOTPATH_THRESHOLD` 0.25→0.10, and commit the baseline to `blueprint/baselines/` (not gitignored `.tmp/`). Until that act runs the gate is advisory — stated so no one mistakes a green run for a tight gate.

Per-bit coverage: bit 01 pure route-model cost (match/tree only — no `app.fetch`, so no hot-path ratio runs here), bit 02 the routing hot path + dispatch/finalize + middleware compose (where the 11-scenario gate first activates), bit 04 adapter overhead, bit 05 streaming throughput/abort, bit 07 each middleware's per-request cost. Splitting the `Honey` god-class into pure decision functions must hold or improve the ratios — v0 already removed per-request middleware allocation by compiling chains at finalize, and v1 keeps that.

**Observability must cost nothing unconfigured (H17):** a dedicated `telemetry/bench-observe` serves the minimal app with (a) nothing configured, (b) logger at info + request log off, (c) logger + request log, (d) logger + a no-op tracer. The unconfigured run stays within **2%** of the pre-observability baseline; a regression fails the bit. The default logger checks the level before building fields, and no span object exists without a tracer.
