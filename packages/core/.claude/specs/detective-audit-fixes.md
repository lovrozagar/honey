# Honey Detective Audit Fixes

Findings from deep detective-mode audit (Mar 14, 2026).

## Required Approach

**Strict RED → CODE → GREEN from two perspectives:**

1. **Internal test (unit):** Write failing test against current code (RED). Confirm it fails. Implement fix (CODE). Confirm test passes (GREEN).
2. **Consumer test (integration/demo):** Write a test or demo snippet that exercises the bug from a user's perspective (RED). Confirm it fails. Verify the fix resolves it (GREEN).

Both REDs must be validated before any CODE. Both GREENs must be confirmed after.

---

## Done

### 1. emitLiteral code injection → JSON.stringify

### 2. Otel concurrent span → WeakMap per request

### 3. WS keepalive timer leak → clear in error handler

### 4. Node.js backpressure → drain await on response write, pull-based request read

### 5. ctx.search divergence → documented as first-value-only via JSDoc (option B)

### 6. Cookie value encoding → percent-encode non-cookie-octet chars

### 7. Middleware undefined return → guard with helpful error

### 8. Stream error swallowed → close writable on error

### 9. WS adapter detail leak → generic error response + log

### 10. CORS Vary on static origin → set Vary whenever allowedOrigin !== "\*"

### OpenAPI optional params → verified false positive (tree already generates both paths with required: true)

---

## Remaining

## 1. CRITICAL: Code Injection in Codegen — `emitLiteral()` Unescaped Strings

**File:** `src/codegen.ts:667`

`emitLiteral()` interpolates string values without escaping quotes or backslashes:

```ts
if (typeof value === "string") return `"${value}"`
```

Same pattern at lines 477, 481, 485 — param names, wildcard names, static segment keys all unescaped in generated `.gen.ts` and `.gen.d.ts`.

The file already uses `JSON.stringify()` correctly at line 516 for error keys — inconsistent.

**Internal RED:** Test that `emitLiteral('He said "hello"')` produces valid TS. Currently produces `"He said "hello""` (broken).

**Consumer RED:** Route with `.meta({ description: 'value with "quotes" and \\backslash' })` → generated `.gen.d.ts` has syntax error.

**Fix:** Use `JSON.stringify()` for all string values in `emitLiteral()`. Use `JSON.stringify()` for param/wildcard names and static keys in `serializeNode()`.

**Files:** `src/codegen.ts`
**Tests:** `tests/unit/codegen/codegen.test.ts`

---

## 2. HIGH: Otel Adapter — Concurrent Request Span Corruption

**File:** `src/telemetry/otel.ts:30`

`rootSpan` is a module-level `let` variable. Concurrent requests overwrite each other's span reference. Also: if a request errors before `onResponse`, span is never closed (leak).

```ts
let rootSpan: Span | null = null /* shared across all requests */
```

**Internal RED:** Two concurrent requests → second request's `onResponse` closes wrong span, first span never closed.

**Consumer RED:** Telemetry adapter under concurrent load reports wrong durations / missing spans.

**Fix:** Use a `WeakMap<Request, Span>` keyed on the request object. Pass `req` through all telemetry callbacks (already available in `onRequest` and `onResponse`). Look up span per-request instead of global variable.

**Files:** `src/telemetry/otel.ts`
**Tests:** `tests/unit/telemetry/otel.test.ts`

---

## 3. HIGH: WS Node Keepalive Timers Not Cleared on Error

**File:** `src/ws/node.ts:141-143`

Error handler doesn't clear keepalive timers:

```ts
ws.on("error", (err: unknown) => {
	handler.onError?.(undefined, socket, err) /* timers still running */
})
```

Close handler (line 136-137) clears them, but `error` can fire without `close` in edge cases (network drops). Timer fires against dead socket.

**Internal RED:** Mock ws that emits `error` without `close` → verify timers are cleared.

**Consumer RED:** WS connection with keepalive drops due to network error → timer keeps firing, callback errors pile up.

**Fix:** Clear `pingTimer` and `pongTimeout` in the error handler, same as close handler.

**Files:** `src/ws/node.ts`
**Tests:** `tests/unit/ws/ws-keepalive.test.ts`

---

## 4. HIGH: Node.js Response Write — No Backpressure

**File:** `src/node.ts:59`

`res.write(value)` ignores return value (backpressure signal). Same issue on request side (`node.ts:34`) — `controller.enqueue()` without `req.pause()`/`req.resume()`.

```ts
res.write(value) /* returns false when buffer full — ignored */
```

