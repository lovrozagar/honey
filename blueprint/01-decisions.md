# 01 — Decisions

Every product decision for v1. An agent does not re-open one here by preference; it changes only on new evidence or a flaw found, recorded as a revision line. Decision ids are `H<n>`. Deep-dive gaps (`A1`–`F2`) are transcribed in the last section, each owned by a bit.

When a decision and `dx/` disagree, `dx/` wins and the decision is corrected in the same change.

---

## H1 — Two packages, one monorepo

`@lovrozagar/honey` (`packages/core`) is the server framework you write an API in; it emits the OpenAPI document and the IR. `@lovrozagar/honey-codegen` (`packages/gen`) takes any `openapi.json` (3.x) and generates SDKs, the CLI, and the MCP server. Dir names stay `core` / `gen`; only the published names are set.

Named `honey-codegen`, not `honey-gen` or `honey-clients`: `clients` misdescribes the MCP **server** output and names the tool after its product; `codegen` is the conventional, accurate term (cf. `openapi-generator`).

**Rationale.** v0 proved the value is in the generation. Splitting lets the generator run against any OpenAPI document, not only honey's, and keeps the server framework lean. One monorepo keeps them released and tested together.

## H2 — The IR is the seam

`packages/core` emits OpenAPI + the IR; `packages/gen` consumes the IR and never reaches into core internals. Every emitter reads only the IR (true since v0 commit `7c50656`). This is the boundary the core→codegen move respects.

## H3 — Core→codegen tooling move

These v0 `packages/core/src` files/dirs move to `packages/gen` (they are generation, not server): `codegen.ts`, `codegen-ir.ts`, `codegen-lang.ts`, `codegen-go.ts`, `codegen-rust.ts`, `codegen-python.ts`, `codegen-go-cli.ts`, `codegen-route-tree-intern.ts`, `codegen-mcp.ts`, `codegen-hash.ts`, `codegen-load.ts`, `codegen-loaders.ts`, `codegen-sanitize.ts`, `codegen-schema-naming.ts`, `codegen-sdk-model.ts`, `go-type-emitter.ts`, `python-type-emitter.ts`, `rust-type-emitter.ts`, `ts-type-emitter.ts`, `type-emitter.ts`, `type-extractor.ts`, `gen-process.ts`, `gen-write.ts`, and the `client/`, `client-go/`, `client-rust/`, `client-python/`, `client-mcp/`, `cli-go/` dirs; with their tests (`unit/codegen/*`, `unit/sdk/*`, `integration/sdk-harness/*`, `regression/ws9-12/*`, conformance). Core keeps OpenAPI emission (`openapi/`) and the IR builder. Nothing valuable is lost — it is relocated and re-organized. The exact per-file home is in `files.tsv`.

**Timing (corrected — the move is NOT a bit-00 act).** v0 `codegen.ts` imports core internals (`index`, `errors`, `meta-spec*`, `pattern`, `tree`, `types` — verified), and `type-extractor` imports `pattern`, so a mechanical move at bit 00 would fail bit 00's own `boundaries` rule and the gen rows are bits 09–18 anyway. So: **bit 00 creates only the `packages/gen` skeleton** (manifest, tsconfig, vitest, `_tokenizer/`, the oxlint plugin wiring). Each `gen` module is written in its own bit (09 IR/schema/extract, 10 openapi emit, 11–18 emitters), reading only the IR. The v0 codegen/client/cli exports (`./codegen`, `./client`, `./client/sdk`, `./cli`, `./codegen-go-cli`, `./codegen/extract`) stay pointed at `_v0` until the bit that rebuilds each lands (H21 cutover). "Reads only the IR" holds because the v1 gen modules are written against the IR from the start — v0's internal-importing `codegen.ts` is never moved, it is superseded and deleted with `_v0` at bit 20.

## H4 — Tests are the oracle; DX does not change

v0's 6,764 e2e/integration tests plus the 313-finding regression matrix are the pass/fail oracle. e2e must pass **identically**; unit tests are updated only for file splits or a TDD bug-fix. DX does not change unless a recommendation here is approved. The exact oracle is frozen in `00-rules.md` ("The oracle") and the baseline count in `.tmp/grunt/v1-oracle-baseline.txt`.

## H5 — C#/.NET and Java are first-class

Both are emitter bits from the start (15, 16), not deferred. Stacks in H9.

## H6 — Token budget is a gate

"How well agents use the API for how few tokens" is a measured metric, not a slogan. Measured per operation across the MCP tool schemas and the SDK/CLI help, with a tokenizer and a per-operation threshold that fails CI. Full definition in `00-rules.md` (token-budget section, plan step 7.1).

## H7 — Security is a per-bit gate

Fuzz corpora + an in-process `app.fetch` adversarial regression suite run as a CI gate per bit, not a one-off review. This is legitimate defensive testing of our own framework. Full definition in `00-rules.md` (security-gate section, plan step 7.2) and every middleware bit. Reframed from v0's standalone network attack-client to an in-process suite.

## H8 — Realtime: keep and fix, do not build or cut

`x-realtime` is a reachable opt-in via `.meta({ extensions: { "x-realtime": true } })` (verified) — the resume client stays. Verified: the generated clients already do SSE and WebSocket in all four current SDKs (TS `client/ws.ts`+`sse.ts`; Go `client-go/ws.go`+`sse.go`+`realtime.go`; Rust `client-rust/ws.rs`+`sse.rs`; Python `_ws.py`+`_sse.py`). So realtime is fix-not-build.

