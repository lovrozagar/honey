# Honey Competitive Gap Fixes

Gaps identified by deep-scanning Hono and Elysia source code (Mar 14, 2026).

## Approach

RED → CODE → GREEN. No shortcuts.

1. Write ALL tests first — internal (unit) + consumer (integration). Every test must exercise the exact behavior gap.
2. Run tests. Every single one must FAIL (RED). If a test passes, the gap doesn't exist or the test is wrong — fix or remove it.
3. Only after all REDs are confirmed: implement the fix.
4. Run tests again. Every single one must PASS (GREEN). Both internal and consumer perspectives.
5. Run full suite. Zero regressions.

DO NOT write code before confirming RED. DO NOT skip consumer tests. DO NOT be lazy — go deep on edge cases, error paths, and boundary conditions.

---

## Implementation Order (by importance)

1. Body size limit — OOM with single request
2. Request timeout — hung handler = cascading failure
3. CSRF — form-based state mutation from any origin
4. SSE spec compliance — broken multiline data corrupts every SSE client
5. Cookie name validation — malformed Set-Cookie = silent header corruption
6. Secure headers — clickjacking, XSS amplification, MIME sniffing
7. Cookie signing — unsigned cookies = trivial session tampering
8. Request ID — no correlation = blind debugging

---

## 1. Body Size Limit Middleware

**Gap:** Hono has `body-limit` middleware. Elysia has `parse.maxBodySize`. Honey has nothing.

**Problem:** HTTP has no inherent body size constraint. `curl -X POST -d @/dev/urandom http://target/api` forces the server to allocate memory until OOM. Chunked transfer-encoding is worse — no Content-Length to reject early, the server reads until death. This is the cheapest DoS attack possible.

**Why framework:** Every route that accepts a body is vulnerable. Leaving this to userland means every app is insecure by default.

**How:** Two-phase check, never buffers:

- **Fast path:** Compare `Content-Length` header against `maxSize`. Reject with 413 before reading any bytes.
- **Slow path (chunked/no Content-Length):** Wrap the request body ReadableStream in a counting proxy that tracks bytes per chunk. When cumulative count exceeds `maxSize`, error the stream. The handler's `await req.json()` rejects, error propagates, 413 response sent. Chunks still flow through one at a time — zero buffering. Only overhead is incrementing an integer per chunk.

**API:**

```ts
import { bodyLimit } from "honey"

app.use(bodyLimit({ maxSize: 1024 * 1024 }))
```

**Status key:** Add `content_too_large` → 413 to types.ts StatusKey map.

**Tests — internal:**

- Content-Length > maxSize → 413, body never read
- Content-Length <= maxSize → passes through
- Content-Length absent, body under limit → passes through
- Content-Length absent, body exceeds limit mid-stream → 413
- GET/HEAD/OPTIONS with Content-Length > maxSize → still allowed (no body semantics)
- Exact boundary: maxSize = 100, body = 100 bytes → passes; 101 bytes → 413
- maxSize = 0 → rejects any body

**Tests — consumer:**

- POST JSON body exceeding limit → structured error response with `error_key: "content_too_large"`
- Streaming upload that exceeds limit → request aborted mid-read, no OOM
- Routes without body limit middleware → unaffected (no global side effects)

**Files:** `src/body-limit.ts`, `tests/unit/middleware/body-limit.test.ts`

---

## 2. Request Timeout Middleware

**Gap:** Hono has `timeout` middleware. Honey has nothing.

**Problem:** A handler that awaits a dead database connection, an infinite loop in validation, or a third-party API that never responds — the request hangs forever. The HTTP connection stays open, the worker is consumed, under load all workers hang = total service outage. Unlike a crash (which frees resources), a hang is silent death.

**Why framework:** `Promise.race` against a timer is 5 lines, but every handler needs it. A single unprotected route can take down the entire service.

**How:** Middleware that races `next()` against `setTimeout`. If timer wins, throw `HoneyError` with 504. Clear timer on success to avoid leaks. Wraps the entire downstream chain — catches hangs at any depth.

**API:**

