<!-- MANAGED by workerc — edit content freely but keep the format conventions intact.
     workerc parses step IDs (1.a.1), statuses ([ ] / [x] / [!]), phase/track headers,
     and the metadata lines. /workerc:done marks steps [x], /workerc:status reads progress. -->

# roadmap — honey

  milestone  sdk-parity-v1
  active     (complete — all 11 phases shipped)
  updated    2026-04-17

## Phase 0 — Shared IR Foundation
  goal    Single normalized IR drives all 4 emitters; eliminate per-lang OpenAPI reparse drift
  status  active
  spec    .claude/specs/honey-sdk-parity-master.md

### Track 0.a — IR types + emitter migration                [sequential]
  [x] 0.a.1   Extract IR types to codegen-ir.ts             kind: refactor-tdd  @lovrozagar
  [x] 0.a.2   Wire TS emitter to consume IR                 kind: refactor-tdd  @lovrozagar
  [x] 0.a.3   Port python-type-emitter to IR                kind: refactor-tdd  @lovrozagar
  [x] 0.a.4   Port go-type-emitter to IR                    kind: refactor-tdd  @lovrozagar
  [x] 0.a.5   Port rust-type-emitter to IR                  kind: refactor-tdd  @lovrozagar
  [x] 0.a.6   IR snapshot fixtures (20+ OpenAPI edge cases) kind: test-tdd  @lovrozagar

## Phase 1 — Test Harness Parity
  goal    Compile + behavioral tier added; no feature lands without 4-lang verification
  status  planned
  spec    .claude/specs/honey-sdk-parity-master.md

### Track 1.a — Compile + behavioral harness                [parallel]
  [x] 1.a.1   Add ts-sdk.test.ts with tsc --noEmit          kind: test-tdd  @lovrozagar
  [x] 1.a.2   Enable HONEY_RUST_INTEGRATION by default      kind: refactor  @lovrozagar
  [x] 1.a.3   Build shared mock server for behavioral tier  kind: feat-tdd  @lovrozagar
  [x] 1.a.4   Scaffold per-lang integration harness         kind: feat-tdd  @lovrozagar

## Phase 2 — Auth + Typed Errors
  goal    401 auto-retry on all 4; typed error hierarchy on all 4
  status  planned
  spec    .claude/specs/honey-sdk-parity-master.md

### Track 2.a — Auth                                        [parallel]
  [x] 2.a.1   TS 401 auto-retry via onAuthExpired           kind: feat-tdd  @lovrozagar
  [x] 2.a.2   Python configurable authHeaderName/Prefix     kind: feat-tdd  @lovrozagar

### Track 2.b — Typed errors                                [parallel]
  [x] 2.b.1   TS typed error hierarchy (BadRequest, ...)    kind: feat-tdd  @lovrozagar
  [x] 2.b.2   Per-op declared error responses all 4 langs   kind: feat-tdd  @lovrozagar

## Phase 3 — Cancellation + Timeout + Per-call Headers
  goal    Native cancellation + per-call timeout + per-call headers in every lang
  status  planned

### Track 3.a — Cancellation                                [parallel]
  [x] 3.a.1   Python cancel token (async + sync)            kind: feat-tdd  @lovrozagar
  [x] 3.a.2   Rust CancellationToken + AtomicBool           kind: feat-tdd  @lovrozagar

### Track 3.b — Timeout                                     [parallel]
  [x] 3.b.1   TS per-call timeout param                     kind: feat-tdd  @lovrozagar

### Track 3.c — Per-call headers                            [parallel]
  [x] 3.c.1   Python per-call headers                       kind: feat-tdd  @lovrozagar
  [x] 3.c.2   Go per-call headers                           kind: feat-tdd  @lovrozagar

## Phase 4 — Hooks Everywhere
  goal    onRequest / onResponse arrays on all 4
  status  planned

### Track 4.a — Request/response hooks                      [parallel]
  [x] 4.a.1   Go on_request/on_response arrays              kind: feat-tdd  @lovrozagar
  [x] 4.a.2   Python on_request/on_response lists           kind: feat-tdd  @lovrozagar
  [x] 4.a.3   Rust align hook naming + array support        kind: refactor-tdd  @lovrozagar

## Phase 5 — Logging Hook
  goal    Pluggable onLog in every lang
  status  planned