Gaps closed in v1 (bit 06): (1) the declared SSE event schema does not fully reach the SDK types — fixed by the same "declared schema reaches the generators" principle as the response model (H10); (2) `Last-Event-ID` reconnect/resume is not uniform across SDKs — made parity across all; (3) no reference resume server exists to test against — ship one as a conformance target. New C#/Java SDKs reach the same SSE + WS + reconnect parity.

**Revision.** An earlier session called the resume layer "dead surface"; that was wrong — consumers opt in via `.meta({})`. Recommendation reversed to keep + fix.

## H9 — SDK runtime: vendored inline, no runtime packages

The runtime glue is vendored inline into each generated SDK, depending on that ecosystem's standard transport/JSON lib by version range: TS fetch, Python httpx, Go net/http, Rust reqwest, C# System.Text.Json, Java Jackson. No per-language `honey-runtime` package is published.

**Rationale.** This is what the gold-standard generated SDKs do (Stainless/OpenAI vendor their base client; no shared runtime package on PyPI/npm). A dependency CVE is patched by bumping that standard lib the vendored code already depends on by range — so vendoring loses nothing there. A published runtime would add N release/provenance pipelines and a runtime↔surface version matrix for no CVE benefit. Closes gap **C3** as working-as-intended; reduces **F2** to one shared, fuzzed string-escape layer across emitters (nothing new is published, so no package provenance).

**Revision.** An earlier proposal was "publish a semver'd runtime per language with a `--vendored` fallback." Flawed on two counts — the dependency-CVE argument is already handled by version ranges on vendored code, and the cited gold standard actually vendors. Reversed to vendoring.

## H10 — Response model: open media types, typed headers, request binary (A1/A2)

`.output()`'s key type opens from the closed 11 media types to any `` `${string}/${string}` ``. Known types keep helper affinity (json serializes; text/html/csv/xml stringify; event-stream streams via `sse`; octet-stream via `binary`). Any other media type declares a **bytes body** whose OpenAPI 3.1 schema is `{ type: "string", format: "binary" }`, carrying the declared content-type through IR → OpenAPI → SDKs/CLI/MCP. Multiple media types per status are documented and negotiated via `Accept`. `.output()` gains an optional per-status response-headers schema map → OpenAPI response `headers` → typed `response.headers` accessors in SDKs. The request side mirrors it with `.input({ binary })`. `ctx.res.raw()` stays as the untyped escape hatch.

This also closes the SSE typing gap (H8): the declared schema for a content type must reach the generators. Fixes the gif finding (A1) and typed response headers (A2). Bit 08, 10, 11–16.

## H11 — SDK stacks for C#/.NET and Java

- **C#/.NET:** one C# emitter targeting .NET; BCL-only — `System.Net.Http.HttpClient` + source-generated `System.Text.Json`, zero external deps; models as `record`; ships a NuGet package with a generated `.csproj`; target-framework floor `net8.0`, CI tests on `net10.0` (.NET 10 is current LTS to Nov 2028; .NET 8/9 reach end of support Nov 10 2026).
- **Java:** one Java emitter, Java source only; JDK built-in `java.net.http.HttpClient` (no HTTP dep) + Jackson for JSON; ships to Maven Central with a generated Gradle build; compiled `--release 17` (Java 17 is the first LTS with the built-in HttpClient + records), CI tests on 17/21/25 (25 is current LTS).
- No server frameworks (Spring/ASP.NET) anywhere — these are client SDKs. Both follow H9 (vendored glue over the ecosystem standard).

## H12 — Code emission uses no AST; type extraction keeps its AST

**Emission.** Generated target source is built by structured string/line assembly guarded by the `codegen-lang` sanitizer (every spec-derived identifier/string passes through it; raw spec text never reaches source). No target-language AST (go/ast, syn, Roslyn, JavaParser) is adopted — infeasible in a JS/bundler/worker runtime, and no gold-standard generator does it. Correctness and canonical formatting come from the mandatory native-formatter post-pass (H in `00-rules.md`): gofmt, rustfmt, ruff/black, `dotnet format`, google-java-format, biome. Mandatory in publish CI; valid-but-unformatted fallback for pure-JS generation. v0 ran gofmt opt-in and only suppressed ruff — v1 makes the pass mandatory.

**Extraction.** `type-extractor.ts` (855 lines in v0) drives the TypeScript compiler API via ts-morph (`TypeChecker`/`getTypeOfSymbolAtLocation`/`forEachChild`) to extract the middleware context + chain types from the consumer app. This AST/checker approach is the only correct one for type extraction and is kept — split under the ≤300 limit, `ts-morph` stays an optional peer loaded solely for type gen.

## H13 — Test layout: flare's model

Units colocated beside source; feature-named integration suites in `tests/integration/` at 100% core feature coverage; e2e apps + the runner under `tests/e2e/`; typetests in `tests/types/`; the frozen 313-finding guard in `tests/regression/` (names kept stable for regression-matrix traceability). gen mirrors it: colocated units, `tests/integration/` for harness/polyglot/conformance.