```ts
import { timeout } from "honey"

app.use(timeout({ duration: 30_000 }))
app.use(timeout({ duration: 5_000, status: "bad_gateway" }))
```

**Status keys:** Add `gateway_timeout` → 504 and `request_timeout` → 408 to types.ts if missing.

**Tests — internal:**

- Handler takes 200ms, timeout 50ms → 504 (or configured status)
- Handler takes 10ms, timeout 100ms → normal response
- Timer cleared on success (no dangling setTimeout)
- Custom status key works
- Timeout fires through nested middleware chain (middleware → middleware → handler)
- Error from handler (not timeout) → propagates normally, not swallowed by race

**Tests — consumer:**

- Slow DB query exceeding timeout → graceful 504 error response
- Fast endpoint unaffected by timeout middleware
- Timeout error has `error_key: "request_timeout"` in response body

**Files:** `src/timeout.ts`, `tests/unit/middleware/timeout.test.ts`

---

## 3. CSRF Protection Middleware

**Gap:** Hono validates Origin + Sec-Fetch-Site headers. Elysia has CSRF plugin. Honey has nothing.

**Problem:** Browser sends cookies automatically on every request. `<form action="https://yourapi.com/transfer" method="POST">` on `evil.com` submits with victim's session cookie. State mutation happens. CORS doesn't protect — CORS controls reading responses, not sending requests.

**Why framework:** Protection requires header-based validation. Header-based CSRF is stateless — no tokens, no server-side state, no client-side storage. The browser sets `Sec-Fetch-Site` and `Origin` headers that JS on other origins cannot forge. The middleware just reads them.

**How:** Three checks in order:

1. Skip safe methods (GET, HEAD, OPTIONS) — they should be idempotent
2. Skip non-form Content-Types — `application/json` triggers CORS preflight, inherently safe
3. For form-like requests (`application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`):
   - Check `Sec-Fetch-Site` header (modern browsers, unforgeable by JS) — allow `same-origin`
   - Fall back to `Origin` header check against allowed origins
   - If neither passes → 403

No client keys. No tokens. Browser is both the attack vector and the enforcement mechanism. Non-browser clients (Postman, curl) don't have the victim's cookies so are irrelevant to CSRF.

**API:**

```ts
import { csrf } from "honey"

app.use(csrf()) /* default: same-origin only */
app.use(csrf({ origin: "https://myapp.com" }))
app.use(csrf({ origin: ["https://app.com", "https://admin.com"] }))
app.use(csrf({ origin: (o) => o.endsWith(".myapp.com") }))
```

**Tests — internal:**

- POST with `Sec-Fetch-Site: cross-site` + form content-type → 403
- POST with `Sec-Fetch-Site: same-origin` → allowed
- POST with no `Sec-Fetch-Site` but matching `Origin` → allowed
- POST with no `Sec-Fetch-Site` and wrong `Origin` → 403
- POST with `Content-Type: application/json` → allowed (skipped, CORS handles it)
- GET → always allowed regardless of origin
- HEAD → always allowed
- OPTIONS → always allowed
- POST with `text/plain` content-type from cross-origin → 403 (form-submittable)
- Origin as string array → matching any allowed
- Origin as function → called with origin string
- No `Origin` header, no `Sec-Fetch-Site` header → 403 (deny by default)

**Tests — consumer:**

- Same-origin form POST with session cookie → allowed
- Cross-origin form POST → 403 with `error_key: "forbidden"`
- JSON API POST from any origin → allowed (not form content-type)
- CSRF middleware + CORS middleware coexist without conflict

**Files:** `src/csrf.ts`, `tests/unit/middleware/csrf.test.ts`

---

## 4. SSE Spec Compliance

**Gap:** Hono validates event/id/retry for newlines and splits multiline data. Honey does neither.

**Problem:** SSE spec uses `\n` as frame delimiter. `data: {"key": "line1\nline2"}\n\n` is parsed by EventSource as TWO events: `data: {"key": "line1` and `line2"}`. Both invalid JSON. Every SSE client in every browser behaves this way. This isn't an edge case — any JSON payload with a string containing `\n` triggers it.