### Track 5.a — onLog                                       [parallel]
  [x] 5.a.1   TS onLog + LogEntry schema                    kind: feat-tdd  @lovrozagar
  [x] 5.a.2   Python onLog                                  kind: feat-tdd  @lovrozagar
  [x] 5.a.3   Go onLog                                      kind: feat-tdd  @lovrozagar
  [x] 5.a.4   Rust onLog                                    kind: feat-tdd  @lovrozagar

## Phase 6 — Invalidation Metadata Parity
  goal    selector / seqSnapshot / invalidatedBy on all 4
  status  planned

### Track 6.a — Metadata ports                              [parallel]
  [x] 6.a.1   Python invalidation metadata                  kind: feat-tdd  @lovrozagar
  [x] 6.a.2   Go invalidation metadata                      kind: feat-tdd  @lovrozagar
  [x] 6.a.3   Rust invalidation metadata                    kind: feat-tdd  @lovrozagar

## Phase 7 — Streaming Request Bodies
  goal    Upload streams (octet-stream, multipart) on all 4
  status  planned

### Track 7.a — Stream upload                               [sequential]
  [x] 7.a.1   Codegen detect stream request bodies          kind: feat-tdd  @lovrozagar
  [x] 7.a.2   TS stream upload (ReadableStream/Blob)        kind: feat-tdd  @lovrozagar
  [x] 7.a.3   Python stream upload (async iter[bytes])      kind: feat-tdd  @lovrozagar
  [x] 7.a.4   Go stream upload (io.Reader)                  kind: feat-tdd  @lovrozagar
  [x] 7.a.5   Rust stream upload (impl Stream)              kind: feat-tdd  @lovrozagar

## Phase 8 — x-realtime Cross-port
  goal    TransportAdapter + auto-fallback + proven-transport memoization on all 4
  status  planned

### Track 8.a — Codegen detection                           [sequential]
  [x] 8.a.1   Python codegen detect x-realtime              kind: fix-tdd  @lovrozagar

### Track 8.b — TransportAdapter interface                  [parallel-after 8.a.1]
  [x] 8.b.1   Rust trait Transport + unified connect()      kind: refactor-tdd  @lovrozagar
  [x] 8.b.2   Python TransportAdapter Protocol              kind: feat-tdd  @lovrozagar
  [x] 8.b.3   Go Transport interface                        kind: feat-tdd  @lovrozagar

### Track 8.c — ResumableConnection port                    [parallel-after 8.b.3]
  [x] 8.c.1   Python ResumableConnection (asyncio)          kind: feat-tdd  @lovrozagar
  [x] 8.c.2   Go ResumableConnection (goroutines+channels)  kind: feat-tdd  @lovrozagar
  [x] 8.c.3   Rust unify ResumableConnection (drop new_*)   kind: refactor-tdd  @lovrozagar

### Track 8.d — Parity tests                                [sequential]
  [x] 8.d.1   Behavioral: drop + reconnect all 4            kind: test-tdd  @lovrozagar
  [x] 8.d.2   Behavioral: adapter swap all 4                kind: test-tdd  @lovrozagar

## Phase 9 — x-idempotency-key
  goal    Auto-UUID Idempotency-Key header on marked ops, all 4
  status  planned

### Track 9.a — Idempotency                                 [sequential]
  [x] 9.a.1   IR detect x-idempotency-key extension         kind: feat-tdd  @lovrozagar
  [x] 9.a.2   TS auto-UUID + header                         kind: feat-tdd  @lovrozagar
  [x] 9.a.3   Python auto-UUID + header                     kind: feat-tdd  @lovrozagar
  [x] 9.a.4   Go auto-UUID + header                         kind: feat-tdd  @lovrozagar
  [x] 9.a.5   Rust auto-UUID + header                       kind: feat-tdd  @lovrozagar

## Phase 10 — WebSocket Behavioral Audit
  goal    Shared WS behavioral suite green on all 4
  status  planned

### Track 10.a — WS audit                                   [sequential]
  [x] 10.a.1  Shared WS behavioral test suite               kind: test-tdd  @lovrozagar
  [x] 10.a.2  Patch divergences per lang                    kind: fix-tdd  @lovrozagar

## Phase 11 — Documentation + Examples
  goal    Public docs + examples ship; parity matrix user-facing
  status  planned

### Track 11.a — Docs                                       [parallel]
  [x] 11.a.1  Examples dir per lang                         kind: feat  @lovrozagar
  [x] 11.a.2  README parity matrix                          kind: feat  @lovrozagar
  [x] 11.a.3  API reference gen per lang                    kind: feat  @lovrozagar
