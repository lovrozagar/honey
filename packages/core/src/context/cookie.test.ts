import { describe, expect, it } from "vitest"
import { decodeCookieValue, parseCookieHeader, serializeCookie } from "./cookie.ts"

describe("serializeCookie — basic", () => {
	// v0: e902443859
	it("minimal cookie: name=value", () => {
		expect(serializeCookie("sid", { value: "abc123" })).toBe("sid=abc123")
	})

	// v0: 1d97fc7664
	it("empty value", () => {
		expect(serializeCookie("cleared", { value: "" })).toBe("cleared=")
	})

	// v0: 557d7c0db5
	// v0: ba6960580f
	it("all options set", () => {
		const result = serializeCookie("full", {
			domain: "example.com",
			expires: new Date("2030-01-01T00:00:00Z"),
			httpOnly: true,
			maxAge: 3600,
			path: "/app",
			sameSite: "strict",
			secure: true,
			value: "tok",
		})
		expect(result).toContain("full=tok")
		expect(result).toContain("Domain=example.com")
		expect(result).toContain("Path=/app")
		expect(result).toContain("Max-Age=3600")
		expect(result).toContain("Expires=")
		expect(result).toContain("HttpOnly")
		expect(result).toContain("Secure")
		expect(result).toContain("SameSite=Strict")
	})
})

describe("serializeCookie — value encoding", () => {
	// v0: 886133fff4
	it("encodes space", () => {
		expect(serializeCookie("x", { value: "a b" })).toBe("x=a%20b")
	})

	// v0: f7e5c1e4f0
	it("encodes semicolon", () => {
		expect(serializeCookie("x", { value: "a;b" })).toContain("%3B")
	})

	// v0: e022b88241
	it("encodes comma", () => {
		expect(serializeCookie("x", { value: "a,b" })).toContain("%2C")
	})

	// v0: 54d2124489
	it("encodes double quote", () => {
		expect(serializeCookie("x", { value: 'a"b' })).toContain("%22")
	})

	// v0: 638cd57bba
	it("encodes backslash", () => {
		expect(serializeCookie("x", { value: "a\\b" })).toContain("%5C")
	})

	// v0: 6a09b262a9
	it("preserves safe characters (!#$&'*+-./:) and encodes %", () => {
		expect(serializeCookie("x", { value: "!#$%&'*+-./:abc" })).toBe("x=!#$%25&'*+-./:abc")
	})

	// v0: dc46d99086
	it("encodes unicode", () => {
		expect(serializeCookie("x", { value: "caf\u00e9" })).toContain("caf%C3%A9")
	})

	// v0: d0bd2cddaa
	it("encodes emoji", () => {
		expect(serializeCookie("x", { value: "hi\ud83d\ude00" })).not.toContain("\ud83d\ude00")
	})
})

describe("serializeCookie — cookie name validation", () => {
	// v0: bf0bfc5b53
	it("valid name with letters and digits", () => {
		expect(() => serializeCookie("abc123", { value: "v" })).not.toThrow()
	})

	// v0: 804b7d72c3
	it("valid name with special chars (!#$%&'*+-.^`|~)", () => {
		expect(() => serializeCookie("my!cookie#1", { value: "v" })).not.toThrow()
	})

	// v0: 39aa00f126
	it("rejects empty name", () => {
		expect(() => serializeCookie("", { value: "v" })).toThrow("Invalid cookie name")
	})

	// v0: 7b7ca75f24
	it("rejects name with space", () => {
		expect(() => serializeCookie("my cookie", { value: "v" })).toThrow("Invalid cookie name")
	})

	// v0: d5fea8ef02
	it("rejects name with semicolon", () => {
		expect(() => serializeCookie("my;cookie", { value: "v" })).toThrow("Invalid cookie name")
	})

	// v0: c3d8fdaa21
	it("rejects name with equals", () => {
		expect(() => serializeCookie("my=cookie", { value: "v" })).toThrow("Invalid cookie name")
	})

	// v0: d49080ae0b
	it("rejects name with comma", () => {
		expect(() => serializeCookie("my,cookie", { value: "v" })).toThrow("Invalid cookie name")
	})

	// v0: 624f581552
	it("rejects name with tab", () => {
		expect(() => serializeCookie("my\tcookie", { value: "v" })).toThrow("Invalid cookie name")
	})
})