**Why framework:** The spec mandates multiline data be sent as separate `data:` prefixed lines. If the framework doesn't split, every SSE user hits this in production when real data arrives.

**How:** Two changes to `SSEStream.send()`:

1. **Validate** `event.event` and `event.id` — throw if they contain `\r` or `\n` (these fields cannot be multiline per spec)
2. **Split** data by `/\r\n|\r|\n/`, prefix each line with `data: `, join with `\n`. Browser's EventSource reconstructs by concatenating `data:` lines with `\n`.

**Tests — internal:**

- Multiline data string → output has multiple `data:` lines
- `data: "line1\nline2"` → `data: line1\ndata: line2\n\n`
- `data: "a\r\nb\rc"` → `data: a\ndata: b\ndata: c\n\n` (all newline variants)
- Single-line data → unchanged behavior (one `data:` line)
- Event name with `\n` → throws Error
- Event id with `\r` → throws Error
- Event name and id without newlines → no error
- Retry field with newline → throws Error
- Empty data string → `data: \n\n`
- Data with trailing newline → correct number of `data:` lines (no extra empty)

**Tests — consumer:**

- JSON object with multiline string value → parseable by EventSource
- Concurrent SSE sends with mixed single/multiline data → all frames valid

**Files:** `src/response.ts`, `tests/unit/response/response.test.ts`

---

## 5. Cookie Name Validation

**Gap:** Hono validates cookie names with RFC 6265 regex. Honey doesn't validate at all.

**Problem:** Cookie names are tokens per RFC 6265 — alphanumeric plus `!#$%&'*+-.^_|~`. A name with a space (`user name=value`) or semicolon (`bad;name=value`) produces a malformed `Set-Cookie` header. The browser silently ignores it — cookie never set, server thinks it was. Session cookies, CSRF tokens, consent flags — all silently broken with no error anywhere.

**Why framework:** The failure is completely silent. Server sends header, browser drops it, next request has no cookie. Users see infinite login loops or lost state. Validating at serialization time turns a silent production bug into a loud development error.

**How:** One regex check at the top of `serializeCookie`: `/^[\w!#$%&'*.^`|~+-]+$/`. If it fails, throw with the invalid name in the message.

**Tests — internal:**

- `serializeCookie("valid_name", { value: "x" })` → no error
- `serializeCookie("also-valid.name", { value: "x" })` → no error
- `serializeCookie("bad name", { value: "x" })` → throws (space)
- `serializeCookie("bad;name", { value: "x" })` → throws (semicolon)
- `serializeCookie("bad=name", { value: "x" })` → throws (equals)
- `serializeCookie("bad\tname", { value: "x" })` → throws (tab)
- `serializeCookie("", { value: "x" })` → throws (empty)
- `serializeCookie("bad,name", { value: "x" })` → throws (comma)

**Tests — consumer:**

- Response with invalid cookie name → error at serialization, not silent header corruption
- Response with valid cookie name → Set-Cookie header correct

**Files:** `src/response.ts`, `tests/unit/response/response.test.ts`

---

## 6. Secure Headers Middleware

**Gap:** Hono has `secure-headers` middleware. Honey has nothing.

**Problem:** Missing `X-Content-Type-Options: nosniff` lets browsers MIME-sniff uploaded files — a `.txt` containing `<script>` executes as HTML. Missing `X-Frame-Options` lets any site iframe your app for clickjacking. Missing `Referrer-Policy` leaks full URLs (with tokens in query strings) to third parties.

**Why framework:** Same headers for every response on every route. A middleware with sensible defaults gives security for free.

**How:** Middleware that runs after `next()` and appends headers. Sensible defaults, overridable per-key. Optional headers (CSP, HSTS) only set if explicitly configured.

**API:**

```ts
import { secureHeaders } from "honey"

app.use(secureHeaders())
app.use(
	secureHeaders({
		contentSecurityPolicy: "default-src 'self'",
		strictTransportSecurity: "max-age=31536000; includeSubDomains",
		xFrameOptions: "DENY",
	}),
)
```

**Default headers:**

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-XSS-Protection: 0` (deprecated but still recommended to disable)

