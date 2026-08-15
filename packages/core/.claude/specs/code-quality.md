# Code Quality Refactoring

Code quality issues identified from audit (Mar 15, 2026). No new features — pure refactoring for maintainability.

## Approach

Refactoring only. Zero behavior changes. Every test must pass before and after. No new tests needed — existing 780 tests ARE the regression suite.

Run full suite after each refactor step. If anything breaks, revert and re-approach.

---

## Implementation Order

1. Magic string constants — 31 scattered strings → centralized constants
2. Error fallback helper — eliminates 4 duplicates, smallest change, unblocks #3
3. Extract fetch() into private methods — the big one, depends on #2
4. Form parsing helper — eliminates 3 duplicate forEach loops
5. Cookie serialization extraction — move cookie logic out of response.ts
6. TreeNode/RouteHandler JSDoc — zero code change
7. Error message improvement — string-only changes

---

## 1. Magic String Constants

**Problem:** 31 magic error key and status key strings scattered across 7 files. `"internal_server_error"` appears 10 times. Typo in any one = silent bug (error key doesn't match, runtime enforcement fails, i18n lookup misses).

**Inventory:**

- `"internal_server_error"` — 10 occurrences across index.ts, validation.ts
- `"not_found"` — 2 occurrences in index.ts
- `"method_not_allowed"` — 2 occurrences in index.ts, telemetry
- `"validation_failed"` — 1 in validation.ts
- `"output_validation_failed"` — 1 in validation.ts
- `"output_content_type_mismatch"` — 1 in index.ts
- `"unsupported_media_type"` — 1 in validation.ts
- `"content_too_large"` — 2 in body-limit.ts
- `"gateway_timeout"` — 1 in timeout.ts
- `"request_timeout"` — 1 in timeout.ts
- `"forbidden"` — 4 in csrf.ts, ip-restrict.ts

**Fix:** Add constants to types.ts (or new `src/error-keys.ts`):

```ts
export const ERROR_KEYS = {
	forbidden: "forbidden",
	internal_server_error: "internal_server_error",
	method_not_allowed: "method_not_allowed",
	not_found: "not_found",
	output_content_type_mismatch: "output_content_type_mismatch",
	output_validation_failed: "output_validation_failed",
	content_too_large: "content_too_large",
	request_timeout: "request_timeout",
	unsupported_media_type: "unsupported_media_type",
	validation_failed: "validation_failed",
} as const

export const STATUS = {
	bad_request: "bad_request",
	forbidden: "forbidden",
	gateway_timeout: "gateway_timeout",
	internal_server_error: "internal_server_error",
	not_found: "not_found",
	content_too_large: "content_too_large",
	unprocessable_entity: "unprocessable_entity",
} as const satisfies Record<string, StatusKey>
```

Then replace all magic strings: `errorKey: ERROR_KEYS.internal_server_error, status: STATUS.internal_server_error`.

Typo in constant name → compile error. Typo in string value → impossible (defined once).

**Files:** `src/types.ts` (add constants), all 7 files using magic strings (replace)
**Risk:** Low — mechanical find-and-replace. Types enforce correctness.

---

## 2. Error Fallback Helper

**Problem:** Same try/catch error-to-response conversion duplicated 4 times in index.ts:

- WS upgrade error (lines ~568-577)
- 404 chain middleware error (lines ~616-625)
- 405 chain middleware error (lines ~677-686)
- Handler error (lines ~803-823 — this one is more complex with i18n + onError)

**Fix:** Extract private method:

```ts
private _toErrorResponse(thrown: unknown): Response {
    const error = thrown instanceof HoneyError
        ? thrown
        : new HoneyError({
            cause: thrown,
            errorKey: "internal_server_error",
            status: "internal_server_error",
        })
    return createErrorResponse(error, this._errorFormatter)
}
```

Replace the 3 simple catch blocks (WS, 404, 405) with `return this._toErrorResponse(thrown)`.

The handler error catch block (lines ~803-823) is more complex — it has i18n translation and onError hook. Don't extract that one, just the 3 simple ones.

**Files:** `src/index.ts`
**Risk:** Low — mechanical replacement, behavior identical.

---

## 3. Extract fetch() Into Private Methods

**Problem:** `fetch()` is 466 lines handling 5 distinct concerns in one method.

**Fix:** Extract into focused private methods:

```ts
async fetch(request, env, executionCtx): Promise<Response> {
    /* ~30 lines: URL parse, defaults, trailing slash, basePath */

    const wsResponse = await this._handleWs(request, env, executionCtx, ...)
    if (wsResponse) return wsResponse

    const result = matchRoute(...)

    if (result === null) return this._handle404(...)
    if (!result.matched) return this._handle405(...)

    return this._handleMatched(request, env, executionCtx, result, ...)
}
```

### `_handleWs()`

Extract lines ~488-578: WebSocket route check, upgrade, middleware wrapping, message queue, reconnect token. ~90 lines standalone.

### `_handle404()`

Extract lines ~590-626: telemetry fire, onNotFound callback, chain middleware execution, error fallback. ~30 lines standalone.

### `_handle405()`

Extract lines ~628-683: telemetry fire, onMethodNotAllowed callback, Allow header, chain middleware execution, error fallback. ~40 lines standalone.

### `_handleMatched()`

Extract lines ~685-908: context creation, error factory injection, middleware wrapping, input validation injection, handler execution, output validation, error translation, onError hook, telemetry. ~220 lines standalone.

This is the largest piece. Could further split output validation and error handling into sub-methods, but one level of extraction is enough.

**After refactor:** `fetch()` becomes ~80 lines of orchestration. Each private method is self-contained with clear single responsibility.

**Signature pattern for extracted methods:**

```ts
private async _handleWs(
    request: Request,
    env: TEnv,
    executionCtx: { waitUntil?: (p: Promise<unknown>) => void } | undefined,
    path: string,
    url: URL,
    resolvedDefaults: DefaultsConfig,
    log: Logger | undefined,
    startTime: number,
): Promise<Response | null>
```

Return `null` if not a WS route (caller continues). Return `Response` if handled.

Too many params? Use an internal context object:

```ts
type FetchCtx = {
	env: TEnv
	log: Logger | undefined
	request: Request
	resolvedDefaults: DefaultsConfig
	startTime: number
	url: URL
}
```

Pass `FetchCtx` to all extracted methods. Cleaner signatures.

**Files:** `src/index.ts`
**Risk:** Medium — large mechanical refactor. Run tests after each method extraction, not all at once.

---

## 4. Form Parsing Helper

**Problem:** `validateInput()` in validation.ts has 3 nearly identical form parsing blocks (declared, stream, standard) each with:

- `formData.forEach()` with DANGEROUS_KEYS check
- Record construction
- Optional schema validation

**Current code (3 blocks, ~40 lines each):**

```ts
/* block 1: declared */
const formData = await req.formData()
const formRecord: Record<string, unknown> = {}
formData.forEach((value, key) => {
	if (DANGEROUS_KEYS.has(key)) return
	formRecord[key] = value
})
result.form = formRecord

/* block 2: stream — splits text/file */
const formData = await req.formData()
const textRecord: Record<string, unknown> = {}
const fileRecord: Record<string, unknown> = {}
formData.forEach((value, key) => {
	if (DANGEROUS_KEYS.has(key)) return
	if (typeof value === "string") textRecord[key] = value
	else fileRecord[key] = value
})

/* block 3: standard — validates via schema */
const formData = await req.formData()
const formRecord: Record<string, unknown> = {}
formData.forEach((value, key) => {
	if (DANGEROUS_KEYS.has(key)) return
	formRecord[key] = value
})
result.form = await runSchema(schema, formRecord, "form")
```

**Fix:** Extract shared helper:

```ts
function formDataToRecord(formData: FormData): Record<string, unknown> {
	const record: Record<string, unknown> = {}
	formData.forEach((value, key) => {
		if (DANGEROUS_KEYS.has(key)) return
		record[key] = value
	})
	return record
}

function formDataSplit(formData: FormData): {
	files: Record<string, unknown>
	text: Record<string, unknown>
} {
	const text: Record<string, unknown> = {}
	const files: Record<string, unknown> = {}
	formData.forEach((value, key) => {
		if (DANGEROUS_KEYS.has(key)) return
		if (typeof value === "string") text[key] = value
		else files[key] = value
	})
	return { files, text }
}
```

Then the 3 blocks become:

```ts
/* declared */
result.form = formDataToRecord(await req.formData())

/* stream */
const { text, files } = formDataSplit(await req.formData())
const validated = await runSchema(schema, text, "form")
result.form = { ...(validated as Record<string, unknown>), ...files }

/* standard */
result.form = await runSchema(schema, formDataToRecord(await req.formData()), "form")
```

**Files:** `src/validation.ts`
**Risk:** Low — mechanical extraction, DANGEROUS_KEYS guard centralized (single point of maintenance).

---

## 5. Cookie Serialization Extraction

**Problem:** `response.ts` (338 lines) mixes response building, SSE streaming, generators, AND cookie serialization. `serializeCookie`, `encodeCookieValue`, `validCookieNameRe`, SameSite/prefix validation — all cookie logic lives inside the response file.

**Fix:** Extract to `src/cookie.ts`:

- `encodeCookieValue(value: string): string`
- `serializeCookie(name: string, opts: CookieOptions): string`
- `validCookieNameRe`
- All prefix validation (`__Host-`, `__Secure-`)
- All maxAge/SameSite validation

`response.ts` imports from `cookie.ts` for `applyResponseOptions`. Cookie consumers (cookie-sign, testing, etc.) can import directly.

**Export:** `./cookie` → `src/cookie.ts` in package.json (for consumers who need `serializeCookie` directly).

**Files:** `src/cookie.ts` (new), `src/response.ts` (import from cookie.ts), `package.json` (add export)
**Risk:** Low — move code, update imports, no logic change.

---

## 6. TreeNode/RouteHandler JSDoc

**Problem:** Single-letter field names with no documentation:

```ts
export type TreeNode = {
	d: { c: TreeNode; n: string } | null
	m: Record<HttpMethod | "ALL", RouteHandler> | null
	s: Record<string, TreeNode>
	w: { m: Record<HttpMethod | "ALL", RouteHandler>; n: string } | null
	ws: WSRouteHandler | null
}
```

Anyone reading this for the first time has no idea what `d`, `m`, `s`, `w` mean.

**Fix:** Add inline JSDoc:

```ts
export type TreeNode = {
	/** dynamic param child — name + subtree */
	d: { c: TreeNode; n: string } | null
	/** method handlers — maps HTTP method to route handler */
	m: Record<HttpMethod | "ALL", RouteHandler> | null
	/** static children — maps path segment to subtree */
	s: Record<string, TreeNode>
	/** wildcard handler — name + method map */
	w: { m: Record<HttpMethod | "ALL", RouteHandler>; n: string } | null
	/** websocket handler */
	ws: WSRouteHandler | null
}
```

Same for RouteHandler:

```ts
export type RouteHandler = {
	/** pre-computed error factory subset (null = use global) */
	ef: Record<string, (...args: never[]) => unknown> | null
	/** declared error keys for this route */
	ek: Set<string>
	/** handler function */
	fn: (ctx: unknown) => Response | Promise<Response>
	/** input validation schemas (null = no validation) */
	iv: InputSchemasDef | null
	/** route metadata (frozen object) */
	mt: Record<string, unknown> | null
	/** middleware chain for this route */
	mw: RuntimeMiddleware[]
	/** output schemas by content-type */
	os: OutputSchemaDef | null
	/** output validator function */
	ov: OutputValidator | null
}
```

**Files:** `src/tree.ts`
**Risk:** Zero — JSDoc only, no code change.

---

## 7. Error Message Improvement

**Problem:** Generic error messages that don't help debugging:

| Current                                                            | Better                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `"Duplicate route: ${method} ${path}"`                             | Already includes method + path — OK                                             |
| `"Param name conflict at same position: :${node.d.n} vs :${name}"` | `"Route ${path}: param name conflict — expected :${node.d.n} but got :${name}"` |
| `"merge conflict: duplicate handler"`                              | `"Tree merge conflict: ${method} ${path} has handlers in both trees"`           |
| `"merge conflict: ws handler exists"`                              | `"Tree merge conflict: WebSocket handler for ${path} exists in both trees"`     |
| `"merge conflict: param name"`                                     | `"Tree merge conflict at ${path}: param name :${a.d.n} vs :${b.d.n}"`           |

**Files:** `src/tree.ts`
**Risk:** Zero — string-only changes. Tests that assert exact error messages may need updating.
