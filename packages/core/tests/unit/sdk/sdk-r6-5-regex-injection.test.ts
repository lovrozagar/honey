/* cleaner must export pathMatchesPattern + lookupStale from sdk.ts in Step 5 */
import { describe, expect, it } from "vitest"
import { lookupStale, pathMatchesPattern } from "../../../src/client/sdk.ts"

const PHASE_F_FIXED = true

/* ═══════════════════════════════════════════════════════════════════
   #R6-5 — Layer A invariants: pathMatchesPattern (always GREEN)
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-5 pathMatchesPattern — Layer A invariants", () => {
	it("concrete path matches pattern with single :param substitution", () => {
		expect(pathMatchesPattern("GET /v1/users/123", "GET /v1/users/:id")).toBe(true)
	})

	it("literal path matches literal pattern (no params)", () => {
		expect(pathMatchesPattern("GET /v1/users", "GET /v1/users")).toBe(true)
	})

	it("path for different resource does not match", () => {
		expect(pathMatchesPattern("GET /v1/users", "GET /v1/posts")).toBe(false)
	})

	it("multi-param path matches multi-param pattern", () => {
		expect(pathMatchesPattern(
			"GET /v1/users/123/comments/456",
			"GET /v1/users/:id/comments/:cid",
		)).toBe(true)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-14 — Layer A invariants: lookupStale (always GREEN)
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-14 lookupStale — Layer A invariants", () => {
	it("empty map returns {by: [], isStale: false}", () => {
		const staleMap = new Map<string, { by: string[]; seq: number; until: number }>()
		const result = lookupStale(staleMap, "GET /x", "/x", "GET", Date.now())
		expect(result.isStale).toBe(false)
		expect(result.by).toEqual([])
	})

	it("matching non-expired entry returns isStale: true with the selector in by", () => {
		const staleMap = new Map<string, { by: string[]; seq: number; until: number }>()
		staleMap.set("GET /v1/users/1", { by: ["PATCH /v1/users/1"], seq: 1, until: Date.now() + 60_000 })
		const result = lookupStale(staleMap, "GET /v1/users/1", "/v1/users/1", "GET", Date.now())
		expect(result.isStale).toBe(true)
		expect(result.by).toContain("PATCH /v1/users/1")
	})

	it("entry with different HTTP method does not match", () => {
		const staleMap = new Map<string, { by: string[]; seq: number; until: number }>()
		staleMap.set("POST /v1/users/1", { by: ["PATCH /v1/users/1"], seq: 1, until: Date.now() + 60_000 })
		const result = lookupStale(staleMap, "GET /v1/users/1", "/v1/users/1", "GET", Date.now())
		expect(result.isStale).toBe(false)
		expect(result.by).toEqual([])
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-5 — Layer B bug witnesses: pathMatchesPattern (pre-fix)
   Documents metacharacter injection in unescaped regex patterns.
   ═══════════════════════════════════════════════════════════════════ */