**Optional headers (only if configured):**

- `Content-Security-Policy`
- `Strict-Transport-Security`
- `Permissions-Policy`
- `Cross-Origin-Opener-Policy`
- `Cross-Origin-Resource-Policy`
- `Cross-Origin-Embedder-Policy`

**Tests — internal:**

- Default config → all 4 default headers present
- Custom `xFrameOptions: "DENY"` → overrides default SAMEORIGIN
- CSP configured → header present; not configured → header absent
- HSTS configured → header present; not configured → header absent
- Handler-set headers preserved (middleware doesn't clobber)
- `false` value for any header → header not set (opt-out)

**Tests — consumer:**

- App with `secureHeaders()` → browser DevTools shows all security headers
- App without middleware → headers absent (no side effects from import)

**Files:** `src/secure-headers.ts`, `tests/unit/middleware/secure-headers.test.ts`

---

## 7. Cookie Signing (HMAC-SHA256)

**Gap:** Both Hono and Elysia support signed cookies. Honey doesn't.

**Problem:** Cookies are client-side storage. `userId=42` can be changed to `userId=1` (admin) with DevTools. Encryption is overkill — you don't need to hide the value, you need to detect tampering.

**Why framework:** HMAC signing is crypto code easy to get wrong (timing attacks, weak keys, encoding). Key rotation (accepting old signatures during migration) is another subtlety. Without it, every app either uses server-side session stores or trusts client-supplied cookies.

**How:** `crypto.subtle.sign("HMAC", key, value)` → base64url → append as `value.signature`. On read, split at last `.`, verify signature against each key in rotation array. Web Crypto API works in all runtimes.

**API:**

```ts
import { sign, verify } from "honey/cookie"

const signed = await sign("user-123", secret)
/* "user-123.dGhpcyBpcyBhIHNpZ25hdHVyZQ" */

const value = await verify(signed, [currentSecret, oldSecret])
/* "user-123" or null if tampered */
```

**Tests — internal:**

- `sign("value", key)` → produces `value.{base64url}`
- `verify(signed, [key])` → returns original value
- `verify("value.tampered", [key])` → returns null
- `verify("value.old-sig", [newKey, oldKey])` → returns value (key rotation)
- `verify("no-dot", [key])` → returns null
- `verify("", [key])` → returns null
- Different keys produce different signatures
- Signature is constant-time compared (timing attack safe)

**Tests — consumer:**

- Signed cookie round-trip: set with signing → read and verify → original value
- Tampered cookie → verification fails, handler gets null

**Files:** `src/cookie-sign.ts`, `tests/unit/cookie/cookie-sign.test.ts`

---

## 8. Request ID Middleware

**Gap:** Hono has `request-id` middleware. Honey has nothing.

**Problem:** In distributed systems, a user action triggers requests across multiple services. Without a correlation ID, debugging production issues is grepping logs by timestamp and hoping.

**Why framework:** The pattern is universal — read `X-Request-Id`, generate if missing, propagate to logs and outgoing requests. 10 lines but every service needs it. Framework inclusion means consistent header naming.

**How:** Middleware that reads `X-Request-Id` header (from load balancer/gateway), or generates `crypto.randomUUID()`. Adds `requestId` to context via `next({ requestId })`. Sets `X-Request-Id` on response.

**API:**

```ts
import { requestId } from "honey"

app.use(requestId())
app.use(
	requestId({
		header: "X-Correlation-Id",
		generator: () => crypto.randomUUID(),
	}),
)
```

**Tests — internal:**

- No incoming header → generates UUID, sets on response
- Incoming `X-Request-Id: abc` → uses `abc`, sets on response
- Custom header name works
- Custom generator function used
- Generated ID is valid UUID format
- `ctx.requestId` accessible in handler

**Tests — consumer:**

- Request → response has `X-Request-Id` header
- Chain of requests: upstream ID propagated to downstream
- Handler logs include request ID from context

**Files:** `src/request-id.ts`, `tests/unit/middleware/request-id.test.ts`
