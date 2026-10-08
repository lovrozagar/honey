import { describe, expect, it } from "vitest"
import { decodeCookieValue, parseCookieHeader, serializeCookie } from "../../../src/cookie.ts"

function roundTrip(value: string): string | undefined {
	const header = serializeCookie("c", { value }).split(";")[0]
	return parseCookieHeader(header).c
}

describe("cookie value round-trip", () => {
	it("every BMP code point round-trips", () => {
		for (let c = 0; c <= 0xffff; c++) {
			if (c >= 0xd800 && c <= 0xdfff) continue
			const value = `a${String.fromCharCode(c)}b`
			expect(roundTrip(value)).toBe(value)
		}
	})

	it("percent sequences survive (`%41` stays `%41`)", () => {
		expect(roundTrip("%41")).toBe("%41")
		expect(roundTrip("100%")).toBe("100%")
		expect(roundTrip("%zz%41")).toBe("%zz%41")
	})

	it("quoted values and encoded quotes survive", () => {
		expect(roundTrip('"abc"')).toBe('"abc"')
		expect(roundTrip('"')).toBe('"')
	})

	it("astral code points round-trip", () => {
		expect(roundTrip("🍯x")).toBe("🍯x")
	})

	it("lone surrogates are rejected with a clear error", () => {
		expect(() => serializeCookie("c", { value: "a\ud800" })).toThrow(/lone surrogate/)
	})
})

describe("decodeCookieValue", () => {
	it("decodes valid sequences next to a stray %", () => {
		expect(decodeCookieValue("%41%")).toBe("A%")
		expect(decodeCookieValue("50%off%20now")).toBe("50%off now")
	})

	it("keeps invalid UTF-8 runs as sent", () => {
		expect(decodeCookieValue("%C3x%41")).toBe("%C3xA")
	})
})

describe("parseCookieHeader", () => {
	it("first value wins for duplicate names", () => {
		expect(parseCookieHeader("sid=specific; sid=general").sid).toBe("specific")
	})

	it("trims names on both sides and skips empty names", () => {
		const parsed = parseCookieHeader("a =1; =2;  b=3")
		expect(parsed).toEqual({ a: "1", b: "3" })
	})

	it("skips prototype keys", () => {
		const parsed = parseCookieHeader("__proto__=x; constructor=y; ok=1")
		expect(Object.keys(parsed)).toEqual(["ok"])
		expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
	})
})

describe("serializeCookie attribute validation", () => {
	it("prefix checks are case-insensitive", () => {
		expect(() => serializeCookie("__host-sid", { domain: "example.com", secure: true, value: "v" })).toThrow(
			/must not set domain/,
		)
		expect(() => serializeCookie("__SECURE-sid", { value: "v" })).toThrow(/require secure/)
	})

	it("rejects control characters and non-ASCII in path", () => {
		expect(() => serializeCookie("c", { path: "/a\u0000", value: "v" })).toThrow(/path/)
		expect(() => serializeCookie("c", { path: "/a\tb", value: "v" })).toThrow(/path/)
		expect(() => serializeCookie("c", { path: "/é", value: "v" })).toThrow(/path/)
	})

	it("rejects malformed domains", () => {
		expect(() => serializeCookie("c", { domain: "a b.com", value: "v" })).toThrow(/domain/)
		expect(() => serializeCookie("c", { domain: "a.com\u0000", value: "v" })).toThrow(/domain/)
		expect(serializeCookie("c", { domain: ".example.com", value: "v" })).toContain("Domain=.example.com")
	})

	it("huge Max-Age prints as digits", () => {
		const cookie = serializeCookie("c", { maxAge: 1e21, value: "v" })
		expect(cookie).toContain(`Max-Age=${Number.MAX_SAFE_INTEGER}`)
		expect(cookie).not.toContain("e+")
	})
})