**Reorg rule (lose nothing) — by inventory, not by reshuffle.** The session-dump files (`bug-hunt-N` / `edge-cases-N` / `client-edge-cases-N` / `type-emitter-debugN` / `sdk-r*` / `audit*` / cross-cutting `unit/core/*`) are **not** physically redistributed inside `_v0/tests`: that is ~34k lines of hoist/helper/`vi.mock` surgery on files that are frozen and deleted at bit 20 — real oracle-drift risk for a corpus whose legibility is thrown away. Instead bit 00 builds a **case inventory**: `tests/structure/v0-inventory.ts` parses every `_v0/tests` file (oxc-parser) and classifies each case (`file > describe > name`) by the feature it exercises → committed `blueprint/baselines/v0-cases.json`. `_v0/tests` stays **byte-frozen**. The lose-nothing gate is `reorg-coverage-diff.test.ts`: at each bit, every v0 case of the features **that bit owns** must be either **covered** (a clean, feature-organized, best-possible v1 test carries a `// v0: <id>` tag — authored fresh, **never a copy** of the v0 test; one clean test may cover many v0 cases; see **H22**) or **retired** (with a reason — redundant / covered-by / obsolete / v0-bug-not-preserved). Before `_v0` is deleted at bit 20, unaccounted cases must be **0**. "Accounted" is cover-or-retire; the case count is a checklist, not a copy target. This preserves the count where it matters — the surviving v1 suite — and enforces it per feature as each bit lands, machine-checked, without touching frozen tests. `files.tsv` carries the v0→v1 feature-home mapping for all 440 v0 test files.

## H14 — e2e matrix: 30 cells, Deno dropped

node / bun / cf × {dev, prod} × {compose, defaults, gateway, kitchen, surface} = 30 cells. `tests/e2e/run.ts` already supports `--env/--app/--mode`; v1 removes the deno env and moves apps+runner under `packages/core/tests/e2e/`.

**v0's `prod` is a no-op (verified, bit 00):** `run.ts --mode prod` only flips the Playwright `grepInvert` between `@prod-only`/`@dev-only`, and **no** e2e test carries either tag — so `prod ≡ dev`, and `cf` is always local wrangler/miniflare, never a deployed worker. The bit-00 oracle therefore captures all 30 cells **locally** with `prod ≡ dev` (`blueprint/baselines/e2e-expected.json`), faithful to what v0 does — this is the baseline, recorded as a known v0 limitation.

**v1 requirement (owned by bit 19, cutover/release):** v0's no-op `prod` must not become v1's accepted behavior. The v1 runner makes `prod = the built bundle served end-to-end` (the full Playwright suite drives real requests against the *shipped* artifact — catching bundler externalization / tree-shake / side-effect divergences that import-time `test:build` and dev-from-source both miss) and `cf prod = a deployed worker` (CF creds in CI). At bit 19 the baseline is re-recorded against v1, the 5 `cf-prod` cells move to CI, and the ≥1 genuine `@prod-only` assertion (built-bundle-only behavior) that makes `prod` distinct is added. Until then, dev and prod are the same run.

## H15 — Deno is deleted

A runtime target, not a feature — nothing is lost. Purge (verified footprint): `e2e/deno/`, `src/ws/deno.ts`, the `./ws/deno` export, the `test:e2e:deno` script, Deno targets in each app's `vite.build.config.ts`, and the Deno branches in `detect-runtime.ts`, `feature-detect.ts`, `peer.ts`, `serve.ts`, `fetch-request.ts`, `context.ts`, `request-path.ts`, `feature-slots.ts`, `build/index.ts`, `proxy.ts`, `node-request.ts`, `ws/shared.ts`, `client/http.ts`. node/bun/cf detection stays intact, with guard tests. Bit 00 + bits 03/04.

## H16 — Telemetry: nested spans + W3C traceparent (G1)

v0's `otelAdapter` (verified) starts every span as a separate root (`startSpan(name)`, no parent) and never reads `traceparent`, so a trace is flat and a honey service breaks an upstream caller's trace chain. v1 fixes both: nest spans under a per-request root (`http.request` → `middleware.*` → `http.handler`/`http.error`) by extending the minimal `Tracer` to take a parent / carry the active span on the request context, and continue W3C Trace Context — parse an incoming `traceparent` (+ `tracestate`), adopt its trace id + parent span id when valid, and emit `traceparent` on outbound proxy/fetch. Additive (the `otelAdapter()` export shape stays); a spotted-bug TDD fix. Pairs with trust (which upstream to believe). Bit 07 (telemetry). Reported by flare against honey; confirmed.

Correlate the three signals, keep the ids distinct (do not collapse). `requestId` stays the independent, client-facing id (works with telemetry off, is client-suppliable; a 32-hex trace id is a poor client id). When a root span is active, the `requestId` middleware sets it as the span attribute `honey.request_id` (honey-namespaced; OTel has no stable semconv key for request id), and the per-request logger child additionally binds `trace_id` + `span_id`. Result: trace → `honey.request_id` → logs, and logs → `trace_id` → trace. This rides entirely on the active-span-on-context plumbing H16 already adds — two attribute writes, no new architecture. `logger` already binds `requestId`; v1 adds the trace ids beside it.

## H17 — Observability as a first-class surface (G1 is its tracing part)

