# Honey Next Features

Features identified from Hono/Elysia comparison (Mar 14, 2026).

## Approach

RED → CODE → GREEN. No shortcuts.

1. Write ALL tests first — internal + consumer. Every test must exercise the exact behavior.
2. Run tests. Every one must FAIL (RED).
3. Only after all REDs confirmed: implement.
4. Run tests. Every one must PASS (GREEN).
5. Full suite. Zero regressions.

All new features MUST be separate exports for tree-shaking. Nothing goes in `index.ts`. Each gets its own `package.json` exports entry.

---

## Implementation Order

1. ETag — bandwidth savings on repeated GETs
2. Server-Timing — perf metrics in browser DevTools
3. Generator handler support — cleaner streaming DX
4. Content negotiation — multi-format response helper

---

## 1. ETag Middleware

**Problem:** Client GETs `/api/orgs` repeatedly. Response is 50KB JSON, unchanged between requests. Without ETag, server sends full 50KB every time. With ETag, server hashes the response, client sends `If-None-Match` on next request, server returns 304 (empty body) if hash matches. Saves bandwidth, reduces latency, lowers client parsing cost.

**How:** Middleware runs after handler. Hashes response body (SHA-1 via Web Crypto or simple FNV-1a for speed). Sets `ETag` header as `W/"<hash>"` (weak validator). On subsequent request, compares `If-None-Match` header against hash. Match → 304 with empty body. No match → full response with new ETag.

**Tradeoff:** Must buffer response body to hash it. Not suitable for streaming responses — skip if `Transfer-Encoding: chunked` or body is ReadableStream.

**API:**

```ts
import { etag } from "honey/etag"

app.use(etag())
app.use(etag({ weak: true })) /* default: weak validator */
```

**Export:** `./etag` → `src/etag.ts`

**Tests — internal:**

- GET response gets `ETag` header
- Subsequent GET with matching `If-None-Match` → 304 empty body
- Subsequent GET with non-matching `If-None-Match` → 200 full body with new ETag
- POST/PUT/DELETE → no ETag (only safe methods)
- Streaming response → ETag skipped (no buffering)
- HEAD request → ETag present, no body
- ETag format: `W/"<hex>"` for weak, `"<hex>"` for strong
- Same response body → same ETag (deterministic)
- Different response body → different ETag

**Tests — consumer:**

- JSON API endpoint: first GET → 200 + ETag, second GET with If-None-Match → 304
- Large response: bandwidth saved on cache hit (304 body is empty)

**Files:** `src/etag.ts`, `tests/unit/middleware/etag.test.ts`

---

## 2. Server-Timing Middleware

**Problem:** Slow API response — is it the DB? Auth middleware? JSON serialization? Without metrics, you add logging, deploy, reproduce, grep logs. With Server-Timing, the response header carries named durations visible in browser DevTools Network tab, zero extra tooling.

**How:** Middleware creates a timing context, passes it through to handler via `next({ timing })`. Handler and downstream middleware call `timing.start("db")` / `timing.end("db")`. After handler returns, middleware reads all recorded timings and sets `Server-Timing` header.

**Format:** `Server-Timing: db;dur=53.2, auth;dur=1.1, total;dur=67.8`

Each entry: `name;dur=milliseconds` optionally with `;desc="description"`.

**API:**

```ts
import { serverTiming } from "honey/server-timing"

app.use(serverTiming())

app.get("/users").handler((ctx) => {
	ctx.timing.start("db")
	const users = await db.query("SELECT * FROM users")
	ctx.timing.end("db")

	return ctx.res.json("ok", users)
})
```

**Export:** `./server-timing` → `src/server-timing.ts`

**Timing interface:**

```ts
type Timing = {
	start(name: string, description?: string): void
	end(name: string): void
}
```

**Tests — internal:**

- Response has `Server-Timing` header after middleware
- `timing.start("x")` + `timing.end("x")` → `x;dur=<ms>` in header
- Multiple timings → comma-separated in header
- Description included: `x;desc="DB query";dur=50`
- `timing.end("x")` without `timing.start("x")` → ignored (no crash)
- `timing.start("x")` without `timing.end("x")` → measures until response (auto-close)
- Timing values are non-negative numbers

**Tests — consumer:**

- API response with timing → visible in `Server-Timing` header
- Multiple middleware each add their own timing → all appear in header