describe("serializeCookie — __Host- prefix", () => {
	// v0: 8f52afc3a8
	it("valid __Host- cookie", () => {
		const result = serializeCookie("__Host-sid", {
			path: "/",
			secure: true,
			value: "tok",
		})
		expect(result).toContain("__Host-sid=tok")
		expect(result).toContain("Secure")
		expect(result).toContain("Path=/")
	})

	// v0: caf25bbf88
	it("__Host- auto-sets path to / when path omitted", () => {
		const result = serializeCookie("__Host-sid", {
			secure: true,
			value: "tok",
		})
		expect(result).toContain("Path=/")
	})

	// v0: 8aa3ac62d1
	it("rejects __Host- without secure", () => {
		expect(() => serializeCookie("__Host-sid", { path: "/", value: "tok" })).toThrow(
			"__Host- cookies require secure: true",
		)
	})

	// v0: 942513e280
	it("rejects __Host- with domain", () => {
		expect(() =>
			serializeCookie("__Host-sid", {
				domain: "example.com",
				path: "/",
				secure: true,
				value: "tok",
			}),
		).toThrow("__Host- cookies must not set domain")
	})

	// v0: dc50e23a79
	it("rejects __Host- with non-root path", () => {
		expect(() =>
			serializeCookie("__Host-sid", {
				path: "/app",
				secure: true,
				value: "tok",
			}),
		).toThrow("__Host- cookies must have path: '/'")
	})
})

describe("serializeCookie — __Secure- prefix", () => {
	// v0: 3babc27b52
	it("valid __Secure- cookie", () => {
		const result = serializeCookie("__Secure-sid", {
			secure: true,
			value: "tok",
		})
		expect(result).toContain("__Secure-sid=tok")
		expect(result).toContain("Secure")
	})

	// v0: 7aac3d2945
	it("__Secure- with domain is allowed", () => {
		const result = serializeCookie("__Secure-sid", {
			domain: "example.com",
			secure: true,
			value: "tok",
		})
		expect(result).toContain("Domain=example.com")
	})

	// v0: bd3d8d0ea4
	it("rejects __Secure- without secure", () => {
		expect(() => serializeCookie("__Secure-sid", { value: "tok" })).toThrow("__Secure- cookies require secure: true")
	})
})

describe("serializeCookie — SameSite", () => {
	// v0: 5838d43673
	it("SameSite=Lax", () => {
		expect(serializeCookie("x", { sameSite: "lax", value: "v" })).toContain("SameSite=Lax")
	})

	// v0: 895629fe81
	it("SameSite=Strict", () => {
		expect(serializeCookie("x", { sameSite: "strict", value: "v" })).toContain("SameSite=Strict")
	})

	// v0: b78d045c3d
	it("SameSite=None with secure", () => {
		const result = serializeCookie("x", { sameSite: "none", secure: true, value: "v" })
		expect(result).toContain("SameSite=None")
		expect(result).toContain("Secure")
	})

	// v0: 75482fc723
	// v0: 8d71ead0e3
	it("rejects SameSite=None without secure", () => {
		expect(() => serializeCookie("x", { sameSite: "none", value: "v" })).toThrow(
			"SameSite=None cookies require secure: true",
		)
	})

	// v0: 510caec2b5
	it("no SameSite when omitted", () => {
		expect(serializeCookie("x", { value: "v" })).not.toContain("SameSite")
	})
})

describe("serializeCookie — domain validation", () => {
	// v0: 352baac5ee
	it("valid domain", () => {
		expect(serializeCookie("x", { domain: "example.com", value: "v" })).toContain("Domain=example.com")
	})

	// v0: e3857a9e98
	it("subdomain", () => {
		expect(serializeCookie("x", { domain: ".example.com", value: "v" })).toContain("Domain=.example.com")
	})

	// v0: 78a06b665e
	it("rejects domain with semicolon", () => {
		expect(() => serializeCookie("x", { domain: "evil.com; Path=/", value: "v" })).toThrow(
			"Cookie domain contains invalid characters",
		)
	})

	// v0: 734903f6ce
	it("rejects domain with carriage return", () => {
		expect(() => serializeCookie("x", { domain: "evil.com\r", value: "v" })).toThrow(
			"Cookie domain contains invalid characters",
		)
	})

	// v0: 3045ede0a3
	it("rejects domain with newline", () => {
		expect(() => serializeCookie("x", { domain: "evil.com\n", value: "v" })).toThrow(
			"Cookie domain contains invalid characters",
		)
	})
})

