import { describe, expect, it } from "vitest"
import { honey } from "../../src/index.ts"
import {
	issuesToFieldErrors,
	mapNormalizedCode,
	normalizeIssues,
	parseCookies,
} from "../../src/validation.ts"

/* ══════════════════════════════════════════════
 * 1. DECODE — malformed URI fallback in route params
 *
 * tree.ts:75-81 — decodeURIComponent throws on lone
 * surrogates like %C0 (invalid UTF-8 continuation byte).
 * Catch returns raw string.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-13: route param decode fallback", () => {
	it("param with invalid UTF-8 sequence → returns raw encoded string", async () => {
		const app = honey<{}>()
		app.get("/files/:name").handler((ctx) => ctx.res.json("ok", { name: ctx.params.name }))

		/* %C0 is an invalid UTF-8 continuation byte — decodeURIComponent throws */
		const res = await app.fetch(new Request("http://localhost/files/%C0"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		/* should fall back to the raw value */
		expect(data.name).toBe("%C0")
	})

	it("param without encoding → returned as-is (no decode needed)", async () => {
		const app = honey<{}>()
		app.get("/items/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

		const res = await app.fetch(new Request("http://localhost/items/plain-text"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.id).toBe("plain-text")
	})
})

/* ══════════════════════════════════════════════
 * 2. TOPROPERTYKEY — object form { key: PropertyKey }
 *
 * validation.ts:68-73 — some schema vendors (arktype)
 * return path segments as { key: "fieldName" } objects
 * instead of raw strings.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-13: normalizeIssues with object path segments", () => {
	it("path with { key: string } objects → property key extracted", () => {
		const issues = [
			{
				code: "required",
				message: "Field required",
				path: [{ key: "user" }, { key: "email" }],
			},
		]
		const normalized = normalizeIssues(issues, "arktype")
		expect(normalized[0].path).toEqual(["user", "email"])
		expect(normalized[0].meta.field).toBe("email")
	})

	it("mixed string and object path segments", () => {
		const issues = [
			{
				code: "too_small",
				message: "Too short",
				path: ["items", { key: 0 }, { key: "name" }],
			},
		]
		const normalized = normalizeIssues(issues, "zod")
		expect(normalized[0].path).toEqual(["items", 0, "name"])
	})

	it("issue with no path → empty array, field is undefined", () => {
		const issues = [{ code: "unknown", message: "Error" }]
		const normalized = normalizeIssues(issues, "zod")
		expect(normalized[0].path).toEqual([])
		expect(normalized[0].meta.field).toBeUndefined()
	})
})

/* ══════════════════════════════════════════════
 * 3. EXTRACTVENDORCODE — valibot without type field
 *
 * validation.ts:82-84 — valibot uses `type` instead of `code`.
 * When `type` is missing, returns "unknown".
 * ══════════════════════════════════════════════ */

describe("bug-hunt-13: extractVendorCode — vendor variations", () => {
	it("valibot issue with type → uses type as code", () => {
		const issues = [{ message: "too short", path: ["name"], type: "min_length" }]
		const normalized = normalizeIssues(issues, "valibot")
		expect(normalized[0].code).toBe("min_length")
	})

	it("valibot issue without type → code is 'unknown'", () => {
		const issues = [{ message: "invalid", path: ["email"] }]
		const normalized = normalizeIssues(issues, "valibot")
		expect(normalized[0].code).toBe("unknown")
	})

	it("zod issue with code → uses code", () => {
		const issues = [{ code: "too_small", message: "too short", path: ["name"] }]
		const normalized = normalizeIssues(issues, "zod")
		expect(normalized[0].code).toBe("too_small")
	})

	it("zod issue without code → code is 'unknown'", () => {
		const issues = [{ message: "invalid", path: ["x"] }]
		const normalized = normalizeIssues(issues, "zod")
		expect(normalized[0].code).toBe("unknown")
	})

	it("unknown vendor → code is 'unknown'", () => {
		const issues = [{ code: "custom_code", message: "error", path: [] }]
		const normalized = normalizeIssues(issues, "custom-validator")
		expect(normalized[0].code).toBe("unknown")
	})
})

/* ══════════════════════════════════════════════
 * 4. ISSUETTOFIELDERRORS — field grouping edge cases
 * ══════════════════════════════════════════════ */