v1 raises observability to the same decision-level rigor flare gives it (its bit 16), scoped to an API framework. The full contract is `dx/observability.md`; owner is bit 07. honey already has the primitives (pino logger with child, request-log middleware, validated `requestId`, structural `otelAdapter`) — v1 completes them with flare's framework-agnostic rulings:

1. **Two distinct error hooks — do not conflate them (anyrow-verified).** honey's `app.onError(fn)` is a **response-shaping** hook: it returns `HoneyError | Response | undefined`, honey applies it on the response path (anyrow's `createDbErrorHandler` maps D1/constraint errors to a typed `HoneyError` with `Retry-After` + i18n and depends on this). It stays **awaited** — flare's "report in the background, never delay" does NOT apply to it, because flare's `onError` only reports while honey's also maps. The "never delays the response" reporting path is honey's separate `telemetry.onError`, which is already fire-and-forget (`safeFire`). v1 keeps both: `app.onError` awaited + response-shaping; `telemetry.onError` background + reporting. A throw inside `app.onError` is logged once and falls back to the native projector (no recursion); named statuses (4xx/redirect) do not fire it.
2. **traceparent trust-gating** (H16): trusted → continue; untrusted → link, never continue, request id = trace id so a client can't pick your request id.
3. **`requestId` reuse gates on `trustProxy ≥ 1`** (v0 reuses any safe value regardless of trust — a hardening gap); trace id wins when a tracer is set.
4. **Privacy by test:** no cookie / `Authorization` / `Set-Cookie` / query / body / handler input in any log field or span attribute; paths without query; route ids (not raw paths) name spans.
5. **Non-recording / sampled-out span builds no attributes** — zero cost off.
6. **Span lifecycle tied to the body:** ends at stream finish/cancel, not at headers; disconnect → `status: aborted` (pairs with bit 05 streaming).
7. **`run(span, fn)`** on the Tracer so app instrumentation nests under honey's spans; explicit parent-passing, never an async context manager (Workers has none, Bun partial).
8. **Production error log holds the full stack** (operator log is private); the client still gets a generic message + digest.
9. **Default levels `debug` (dev) / `info` (prod); no `logLevel` option** (`createLogger({ level, format })` for another sink level).
10. **Silent-failure classification:** every `catch` either logs (with a tag, and `onError` when it is a server error) or carries a comment naming who reports it; "no unclassified swallow" is a gate.
11. **Combination matrix test** (96 cases) proves every logger/onError/requestLog/tracer/trustProxy × dev/prod combination behaves per `dx/observability.md`.
12. **Unconfigured observability within 2% of baseline** — its own bench, gated by the perf gate.

Out of scope (flare-only, no honey analog): the dev server↔browser log bridge — honey has no browser. honey adds instead: gateway/`proxy` traceparent forwarding and SSE/WS span lifecycle. `@opentelemetry/api` stays an optional peer behind the `./telemetry/otel` subpath (honey already keeps OTel out of core via the structural `Tracer`).

---

## H18 — Second-pass corrections (audit round 2)

Fixes to round-1 decisions that were stated but not coherent, plus newly surfaced gaps. Each is pinned in its bit.

