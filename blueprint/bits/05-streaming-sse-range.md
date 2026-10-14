# Bit 05 — streaming, SSE, range

Closes: A3 (range/206) · (SSE typing shared with bit 08/H10)
Oracle kept green: `tests/integration/streaming.test.ts`, `conformance/sse` (now gen), stream-lifecycle suite.

## Scope
Web-Streams response bodies, the SSE emitter plumbing, and Range/206 for binary/stream bodies (also wired into `static` in bit 07/08). The declared SSE event schema is typed by the response model (bit 08); this bit owns the transport.

**Rulings (bit 05):**
- **Range (A3) is a plain helper `rangeResponse(request, body, init?)`** in `range.ts`, not a `ctx.res` method (`ctx.res` has no request access; the surface names a "range helper"). Body = `Uint8Array | Blob | { size, slice(start, endInclusive) }`. `Accept-Ranges: bytes` on every 200/206; only GET/HEAD honor `Range`; forms `bytes=a-b|a-|-n`. Single satisfiable → 206 + `Content-Range`; multi → 200 full (static.md); malformed → 200 ignored (RFC 9110 §14.2); unsatisfiable → 416 + `Content-Range: bytes */size`. A position past 15 digits / `MAX_SAFE_INTEGER` is malformed → 200, parse cost linear in header length (the DoS corpus). `If-Range` serves the full 200 until A4 adds validators (RFC-safe). Its **public export path (`./range` vs main) is decided at cutover** with the exports map (exports is `{}` until then); plain import, no self-registration.
- **Producer failure errors the body** (the client sees a broken transfer); the `ProducerOptions.report` seam stays unwired until bit 07 connects the logger (case `739857836c` → 07). Not `console` (no-console); the adapter already reports via its `onError`/`emitWarning` default.
- **`ctx.res` gets request-derived data by a plain constructor arg, not a subclass.** `HoneyContext` builds `new HoneyRes(nodeOut, link)` with `link = { lastEventId(): string | undefined, signal(): AbortSignal }`, both read lazily on first use; a bare `HoneyRes` (unit tests) has no link (no signal/lastEventId). `sse()` defaults `lastEventId` from the `Last-Event-ID` header; every producer ends with `ctx.signal`.
- **HEAD never starts the producer** (Bun/Workers already don't read a HEAD body). `writeResponse(response, res, head)` (extending bit-04 `node/response.ts`) writes the head with GET's `content-length` kept, ends, and cancels the body unread.
- **The BODY_KIND stream tag is born at bit 08** with `body-kind` (no consumer at 05 — etag/compress/bodyLimit are 07/08; the tag would be dead code). Case `be6ccf73ce` → 08.
- **`sse()`/`stream()`/`generate()` return-type branding typetests land here** (the methods are born here); the typed SSE event *schema* is bit 08 (H10).

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