describe("bug-hunt-13: issuesToFieldErrors edge cases", () => {
	it("multiple errors on same field → grouped together", () => {
		const normalized = [
			{
				code: "too_small",
				message: "Too short",
				meta: { field: "name" },
				path: ["name"] as PropertyKey[],
			},
			{
				code: "invalid_format",
				message: "Bad format",
				meta: { field: "name" },
				path: ["name"] as PropertyKey[],
			},
		]
		const fields = issuesToFieldErrors(normalized, "json")
		expect(fields.name).toHaveLength(2)
		expect(fields.name[0].error_key).toBe("field_too_small")
		expect(fields.name[1].error_key).toBe("field_invalid_format")
	})

	it("issue with no path → field name is 'unknown'", () => {
		const normalized = [
			{ code: "required", message: "Required", meta: {}, path: [] as PropertyKey[] },
		]
		const fields = issuesToFieldErrors(normalized, "json")
		expect(fields.unknown).toHaveLength(1)
		expect(fields.unknown[0].path).toBe("json.")
	})

	it("deep nested path → full path in error", () => {
		const normalized = [
			{
				code: "required",
				message: "Required",
				meta: { field: "zip" },
				path: ["user", "address", "zip"] as PropertyKey[],
			},
		]
		const fields = issuesToFieldErrors(normalized, "json")
		expect(fields.zip[0].path).toBe("json.user.address.zip")
	})
})

/* ══════════════════════════════════════════════
 * 5. MAPNORMALIZEDCODE — all mapped codes
 * ══════════════════════════════════════════════ */

describe("bug-hunt-13: mapNormalizedCode coverage", () => {
	it("all mapped codes produce correct field error keys", () => {
		expect(mapNormalizedCode("required")).toBe("field_required")
		expect(mapNormalizedCode("too_small")).toBe("field_too_small")
		expect(mapNormalizedCode("too_big")).toBe("field_too_big")
		expect(mapNormalizedCode("too_short")).toBe("field_too_short")
		expect(mapNormalizedCode("too_long")).toBe("field_too_long")
		expect(mapNormalizedCode("invalid_format")).toBe("field_invalid_format")
		expect(mapNormalizedCode("invalid_value")).toBe("field_invalid_enum")
		expect(mapNormalizedCode("not_multiple")).toBe("field_not_multiple_of")
		expect(mapNormalizedCode("unrecognized")).toBe("field_unrecognized_keys")
	})
})

/* ══════════════════════════════════════════════
 * 6. HANDLER RETURNING NON-RESPONSE TRUTHY VALUE
 *
 * middleware.ts:88-93 — only checks null/undefined.
 * A truthy non-Response (like true, {}, 42) passes
 * the check and gets returned as-is. This means
 * the caller (index.ts) receives a non-Response.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-13: handler returns non-Response truthy", () => {
	it("handler returning plain object → executeChain passes it through", async () => {
		const app = honey<{}>()
		app.get("/bad").handler((() => ({ not: "a response" })) as never)

		/* executeChain only guards against null/undefined, not type.
		 * A non-Response truthy value passes through. Whether _handleMatched
		 * catches the downstream error (accessing .headers on non-Response)
		 * or returns the object directly depends on the output validation path.
		 * Without output validation, the object is returned as-is.
		 * This documents the current behavior: no runtime type check on Response. */
		const res = await app.fetch(new Request("http://localhost/bad"), {})
		/* the returned object is { not: "a response" }, NOT a real Response */
		expect(res).toHaveProperty("not", "a response")
	})
})