- **H18.1 RAW_BODY via an unconditional WeakMap side table (supersedes the round-1 "gate the tag" note).** Round 1 proposed tagging the response only when `handler.ov !== null || node`. That breaks `compress` (needs `rawBodyOf`), HEAD `content-length` (`body-kind.ts`), and `ctx.res.raw(honeyResponse)` on the default Bun/Workers path, because the raw body has **multiple readers**, not just output validation. Decision: keep the raw body in a module `WeakMap<Response, raw>` **unconditionally** — no `defineProperty` on the host object (the perf win), and every reader (output validation, compress, HEAD, raw) finds it. **The WeakMap *write* (tagging) is born with `response.ts`/`builder.ts` at bit 02** — it is intrinsic to constructing a buffered response and is the perf win applied at birth (and `ctx.res.raw(honeyResponse)`, a bit-02 reader, needs it). The **readers attach at their bits**: output validation + HEAD/`body-kind` at bit 08, `compress` at bit 07, `raw()` at bit 02. (The earlier "Bit 08" label referred to the output-validation reader; the tag itself is bit 02.)
- **H18.2 A1 non-JSON outputs are a type contract, not runtime-validated.** v0 `_validateOutput` runs only for `application/json` (`index.ts:2873`). Under A1 a declared `text/csv`/`image/gif` output carries a schema to the generators but is **not** validated at runtime; the blueprint states this explicitly so SDK/MCP consumers don't infer enforcement core doesn't do. Also fix the content-type match: exact essence match, not `ct.startsWith(t)` (which lets `application/json` match a produced `application/json5`), and exclude the `redirect` pseudo-key from the declared-types set. Bit 08.
- **H18.3 — withdrawn.** (Was an `x-pagination` IR marker for SDK auto-pagination. Superseded by H20: auto-pagination is cut entirely — see the C1 gap.)
- **H18.4 `ctx.trustsForwarded` is true only when a forwarded value was actually consumed.** In `ranges` mode trust is per-request (`trust.ts:78` — count is 0 when the peer isn't in range), so a static "is trustProxy configured" flag would reuse a client id exactly when the peer is untrusted — inverting H17.3. And in `hops` mode `trustedHops` returns the count unconditionally (`trust.ts:70`) and `pick` clamps to the direct peer when `X-Forwarded-For` is shorter than the count, so `trustProxy: 1` with **no** `X-Forwarded-For` yields `count=1` while the client silently fell back to the direct peer — which must NOT be treated as trusted-forwarded. Pinned rule: `trustsForwarded` = (`ranges`) `count > 0`, (`hops`) `forwarded.length >= count`. One extra field on the already-cached `ClientInfo` resolution, no new allocation. Bit 03.
- **H18.5 core/build is a build-time consumer of `honey-codegen`.** `build/plugin.ts` calls `generateTypes` and `generateRouteTree*` (the route-tree emitter, now homed at `gen/emit/ts/route-tree.ts`). The build plugin therefore imports `@lovrozagar/honey-codegen` at build time. This does not violate H1's "lean core" (it is a `devDependency`/build path, not a runtime dep) but it must be stated; H1/bit 19 updated. Bit 19.
- **H18.6 SSE can emit an empty `id:` reset.** v0 `response.ts:238` skips emission when `event.id === ""`, so a stream can never tell a client to clear its last-event-id (an SSE-spec directive). v1 emits `id:` for an explicit empty string (distinguish "unset" from "reset"). Bit 05/06.

### Security (audit round 2)
- **H18.7 `compress()` BREACH/CRIME.** Response compression is a secret-length side channel over TLS. Default-exclude responses that set a cookie or carry an auth-relevant secret from compression (or length-mask), document the risk, and add a BREACH case to the bit-07 corpus. Bit 07.
- **H18.8 `rateLimit()` memory store is bounded.** The default in-process store is LRU/TTL with a max-entries cap — an attacker spraying distinct keys (an IPv6 /64) must not OOM the limiter. Add a store-growth adversarial case. Bit 07.
- **H18.9 webhook signature-verify is constant-time.** The generated verify helper uses each language's constant-time primitive (`crypto.timingSafeEqual` / `hmac.compare_digest` / `hmac.Equal` / `subtle` / `CryptographicOperations.FixedTimeEquals` / `MessageDigest.isEqual`); `codegen/webhooks.test.ts` asserts it (timing can't be fuzzed). Bit 10.
- **H18.10 auth is dropped on a cross-origin redirect in every SDK.** The four existing runtimes do this; C#/Java default to resending `Authorization` on a cross-host redirect, so bits 15/16 must drop it. Add a cross-SDK conformance case asserting bearer + configured headers are not resent cross-origin. Bits 15/16 + the SDK conformance harness.
- **H18.11 MCP path-param guard rejects separators/dot-segments.** The guard rejects any value containing `/`, `\`, `%2f`, `%5c`, or a `.`/`..` segment (not just whole-string `""`/`.`/`..`); bit 18 adds an adversarial MCP-path case. Bit 18.
- **H18.12 WS same-origin compares full origin (scheme+host+port), not host alone** (`ws-origin.ts:49`) — an `http://` origin must not be same-origin to an `https` host. Bit 06.
- **H18.13 `search` params use the dangerous-key filter for parity with form** (`validation.ts:360` → `collect(..., true)`), so a `__proto__`/`constructor` key never reaches the user schema. Bit 08.
- **H18.14 scope-`"/"` applies at the type level (fix v0 gap, H22).** `.use("/", mw)` covers every path at runtime, but v0's `ApplyScoped` requires `TFullPath` to equal `"/"` or start with `"//"`, so a root scope's additions never reach a `"/any"` route's handler type. v1 makes a Head path of `"/"` apply its adds to every route — type matches runtime and the test's stated intent, no valid program loses typing. Found porting v0's `use-scoped-types` T9 (which asserted this and never ran in v0). Bit 02 (`app-types`/scoped).
- **H18.15 chain-level `.meta({ internal: true })` excludes downstream from `InferRoutes` (fix v0 gap, H22).** v0's `meta()` value-overload binds `TNewMeta` to `Record<string, unknown>` and wins resolution, so chain meta never reaches accumulated route meta and `SkipRouteRecord` never fires — internal routes leak into `$routes` and thus into generated client types (bit 11), defeating the purpose of `internal`. (Route-level `.meta({ internal: true })` already works.) v1 carries the value-overload's `TValues` into the handle meta and reorders the overloads so the explicit-type-argument form doesn't shadow inference, making chain-level behave like route-level. A real public-type change, consistent with H22. Bit 02 (`app-types`/builder meta overloads); the matching runtime exclusion of chain-internal routes from the emitted OpenAPI/SDK is verified at bits 10/11.
- **H18.16 `ctx.errors` narrows to declared + default keys at RUNTIME, not just the type (fix v0 inconsistency, H22).** v0 put the whole error factory on `ctx.errors` at runtime regardless of `.errors()`, while its type was a wide `Record<string, fn>` intersection — so a route could throw a factory error it never declared, invisible to the OpenAPI/SDK contract. v1 makes `ctx.errors` hold exactly the route's `.errors()` keys plus the app's `defaultErrors`, at runtime and type alike (a route with no `.errors()` sees only the defaults). `.errors()` is the sole way to opt a key into a route, which is what makes the generated error contract complete. **This is a runtime behavior change** (v0 case `a88f6dff48` is retired, not preserved): type-bypassed `ctx.errors.<undeclared>()` calls that worked in v0 now return `undefined`. Surfaced, not silent — a consumer's typecheck against v1 flags every such call at cutover, and the fix is to declare the key via `.errors()`. Flagged to the user because anyrow is the live consumer. Bit 02 (`errors`/builder).