describe("serializeCookie — path validation", () => {
	// v0: 5c1645a3d4
	it("valid path", () => {
		expect(serializeCookie("x", { path: "/app/dashboard", value: "v" })).toContain("Path=/app/dashboard")
	})

	// v0: fba32d3a8f
	it("rejects path with semicolon (header injection)", () => {
		expect(() => serializeCookie("x", { path: "/; HttpOnly", value: "v" })).toThrow(
			"Cookie path contains invalid characters",
		)
	})

	// v0: ba4983b4ee
	it("rejects path with newline (response splitting)", () => {
		expect(() => serializeCookie("x", { path: "/\nSet-Cookie: evil=true", value: "v" })).toThrow(
			"Cookie path contains invalid characters",
		)
	})

	// v0: 72d3231d77
	it("rejects path with carriage return", () => {
		expect(() => serializeCookie("x", { path: "/\rSet-Cookie: evil=true", value: "v" })).toThrow(
			"Cookie path contains invalid characters",
		)
	})
})

describe("serializeCookie — Max-Age validation", () => {
	// v0: bd5f4d979b
	it("valid Max-Age", () => {
		expect(serializeCookie("x", { maxAge: 3600, value: "v" })).toContain("Max-Age=3600")
	})

	// v0: c4e741ede4
	it("Max-Age=0 (immediate expiry)", () => {
		expect(serializeCookie("x", { maxAge: 0, value: "v" })).toContain("Max-Age=0")
	})

	// v0: a29fd905ae
	it("floors fractional Max-Age", () => {
		expect(serializeCookie("x", { maxAge: 3600.7, value: "v" })).toContain("Max-Age=3600")
	})

	// v0: 427790fede
	it("rejects negative Max-Age", () => {
		expect(() => serializeCookie("x", { maxAge: -1, value: "v" })).toThrow("Invalid cookie Max-Age")
	})

	// v0: 3bd10a95d7
	it("rejects Infinity Max-Age", () => {
		expect(() => serializeCookie("x", { maxAge: Infinity, value: "v" })).toThrow("Invalid cookie Max-Age")
	})

	// v0: e22db8a107
	it("rejects NaN Max-Age", () => {
		expect(() => serializeCookie("x", { maxAge: NaN, value: "v" })).toThrow("Invalid cookie Max-Age")
	})
})

describe("serializeCookie — Expires validation", () => {
	// v0: b86a4c414d
	it("valid Expires date", () => {
		const date = new Date("2030-06-15T12:00:00Z")
		const result = serializeCookie("x", { expires: date, value: "v" })
		expect(result).toContain("Expires=")
		expect(result).toContain("2030")
	})

	// v0: a0bfc146e0
	it("rejects invalid Date (NaN timestamp)", () => {
		expect(() => serializeCookie("x", { expires: new Date("invalid"), value: "v" })).toThrow(
			"Invalid cookie Expires: date is invalid",
		)
	})
})

describe("serializeCookie — attribute ordering", () => {
	// v0: b684d414a3
	it("attributes appear in correct order: Domain, Path, Max-Age, Expires, HttpOnly, Secure, SameSite", () => {
		const result = serializeCookie("x", {
			domain: "example.com",
			expires: new Date("2030-01-01T00:00:00Z"),
			httpOnly: true,
			maxAge: 3600,
			path: "/",
			sameSite: "lax",
			secure: true,
			value: "v",
		})
		const domainIdx = result.indexOf("Domain=")
		const pathIdx = result.indexOf("Path=")
		const maxAgeIdx = result.indexOf("Max-Age=")
		const expiresIdx = result.indexOf("Expires=")
		const httpOnlyIdx = result.indexOf("HttpOnly")
		const secureIdx = result.indexOf("Secure")
		const sameSiteIdx = result.indexOf("SameSite=")
		expect(domainIdx).toBeLessThan(pathIdx)
		expect(pathIdx).toBeLessThan(maxAgeIdx)
		expect(maxAgeIdx).toBeLessThan(expiresIdx)
		expect(expiresIdx).toBeLessThan(httpOnlyIdx)
		expect(httpOnlyIdx).toBeLessThan(secureIdx)
		expect(secureIdx).toBeLessThan(sameSiteIdx)
	})
})

function roundTrip(value: string): string | undefined {
	const header = serializeCookie("c", { value }).split(";")[0]
	return parseCookieHeader(header).c
}