/* ══════════════════════════════════════════════
 * 7. IPRESSTRICT — parseIpv4 edge case octets
 *
 * ip-restrict.ts:31-41 — validates each octet 0-255.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-13: ipRestrict — IPv4 edge cases", () => {
	it("255.255.255.255 → valid, matched by denyList", async () => {
		const { ipRestrict } = await import("../../src/ip-restrict.ts")
		const app = honey<{}>().use(ipRestrict({ denyList: ["255.255.255.255"], trustProxy: true }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: { "x-forwarded-for": "255.255.255.255" },
			}),
			{},
		)
		expect(res.status).toBe(403)
	})

	it("256.0.0.0 → invalid IP, not matched by CIDR", async () => {
		const { ipRestrict } = await import("../../src/ip-restrict.ts")
		const app = honey<{}>().use(ipRestrict({ allowList: ["256.0.0.0/8"], trustProxy: true }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		/* 256.0.0.0/8 is an invalid CIDR — parseIpv4 returns null for 256.
		 * So it's treated as exact string match, not CIDR. */
		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: { "x-forwarded-for": "10.0.0.1" },
			}),
			{},
		)
		/* 10.0.0.1 doesn't match "256.0.0.0/8" as exact string → blocked */
		expect(res.status).toBe(403)
	})

	it("0.0.0.0 exact match → allowed", async () => {
		const { ipRestrict } = await import("../../src/ip-restrict.ts")
		const app = honey<{}>().use(ipRestrict({ allowList: ["0.0.0.0"], trustProxy: true }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: { "x-forwarded-for": "0.0.0.0" },
			}),
			{},
		)
		expect(res.status).toBe(200)
	})

	it("malformed IP like 'abc' → not matched by CIDR, treated as exact", async () => {
		const { ipRestrict } = await import("../../src/ip-restrict.ts")
		const app = honey<{}>().use(ipRestrict({ denyList: ["abc"], trustProxy: true }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		/* abc doesn't match any real IP */
		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: { "x-forwarded-for": "10.0.0.1" },
			}),
			{},
		)
		expect(res.status).toBe(200)
	})

	it("IPv4 with too few octets → invalid, not matched", async () => {
		const { ipRestrict } = await import("../../src/ip-restrict.ts")
		const app = honey<{}>().use(ipRestrict({ allowList: ["10.0.0/24"], trustProxy: true }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		/* 10.0.0 has only 3 octets → parseIpv4 returns null → treated as exact */
		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: { "x-forwarded-for": "10.0.0.1" },
			}),
			{},
		)
		expect(res.status).toBe(403)
	})

	it("CIDR /32 → matches single IP exactly", async () => {
		const { ipRestrict } = await import("../../src/ip-restrict.ts")
		const app = honey<{}>().use(ipRestrict({ allowList: ["10.0.0.5/32"], trustProxy: true }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const r1 = await app.fetch(
			new Request("http://localhost/api", {
				headers: { "x-forwarded-for": "10.0.0.5" },
			}),
			{},
		)
		expect(r1.status).toBe(200)

		const r2 = await app.fetch(
			new Request("http://localhost/api", {
				headers: { "x-forwarded-for": "10.0.0.6" },
			}),
			{},
		)
		expect(r2.status).toBe(403)
	})
})

/* ══════════════════════════════════════════════
 * 8. PARSECOOKIES — whitespace handling
 *
 * validation.ts:58-63 — cookies are split by ";",
 * each pair is trimmed. But what about tabs, multiple
 * spaces, leading/trailing whitespace?
 * ══════════════════════════════════════════════ */

describe("bug-hunt-13: parseCookies — whitespace edge cases", () => {
	it("extra spaces around = and ; → outer trimmed, inner preserved", () => {
		const result = parseCookies("  name = Alice ;  age = 30  ")
		/* pair.trim() trims outer whitespace, then splits on first = */
		/* "name = Alice" → key="name ", value=" Alice" (trailing space from ; split) */
		expect(result["name "]).toBe(" Alice")
		expect(result["age "]).toBe(" 30")
	})

	it("tab-separated pairs still work", () => {
		const result = parseCookies("a=1;\tb=2;\tc=3")
		expect(result.a).toBe("1")
		expect(result.b).toBe("2")
		expect(result.c).toBe("3")
	})
})

/* ══════════════════════════════════════════════
 * 9. COOKIE NAME REGEX — edge cases
 *
 * cookie.ts:35 — validCookieNameRe = /^[\w!#$%&'*.^`|~+-]+$/
 * ══════════════════════════════════════════════ */

describe("bug-hunt-13: cookie name regex validation", () => {
	it("alphanumeric name → valid", () => {
		const { serializeCookie } = require("../../src/cookie.ts")
		expect(() => serializeCookie("session123", { value: "x" })).not.toThrow()
	})

	it("name with hyphens and underscores → valid", () => {
		const { serializeCookie } = require("../../src/cookie.ts")
		expect(() => serializeCookie("my-cookie_name", { value: "x" })).not.toThrow()
	})

	it("name with spaces → invalid", () => {
		const { serializeCookie } = require("../../src/cookie.ts")
		expect(() => serializeCookie("bad name", { value: "x" })).toThrow()
	})

	it("name with = → invalid", () => {
		const { serializeCookie } = require("../../src/cookie.ts")
		expect(() => serializeCookie("bad=name", { value: "x" })).toThrow()
	})

	it("name with ; → invalid", () => {
		const { serializeCookie } = require("../../src/cookie.ts")
		expect(() => serializeCookie("bad;name", { value: "x" })).toThrow()
	})

	it("empty name → invalid", () => {
		const { serializeCookie } = require("../../src/cookie.ts")
		expect(() => serializeCookie("", { value: "x" })).toThrow()
	})
})