## H19 — Governance pins (third-pass; flare-parity + contract exactness)

- **H19.1 Dependency versions (pin in `00-rules.md`).** A table: each dependency a `devDependency` at the exact tested version and, if imported, an optional `peerDependency` of `>=` that version — `jiti` (runtime dep), `ws` (optional peer, Node WS), `ts-morph` (optional peer, codegen type extraction). The published `@lovrozagar/honey` keeps no eager `dependencies` beyond jiti. Each emitted SDK's vendored runtime pins its ecosystem target-lib floor: TS `fetch` (platform), Python `httpx >=`, Rust `reqwest`+`tokio`+`tokio-tungstenite >=`, Go `net/http`+a WS lib, C# BCL only, Java `java.net.http`+Jackson `>=`.
- **H19.2 Runtime floor.** Core states a minimum per runtime (Node ≥ the Fetch/WebStreams baseline, Bun ≥ tested, Workers = current). Pinned in `00-rules.md`.
- **H19.3 Module-state discipline + lint.** The perf plan introduces module-scope singletons (the RAW_BODY `WeakMap`, the `TextEncoder`/`Decoder` singletons, the rate-limit default store, the i18n `dict` cache). A `honey/no-module-state` lint rule forbids module-scope `let`/mutable map/cache **unless** the line carries `// per-process-constant: <reason>` and the reason is on an allowlist (the four above). Plus `honey/no-module-side-effects` + `"sideEffects": false` in `@lovrozagar/honey`'s manifest for tree-shakeability. Bit 00 lint rows.
- **H19.4 check-tree phase semantics (three-tier, so main stays green per commit).** `structure/check-tree` reads the `COMPLETE` constant and enforces by tier: **completed bits (`bit ≤ COMPLETE`) must be whole** — every row exists (a `src` row with its colocated test), a missing one fails; **the in-progress bit (`COMPLETE + 1`) may land file by file** — its files are neither required-whole nor flagged `early`, so each TDD'd file lands in its own green commit; **beyond it (`bit > COMPLETE + 1`) is still `early`** — a file that appears before its bit is active fails. A completed bit flips `COMPLETE` to its number in the change that finishes it, at which point that bit is enforced whole. An unlisted file under a checked root always fails. (The earlier "strict only up to the current bit, all-or-nothing per bit" wording forced an entire bit into one commit — the `COMPLETE + 1` tier is the fix; the lose-nothing gate uses the same `≤ COMPLETE` cutoff, so it demands port/retire only for completed features.) Bit 00 + `00-rules.md`.
- **H19.5 Contract exactness (third-pass red-team).** The under-pinned new-surface contracts are now pinned in their dx/bit (pagination is not among them — it is cut, see C1/H20): problem+json (bit 08 mapping table + `type` URI), rate-limit (fixed-window + `X-RateLimit-{Limit,Remaining,Reset}` with `Reset`=epoch-seconds + default key `ctx.ip` + `RateLimitStore` signature), range (single-range only; multi → 200) + cache-control (`Last-Modified` whole-second truncation; `If-None-Match` before `If-Modified-Since`), and trust `trustsForwarded` (H18.4 updated: true only when a forwarded value was actually consumed).
- **H19.6 Packaging tool is an explicit bit-19 spike** (flare's B18): the bundler/packager choice for the generated SDKs' publish is decided in bit 19, not assumed.
- **H19.7 Lint-promote two invariants** currently tested only: exact-essence content-type match (ban `startsWith` on a media type, H18.2) and "no request header selects an internal mode." Bit 00 lint rows.

## H21 — `_v0` and the cutover (bit-00 feasibility, from the implementer's D1–D5)

- **`_v0` is a complete v0 package at the repo root (Option Z — verified by the implementer).** A root `_v0` **cannot** use the per-subpath flip: Node `exports` targets must stay inside the package dir, so `packages/core` can never point a subpath at `/_v0/src`; and a workspace alias collides once v1 is also a workspace named `@lovrozagar/honey`. So `_v0/` is the **whole v0 package** — its own `package.json` named `@lovrozagar/honey` with the v0 `exports`/`bin`/`scripts`/`docs`/`examples`/`README`/tsconfigs/vitest configs, plus `src` + `tests` — and it **stays a root-workspace member** for the rewrite. Every consumer (the 5 e2e apps + Playwright cells, `generate` via the v0 CLI, `test:consumers`, the 15-cell bundle matrix, `test:packaging`, `bench`) resolves `@lovrozagar/honey` → v0 **with zero edits**, so the entire oracle (vitest + consumer-facing) stays green from bit 00. `_v0/**` is outside the v1 `src/**` globs and v1's published `files`.
- **`packages/core` = pure v1, out of workspaces until cutover.** It holds only v1 and is **left out of root `workspaces`** until the swap; its devDeps hoist from root, and root `test`/`typecheck` run **both** trees (v1 is a vitest project + a tsc include, not a resolvable package yet — fine, because v1 code only ever uses relative imports internally, H-rules). v1 is validated incrementally by **its own growing suite** (unit + feature integration + conformance) **and `differential.ts`** comparing v1 output to v0's frozen output per capability — not by serving the consumer e2e yet.
- **Cutover = one atomic workspace swap** (replaces the per-subpath flip): `_v0` leaves `workspaces`, `packages/core` joins as `@lovrozagar/honey`, in a single committed change — done when `packages/core` can serve **every** subpath a consumer imports, i.e. **after gen lands (end of bit 18), before release (bit 19)**, unless codegen can be cleanly bridged earlier (implementer's call to propose). The bit that swaps owns the consumer e2e passing identically against v1 across it. **`_v0` is deleted at bit 20.**
- **Colocation timing:** unit tests colocate beside each v1 file **as that file is born** (not at bit 00 — no v1 source exists yet). Bit 00 does **not** reshuffle v0's session-dump files; it inventories them (`v0-inventory.ts` → `v0-cases.json`, `_v0/tests` byte-frozen) and installs the `reorg-coverage-diff` gate that each later bit satisfies by porting (`// v0: <id>`) or retiring its features' cases (H13) — so nothing binds to a v1 path that doesn't exist yet and the frozen oracle can't drift.
- **Oracle steps down for the Deno purge:** deleting `ws-deno` + the Deno cases in build-plugin/build-targets/client-ip/request-path/serve-soak/realtime-server drops the count. The baseline steps to **6767 − N** with **N measured exactly** and a reason line in `blueprint/baselines/oracle-baseline.txt`; the oracle-count test asserts the stepped number.

## H20 — No SDK auto-pagination (C1 cut)

Pagination is **100% the API author's responsibility** and v1's generator has no part in it. anyrow implements pagination in `@lovrozagar/comb` (a separate package honey neither ships nor references); it supports both cursor and page/offset by the author's choice. honey ships no pagination helper, no `./pagination` export, no `x-pagination` extension, and emits no page iterators in any SDK. A generated iterator that silently fires N requests under one call is a footgun ("loop bomb") no one asked for. Generated SDKs return a single page; the caller paginates. (Supersedes the round-2/3 flirtation with an `x-pagination` descriptor — withdrawn in full. Revisit only on an explicit consumer request, and only as opt-in author-controlled metadata, never a framework concern.)

## H22 — v1 is a REWRITE, not a port (the authoring standard; governs every bit)

The single thing v0 is the **spec** for is **behavior**: the oracle (the 6713 runtime tests against `_v0`) must pass identically. Everything else about v0 — its test files, its type shapes, its source structure — is **reference, not spec**. v1 is authored as the optimal implementation and the best-possible test suite, not a transliteration.

- **Tests are authored fresh for best-possible, feature-organized, 100% coverage — never copied from v0.** v0's session-dump files (`bug-hunt-N`, `edge-cases-N`, `bizarre`, `broken-world`, `production-weird`, `audit`, `P1-5`) and any junk/redundant case are **trash and do not cross over**. No v0 test filename and no session-named describe (`bug-hunt-N:`, `audit:`, …) appears anywhere in v1; every describe names the **behavior**.
- **The inventory (`v0-cases.json`) is a behavioral CHECKLIST, not content.** Every v0 case is either **covered** by a clean v1 test — the `// v0: <id>` tag links the behavior, and one clean test may cover many v0 cases — or **retired with a reason** (`redundant`, `covered-by <test>`, `obsolete`, `v0-type-bug-not-preserved`). Redundant and junk cases are retired, not copied. `reorg-coverage-diff` still gates **0 unaccounted**; "accounted" means covered-or-retired, and **never** verbatim-ported. Count is not the target; coverage quality is.
- **v0's type API is reference, not spec.** v1 designs the optimal type surface; ported typetests are **rewritten to assert v1's (correct, improved) types**. v0's type **bugs are fixed, not preserved** — e.g. scope-`"/"` not applying to `"/any"` routes, chain-level `.meta({ internal: true })` not excluding downstream from `InferRoutes`, `createMiddleware`'s misused second generic. v0's typetests were **never run in v0** (its `type:check` covered only `src` + a few files), so many encode false assertions; those are corrected to v1 truth, never carried. A "mismatch with v0's generics" is **not** a defect to reconcile — it is expected. The only type invariant: the **user-facing DX** (what a user writes and the types they get) is **equal-or-better**. Deliberate tightenings (e.g. `ctx.errors` → declared keys only; `next()` → `MaybePromise`) are welcome.
- **Source is written clean**, not transliterated: v0 is read for behavior and intent; v1 is the optimal implementation (the perf targets, the H-decisions). Matching v0 line-for-line is never a goal.

This is why the reorg is an inventory, not a reshuffle (H13), and why "port" throughout the blueprint means **cover-the-behavior-with-a-clean-test or retire**, never copy. When a choice is between fidelity to v0's shape and the best v1, the best v1 wins — behavior stays identical, the rest improves.

**What "best-possible" means concretely (so it is not re-read as "rename and move").** A feature suite is *authored*, not assembled from v0 cases:
- **Organized by sub-behavior.** Describes name feature areas (routing → "path params", "method resolution", "wildcards", "trailing slash", "encoded segments"), each grouping its related assertions. **Not one describe per historical v0 bug.**
- **Shared setup.** A local app factory / helper (or `beforeEach`); a test does not rebuild `honey()` inline when its neighbors do. Parametric cases use `it.each` / table-driven assertions.
- **Consolidated.** Redundant v0 cases merge into one thorough test; the duplicates **retire** in `v0-cases.json` (`covered-by <test>`). The case count **drops** — that is the goal, not a loss.
- **Comprehensive.** The suite covers the *feature* (the 100%/file gate plus the edge cases a careful author adds), using the inventory as a **checklist** that nothing v0 proved is missing — never as the test list.
- `// v0: <id>` tags ride the covering test (one test may carry several ids it subsumes).

**The dump tell (a gate for the reviewer):** a suite where `#describes ≈ #its ≈ #inline honey() builds ≈ #v0 tags` is a relabeled dump and **fails this bar** — stripping `bug-hunt-N:` off a v0 describe and moving the verbatim body into a feature file is exactly the thing H22 forbids. The reviewer verifies suites by **reading them**, not by trusting a "redistributed / renamed" report.

**The test-file map is reviewer-owned and named by sub-behavior.** `files.tsv` carries the complete set of test files for each bit — one file per feature when it fits the 500-line cap, otherwise split into **named sub-area files** (`routing-params`, `context-query`), **never** `<feature>-<number>` (a numbered split is a dump by another name). The reviewer defines this map **before** the implementer authors; the implementer fills the named files and does not invent filenames or numbered splits. A file that overflows the cap after genuine consolidation gets a finer named sub-area, proposed to the reviewer. (The earlier `<feature>-<n>` split pre-authorization is **revoked**.)

---

## Deep-dive gaps A1–G1

Each gap from `.tmp/grunt/1-v1-prestart-deep-dive-20261012T192436Z.md`, its disposition, and the owning bit. DX-adding items are additive, not removals. Items marked **proposed** are not applied until approved.

### A — Response / HTTP
- **A1 open media types** → H10. Bit 08/10/11–16.
- **A2 typed response headers** → H10. Bit 08/10/11–16.
- **A3 Range / 206** → add a range helper for binary/stream bodies and `staticFiles`; emit `Accept-Ranges`, honor `Range`. Bit 05/07.
- **A4 Last-Modified / If-Modified-Since** → add alongside ETag + a `cacheControl` helper. Bit 08.
- **A5 rate-limit middleware** → `rateLimit()` with pluggable store (memory default), `Retry-After` + `X-RateLimit-*`. Bit 07.
- **A6 response compression** → optional `compress()` (Accept-Encoding negotiation; skip already-encoded/streamed); document when to rely on the platform. Bit 07.
- **A7 problem+json** → keep honey-native errors as default; add an opt-in RFC 9457 formatter. Bit 08.
- **A8 path-param constraints** → **proposed**, low priority; decide typed/constrained params in the grammar. Bit 01 (decision only).

### B — OpenAPI
- **B1 configurable servers** → list + variables, composed with stripPrefix/basePath. Bit 10.
- **B2 tags/grouping** → emit `tags`/`externalDocs` from the resource tree or route meta; keep operationId grouping for SDKs. Bit 10.
- **B3 webhooks/callbacks** → support OpenAPI 3.1 `webhooks` + emit a typed webhook-payload parser and signature-verify helper. Bit 10 + vendored runtime glue.

### C — SDK
- **C1 auto-pagination** → **CUT (H20).** Pagination is **fully the API author's responsibility** (anyrow implements it in `@lovrozagar/comb`, a separate lib honey does not ship or reference). v1 ships **no** SDK auto-pagination: no honey convention, no `x-pagination` marker, no `./pagination` export, no page-iterator emission. An auto-iterator is a hidden multi-request loop (a "loop bomb") behind an innocent-looking call — not wanted. SDKs return a page; the caller loops, exactly as today. Reconsider only if a consumer explicitly asks, and even then only as pure opt-in metadata the author controls — never a framework concern.
- **C2 uniform raw-response + per-call overrides** → confirm/complete parity across all SDKs. Bit 11–16.
- **C3 runtime as copied source** → **resolved** by H9 (vendoring is correct). No package to publish.

### D — MCP
- **D1 tools/text only** → emit `outputSchema` + return `structuredContent`; emit tool annotations from method/meta (GET→readOnly, idempotency→idempotent/destructive); binary/image results once H10 lands; consider `resources` for GET-list endpoints. Biggest lever for the token metric. Bit 18.

### E — CLI
- **E1 Go-only; cf bar** → keep Go (single static binary; the end user needs no Go, no Node — cf is TypeScript/Node, which honey beats on zero-setup distribution). Adopt cf's schema-level verb consistency, `--json` uniformity, agent command discovery, compact-for-agent output, shell completion, a local/remote indicator, and an agent-skills/docs bundle. Bit 17.

### F — Security / supply chain
- **F1 adversarial suite as a gate** → H7; the in-process `app.fetch` suite is a per-bit CI gate. Bit 00 (gate) + every middleware bit.
- **F2 one shared fuzzed string-escape layer** → the single injection backstop across all emitters. Package provenance is moot under H9 (nothing new published). Bit 07/gates.

### G — Telemetry
- **G1 flat spans + no traceparent** → H16: nest spans under a per-request root; continue (and emit) W3C `traceparent`/`tracestate`. Bit 07.