describe.skipIf(PHASE_F_FIXED)("#R6-5 — Layer B bug witnesses: pathMatchesPattern (pre-fix)", () => {
	it("pre-fix: '.' in pattern acts as regex wildcard — matches any single character", () => {
		/* Pattern segment '.' is unescaped → regex '^GET /v1/.$' matches 'GET /v1/x' */
		expect(pathMatchesPattern("GET /v1/x", "GET /v1/.")).toBe(true)
	})

	it("pre-fix: alternation group '(admin|user)' in pattern is active regex — matches via alternation", () => {
		expect(pathMatchesPattern("GET /v1/admin", "GET /v1/(admin|user)")).toBe(true)
	})

	it("pre-fix: '.' inside segment acts as wildcard — 'a.c' matches 'abc'", () => {
		expect(pathMatchesPattern("GET /v1/abc", "GET /v1/a.c")).toBe(true)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-14 — Layer B bug witnesses: lookupStale (pre-fix)
   Documents missing expired-entry sweep and missing regex cache.
   ═══════════════════════════════════════════════════════════════════ */

describe.skipIf(PHASE_F_FIXED)("#R6-14 — Layer B bug witnesses: lookupStale sweep (pre-fix)", () => {
	it("pre-fix: expired entries are NOT swept — map.size unchanged after lookup", () => {
		const now = Date.now()
		const staleMap = new Map<string, { by: string[]; seq: number; until: number }>()
		for (let i = 0; i < 10; i++) {
			/* all entries already expired */
			staleMap.set(`GET /v1/item/${i}`, { by: [`PATCH /v1/item/${i}`], seq: i, until: now - 1 })
		}
		lookupStale(staleMap, "GET /x", "/x", "GET", now)
		/* Bug: no sweep — all 10 expired entries still present */
		expect(staleMap.size).toBe(10)
	})

	it("pre-fix: pathMatchesPattern has no cache — function source does not reference a pattern cache Map", () => {
		/* Structural witness: the current implementation rebuilds the RegExp on every call.
		   We verify by inspecting the function's string representation — no cache variable. */
		const src = pathMatchesPattern.toString()
		expect(src).not.toContain("Cache")
		expect(src).not.toContain("patternRegex")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-5 — Layer B' regressions: pathMatchesPattern (post-fix)
   ═══════════════════════════════════════════════════════════════════ */

describe.runIf(PHASE_F_FIXED)("#R6-5 — Layer B' regressions: pathMatchesPattern (post-fix)", () => {
	it("post-fix: '.' in pattern is escaped — does NOT match arbitrary single character", () => {
		expect(pathMatchesPattern("GET /v1/x", "GET /v1/.")).toBe(false)
	})

	it("post-fix: '(admin|user)' in pattern is escaped — parentheses are literal, no alternation", () => {
		expect(pathMatchesPattern("GET /v1/admin", "GET /v1/(admin|user)")).toBe(false)
	})

	it("post-fix: 'a.c' in pattern is escaped — does NOT match 'abc' (. is literal)", () => {
		expect(pathMatchesPattern("GET /v1/abc", "GET /v1/a.c")).toBe(false)
	})

	it("post-fix: literal dot in concrete path 'a.c' still matches literal pattern 'a.c'", () => {
		expect(pathMatchesPattern("GET /v1/a.c", "GET /v1/a.c")).toBe(true)
	})

	it("post-fix: param substitution still works after metachar escape — :id matches any segment", () => {
		expect(pathMatchesPattern("GET /v1/users/123", "GET /v1/users/:id")).toBe(true)
	})

	it("post-fix: pathMatchesPattern has a regex cache — function source references a cache Map", () => {
		/* Structural regression: the post-fix implementation holds a module-level Map
		   so the same pattern's RegExp is only compiled once. Verify via source inspection. */
		const src = pathMatchesPattern.toString()
		/* The cache variable is named patternRegexCache per the spec's canonical shape */
		expect(src).toContain("patternRegexCache")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-14 — Layer B' regressions: lookupStale sweep (post-fix)
   ═══════════════════════════════════════════════════════════════════ */

describe.runIf(PHASE_F_FIXED)("#R6-14 — Layer B' regressions: lookupStale sweep (post-fix)", () => {
	it("post-fix: 10 expired entries are swept — map.size === 0 after lookup", () => {
		const now = Date.now()
		const staleMap = new Map<string, { by: string[]; seq: number; until: number }>()
		for (let i = 0; i < 10; i++) {
			staleMap.set(`GET /v1/item/${i}`, { by: [`PATCH /v1/item/${i}`], seq: i, until: now - 1 })
		}
		lookupStale(staleMap, "GET /x", "/x", "GET", now)
		expect(staleMap.size).toBe(0)
	})

	it("post-fix: 5 expired + 5 non-expired — only expired swept, map.size === 5", () => {
		const now = Date.now()
		const staleMap = new Map<string, { by: string[]; seq: number; until: number }>()
		for (let i = 0; i < 5; i++) {
			staleMap.set(`GET /v1/expired/${i}`, { by: [`PATCH /v1/expired/${i}`], seq: i, until: now - 1 })
		}
		for (let i = 0; i < 5; i++) {
			staleMap.set(`GET /v1/fresh/${i}`, { by: [`PATCH /v1/fresh/${i}`], seq: i + 5, until: now + 60_000 })
		}
		lookupStale(staleMap, "GET /x", "/x", "GET", now)
		expect(staleMap.size).toBe(5)
	})

	it("post-fix: non-expired entries are unaffected — their by/until fields remain intact after sweep", () => {
		const now = Date.now()
		const staleMap = new Map<string, { by: string[]; until: number }>()
		staleMap.set("GET /v1/item/expired", { by: ["PATCH /v1/item/expired"], until: now - 1 })
		const freshUntil = now + 60_000
		staleMap.set("GET /v1/item/fresh", { by: ["PATCH /v1/item/fresh"], until: freshUntil })

		lookupStale(staleMap, "GET /x", "/x", "GET", now)

		const freshEntry = staleMap.get("GET /v1/item/fresh")
		expect(freshEntry).toBeDefined()
		expect(freshEntry?.by).toEqual(["PATCH /v1/item/fresh"])
		expect(freshEntry?.until).toBe(freshUntil)
		expect(staleMap.has("GET /v1/item/expired")).toBe(false)
	})
})