describe("cookie value round-trip", () => {
	// v0: 3c7a8870e8
	it("every BMP code point round-trips", () => {
		for (let c = 0; c <= 0xffff; c++) {
			if (c >= 0xd800 && c <= 0xdfff) continue
			const value = `a${String.fromCharCode(c)}b`
			expect(roundTrip(value)).toBe(value)
		}
	})

	// v0: bf13036a91
	it("percent sequences survive (`%41` stays `%41`)", () => {
		expect(roundTrip("%41")).toBe("%41")
		expect(roundTrip("100%")).toBe("100%")
		expect(roundTrip("%zz%41")).toBe("%zz%41")
	})

	// v0: ec1fe2c1f7
	it("quoted values and encoded quotes survive", () => {
		expect(roundTrip('"abc"')).toBe('"abc"')
		expect(roundTrip('"')).toBe('"')
	})

	// v0: 5d9d3a49fd
	it("astral code points round-trip", () => {
		expect(roundTrip("🍯x")).toBe("🍯x")
	})

	// v0: 2b62826af9
	it("lone surrogates are rejected with a clear error", () => {
		expect(() => serializeCookie("c", { value: "a\ud800" })).toThrow(/lone surrogate/)
	})
})

describe("decodeCookieValue", () => {
	// v0: 67e14d848d
	it("decodes valid sequences next to a stray %", () => {
		expect(decodeCookieValue("%41%")).toBe("A%")
		expect(decodeCookieValue("50%off%20now")).toBe("50%off now")
	})

	// v0: 882bcd546b
	it("keeps invalid UTF-8 runs as sent", () => {
		expect(decodeCookieValue("%C3x%41")).toBe("%C3xA")
	})
})

describe("parseCookieHeader", () => {
	// v0: d6282e806d
	it("first value wins for duplicate names", () => {
		expect(parseCookieHeader("sid=specific; sid=general").sid).toBe("specific")
	})

	// v0: b97de45abe
	it("trims names on both sides and skips empty names", () => {
		const parsed = parseCookieHeader("a =1; =2;  b=3")
		expect(parsed).toEqual({ a: "1", b: "3" })
	})

	// v0: 587b90b244
	// v0: 08983c32f3
	it("keeps prototype names as plain keys on a record with no prototype", () => {
		const parsed = parseCookieHeader("__proto__=x; constructor=y; prototype=z; ok=1")
		expect(Object.getPrototypeOf(parsed)).toBeNull()
		expect(Object.entries(parsed)).toEqual([
			["__proto__", "x"],
			["constructor", "y"],
			["prototype", "z"],
			["ok", "1"],
		])
		expect(parsed.toString).toBeUndefined()
		expect(({} as Record<string, unknown>).x).toBeUndefined()
	})

	it("strips one pair of surrounding quotes before decoding", () => {
		expect(parseCookieHeader('a="x%22y"; b="; c=""').a).toBe('x"y')
		expect(parseCookieHeader('b="; c=""')).toEqual({ b: '"', c: "" })
	})

	// v0: ff36609e4f
	it("keeps a raw unicode value as sent", () => {
		expect({ ...parseCookieHeader("name=日本語; emoji=🍯") }).toEqual({ emoji: "🍯", name: "日本語" })
	})

	it("skips a pair without = and an empty header", () => {
		expect(parseCookieHeader("flag; a=1")).toEqual({ a: "1" })
		expect(parseCookieHeader("")).toEqual({})
	})
})

describe("serializeCookie attribute validation", () => {
	// v0: 5275fa65f6
	it("prefix checks are case-insensitive", () => {
		expect(() => serializeCookie("__host-sid", { domain: "example.com", secure: true, value: "v" })).toThrow(
			/must not set domain/,
		)
		expect(() => serializeCookie("__SECURE-sid", { value: "v" })).toThrow(/require secure/)
	})

	// v0: 3302f9aedb
	it("rejects control characters and non-ASCII in path", () => {
		expect(() => serializeCookie("c", { path: "/a\u0000", value: "v" })).toThrow(/path/)
		expect(() => serializeCookie("c", { path: "/a\tb", value: "v" })).toThrow(/path/)
		expect(() => serializeCookie("c", { path: "/é", value: "v" })).toThrow(/path/)
	})

	// v0: 63cc52e2d2
	it("rejects malformed domains", () => {
		expect(() => serializeCookie("c", { domain: "a b.com", value: "v" })).toThrow(/domain/)
		expect(() => serializeCookie("c", { domain: "a.com\u0000", value: "v" })).toThrow(/domain/)
		expect(serializeCookie("c", { domain: ".example.com", value: "v" })).toContain("Domain=.example.com")
	})

	// v0: 3358ead87a
	it("huge Max-Age prints as digits", () => {
		const cookie = serializeCookie("c", { maxAge: 1e21, value: "v" })
		expect(cookie).toContain(`Max-Age=${Number.MAX_SAFE_INTEGER}`)
		expect(cookie).not.toContain("e+")
	})
})