**Files:** `src/server-timing.ts`, `tests/unit/middleware/server-timing.test.ts`

---

## 3. Generator Handler Support

**Problem:** Streaming a CSV export, chunked JSON array, or real-time data requires manual WritableStream management:

```ts
ctx.res.stream(async (writable) => {
	const writer = writable.getWriter()
	for (const row of dataset) {
		await writer.write(encode(row))
	}
	await writer.close()
})
```

With generator support:

```ts
async function* handler(ctx) {
	for (const row of dataset) {
		yield JSON.stringify(row) + "\n"
	}
}
```

Less boilerplate. Framework handles encoding, stream lifecycle, backpressure, cleanup.

**How:** In `HoneyRes`, add a method that accepts an `AsyncGenerator` (or sync `Generator`) and wraps it in a ReadableStream. Each `yield` becomes a chunk. Generator return/throw closes the stream. Backpressure handled by `pull()` — only call `generator.next()` when consumer is ready.

**API:**

```ts
/* on HoneyRes */
ctx.res.generate(
	async function* () {
		yield "chunk 1\n"
		yield "chunk 2\n"
	},
	{ contentType: "text/plain" },
)

/* or with status key */
ctx.res.generate(
	async function* () {
		for (const row of rows) {
			yield JSON.stringify(row) + "\n"
		}
	},
	{ contentType: "application/x-ndjson", status: 200 },
)
```

**Export:** Part of core `HoneyRes` — NOT a separate export. This is a response method like `json()`, `text()`, `stream()`. Goes in `src/response.ts`.

**Tests — internal:**

- Sync generator → response body has all yielded chunks
- Async generator → response body has all yielded chunks
- Generator that throws → stream closed, error not swallowed
- Empty generator (yields nothing) → empty body
- Backpressure: slow consumer → generator pauses (pull-based)
- Generator return value ignored (only yields matter)
- Content-type set from options
- Default content-type: `application/octet-stream`
- Generator cleanup: `finally` block runs on early consumer abort

**Tests — consumer:**

- NDJSON streaming: yield JSON lines → client reads line by line
- CSV export: yield header + rows → complete CSV received
- Large dataset: 10k yields → all received, no memory spike

**Files:** `src/response.ts`, `tests/unit/response/response.test.ts`

---

## 4. Content Negotiation Helper

**Problem:** API serves JSON by default but some endpoints could serve CSV or HTML. Client sends `Accept: text/csv;q=1.0, application/json;q=0.9`. Without negotiation, you ignore the header and always return JSON. With it, you check what the client prefers and respond accordingly.

**How:** Pure function. Takes the request (or Accept header string) and an array of supported types. Parses `Accept` header, extracts media types with quality factors, returns the best match. No middleware — just a utility.

**Accept header format:** `type/subtype;q=0.0-1.0`, comma-separated, highest q wins. Missing q defaults to 1.0. `*/*` matches anything.

**API:**

```ts
import { accepts } from "honey/accepts"

app.get("/data").handler((ctx) => {
	const type = accepts(ctx.req, ["application/json", "text/csv", "text/html"])

	if (type === "text/csv") return ctx.res.csv("ok", csvData)
	if (type === "text/html") return ctx.res.html("ok", htmlView)
	return ctx.res.json("ok", jsonData)
})
```

**Return:** Best matching type string, or `null` if no match (caller handles 406).

**Export:** `./accepts` → `src/accepts.ts`

**Tests — internal:**

- `Accept: application/json` + supported `["application/json"]` → `"application/json"`
- `Accept: text/csv;q=1.0, application/json;q=0.9` + both supported → `"text/csv"`
- `Accept: text/html` + supported `["application/json"]` → `null`
- `Accept: */*` + supported `["application/json"]` → `"application/json"`
- No Accept header → first supported type (default)
- `Accept: text/*` + supported `["text/csv", "application/json"]` → `"text/csv"`
- Quality factors: `q=0` means "never", excluded from matching
- Multiple types same q → first in supported array wins (server preference)
- Malformed Accept header → fallback to first supported type

**Tests — consumer:**

- API endpoint returns JSON to `Accept: application/json`, CSV to `Accept: text/csv`
- No Accept header → default JSON response

**Files:** `src/accepts.ts`, `tests/unit/accepts/accepts.test.ts`