**Internal RED:** Slow client (throttled writable) + large response body → verify write respects backpressure (buffer doesn't grow unbounded).

**Consumer RED:** SSE or large JSON response to slow client → memory spike.

**Fix:**

- Response: check `res.write()` return, `await` drain event when `false`.
- Request: implement `pull()` in ReadableStream using `req.pause()`/`req.resume()`.

**Files:** `src/node.ts`
**Tests:** `tests/unit/node/node.test.ts`

---

## 5. MEDIUM: `ctx.search` vs `validateInput` — Divergent Multi-Value Handling

**File:** `src/context.ts:96-97`

`ctx.search` keeps first value only for duplicate keys:

```ts
if (search[key] === undefined) {
	search[key] = value /* drops ?tag=a&tag=b → { tag: "a" } */
}
```

But `validateInput` in `validation.ts:136-143` correctly builds arrays. Same URL, two different results depending on access path.

**Internal RED:** `ctx.search` for `?tag=a&tag=b` returns `"a"`, assert it should return `["a", "b"]` or document first-value semantics.

**Consumer RED:** Handler reads `ctx.search.tag` expecting all values, gets only first.

**Fix:** Two options:

- **A.** Match validation behavior — return `string | string[]` (breaking change to `ctx.search` type).
- **B.** Keep first-value semantics, document it, add `ctx.searchAll` or similar for multi-value access.

Recommendation: **B** — `ctx.search` is a convenience accessor for simple cases. Multi-value should go through `.input({ search: schema })`. Document the divergence in JSDoc.

**Files:** `src/context.ts`
**Tests:** `tests/unit/core/core.test.ts`

---

## 6. MEDIUM: Cookie Serialization — Values Not Encoded

**File:** `src/response.ts:47`

Cookie value used raw without encoding:

```ts
let cookie = `${name}=${opts.value}`
```

Values with spaces, semicolons, or quotes produce malformed `Set-Cookie` headers. RFC 6265 requires cookie-octets only (no whitespace, quotes, commas, semicolons, backslashes).

**Internal RED:** `serializeCookie("k", { value: "hello world" })` produces `k=hello world` — assert it produces `k=hello%20world` or `k="hello world"`.

**Consumer RED:** `ctx.res.json("ok", data, { cookies: [{ name: "msg", value: "hi there" }] })` → malformed Set-Cookie header.

**Fix:** Percent-encode non-cookie-octet characters in value. Don't encode name (throw on invalid name chars instead).

**Files:** `src/response.ts`
**Tests:** `tests/unit/response/response.test.ts` or `tests/unit/core/core.test.ts`

---

## 7. MEDIUM: Middleware Undefined Return — No Guard

**File:** `src/middleware.ts:76-88`

If middleware forgets `return next()`, the chain returns `undefined`. Crash occurs at `response.status` with unhelpful error.

```ts
return mw({ ctx, next }) /* mw() may return undefined */
```

**Internal RED:** Middleware that calls `next()` but doesn't `return` it → assert meaningful error message.

**Consumer RED:** User writes `async ({ next }) => { next() }` (missing return) → gets "Cannot read property 'status' of undefined" instead of helpful error.

**Fix:** Wrap dispatch to check return: `const result = await mw(...); if (!(result instanceof Response)) throw new Error("middleware must return a Response — did you forget 'return next(...)'?")`

**Files:** `src/middleware.ts`
**Tests:** `tests/unit/middleware/double-next.test.ts` or new test file

---

## 8. MEDIUM: Stream Error Silently Swallowed

**File:** `src/response.ts:202`

```ts
callback(writable).catch(() => {})
```

If user's stream callback throws, error disappears. Client gets incomplete stream. Compare with SSE (line 183-184) which cleans up timer and closes writer.

**Internal RED:** Stream callback that throws → assert writable is closed and error is surfaced.

**Consumer RED:** `ctx.res.stream(async (w) => { throw new Error("oops") })` → client hangs on incomplete response.

**Fix:** Close writable on error, log via logger if available:

```ts
callback(writable).catch((e) => {
	writable.close()
})
```

**Files:** `src/response.ts`
**Tests:** `tests/unit/response/response.test.ts`

---

## 9. MEDIUM: WS Adapter Not Configured — Internal Detail Leaked

**File:** `src/index.ts:500`

```ts
return new Response(JSON.stringify({ error: "WebSocket adapter not configured" }), ...)
```

Tells client about server internals.

**Internal RED:** Request to WS route without adapter → assert response doesn't contain "adapter not configured".

**Consumer RED:** Production deploy forgets WS adapter → client sees internal config details.

**Fix:** Return generic error via `this._createError("internal_server_error", "internal_server_error")` + log the detail server-side via logger.

**Files:** `src/index.ts`
**Tests:** `tests/unit/ws/ws.test.ts`

---

## 10. LOW: CORS Missing `Vary: Origin` on Static Origin

**File:** `src/cors.ts:63-64`

`Vary: Origin` only set when origin is dynamic (function/array). Static string origin doesn't set Vary. If a CDN caches this response, requests from other origins get wrong CORS headers.

```ts
if (isDynamic) {
	corsHeaders.set("vary", "Origin")
}
```

**Internal RED:** CORS with static origin → assert `Vary: Origin` header present on preflight and actual responses.

**Consumer RED:** App behind CDN with static CORS origin → second origin's request gets cached first origin's headers.

**Fix:** Always set `Vary: Origin` when origin is not `"*"`. Wildcard doesn't need Vary (same for all origins).

**Files:** `src/cors.ts`
**Tests:** `tests/unit/cors/cors.test.ts`

---

## 11. LOW: Telemetry Middleware Re-wrap Per Request

**File:** `src/index.ts:697-710`

When telemetry is enabled, ALL middlewares are re-wrapped into new closures on every request. High concurrency = extra GC pressure.

**Internal RED:** Benchmark: telemetry enabled, measure allocation count per request vs without.

**Consumer RED:** Not a correctness issue — performance optimization only.

**Fix:** Cache wrapped middlewares at handler registration time (in `RouteBuilder.handler()`), not per-request. Store wrapped version alongside `handler.mw`.

**Files:** `src/index.ts`
**Tests:** Performance test or existing telemetry tests
