# Bit 05 — streaming, SSE, range

Closes: A3 (range/206) · (SSE typing shared with bit 08/H10)
Oracle kept green: `tests/integration/streaming.test.ts`, `conformance/sse` (now gen), stream-lifecycle suite.

## Scope
Web-Streams response bodies, the SSE emitter plumbing, and Range/206 for binary/stream bodies (also wired into `static` in bit 07/08). The declared SSE event schema is typed by the response model (bit 08); this bit owns the transport.

## Files (from files.tsv — `streaming` + `response/range`)
- `src/streaming/producer-stream.ts` (+test) — drive a `ReadableStream` body, backpressure, abort.
- `src/response/range.ts` (+test) — parse `Range`, emit `Accept-Ranges` + `Content-Range`, 206 for a sized/seekable body (A3).

`ctx.res.stream()` and `ctx.res.generate()` are added here, **extending the bit-02 `response.ts`** (born there; H13 extend-an-earlier-file), beside `producer-stream.ts`. `sse.ts` is the SSE emitter. No registry/slot/side-effect — plain response helpers (H23).

## Tests (named, written first)
- `streaming/producer-stream.test.ts` — stream completes; client abort cancels the producer; no leak.
- `response/range.test.ts` — single range → 206 + `Content-Range`; unsatisfiable → 416; no `Range` → 200.
- `response/sse.test.ts` — event framing; `Last-Event-ID` echoed for resume (parity with bit 06); an explicit empty `id:` emits (reset, H18.6).
- `tests/integration/streaming.test.ts` — app-level `ctx.res.stream`/`generate`/`sse`/`range` through `app.fetch`: completion + client-abort-cancels-producer (no leak), generate, SSE framing + `Last-Event-ID` resume, `Range` → 206/416/200. Split named (streaming/sse/range) only if >500.

## Security corpus
- SSE/stream memory: an aborted or slow client must not grow unbounded buffers; range with absurd bounds rejected (DoS).

## Budget
- perf: streaming throughput + abort latency within threshold.
- token: n/a.
