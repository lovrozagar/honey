# Honey Audit Fixes

Findings from full framework audit (Mar 14, 2026). Grouped by priority.

## Done

### 1. Output validation status code

**File:** `src/validation.ts:279`
**Was:** `status: "not_implemented"` (501)
**Fixed to:** `status: "internal_server_error"` (500)
**Why:** 501 means "server doesn't support the functionality" — output schema mismatch is a server bug, not missing functionality.

### 2. WS keepalive removed from Bun & Deno

**Files:** `src/ws/bun.ts`, `src/ws/deno.ts`
Removed unused `_opts?: { keepalive?: KeepaliveConfig }` parameter and `KeepaliveConfig` type.
Added JSDoc noting keepalive is Node-only. Block comments on unavoidable `as unknown as` casts.

### 3. Logger for telemetry & i18n errors

**Files:** `src/index.ts`
Added `Logger` type and `logger?: Logger` to `DefaultsConfig`.
`safeFire()` now accepts optional logger — calls `logger.warn()` on failure.
i18n catch block uses `log?.warn?.("i18n resolution failed", e)`.
Zero-cost when no logger configured (current behavior preserved).

### 4. validateOutput statusKey in error vars

**File:** `src/validation.ts`
Renamed `_statusKey` → `statusKey`, included in `HoneyError.vars` for debugging.

### 5. Demo SQL injection fixed

**Files:** `demo/src/services.ts`, `demo/src/app.ts`
Replaced template literal SQL with parameterized queries.
Mock db signature updated to accept optional `_params` array.

### 6. Type emitter Zod-only documented

**File:** `src/type-emitter.ts`
Added JSDoc noting Zod-only support, other vendors return `"unknown"`.

### 7. WS adapter casts documented

**Files:** `ws/bun.ts`, `ws/deno.ts`
Added block comments explaining why `as unknown as` casts are unavoidable.

---

## Remaining (low priority, not implementing now)

### 8. Test encapsulation breaks

**Files:** `tests/unit/core/core.test.ts:667`, `tests/unit/meta/meta.test.ts:147`
Tests access private fields via `(h as unknown as { _tree: TreeNode })._tree`. Consider adding `/** @internal */` test-only accessors or using the existing `_tree` getter pattern.
Low priority — these are test-only and the pattern is isolated.
