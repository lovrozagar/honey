import { describe, expect, it } from "vitest"
import { serializeCookie } from "../../../src/cookie.ts"

describe("serializeCookie — basic", () => {
	it("minimal cookie: name=value", () => {
		const result = serializeCookie("sid", { value: "abc123" })
		expect(result).toBe("sid=abc123")
	})

	it("empty value", () => {
		const result = serializeCookie("cleared", { value: "" })
		expect(result).toBe("cleared=")
	})

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
	it("encodes space", () => {
		const result = serializeCookie("x", { value: "a b" })
		expect(result).toBe("x=a%20b")
	})

	it("encodes semicolon", () => {
		const result = serializeCookie("x", { value: "a;b" })
		expect(result).toContain("%3B")
	})

	it("encodes comma", () => {
		const result = serializeCookie("x", { value: "a,b" })
		expect(result).toContain("%2C")
	})

	it("encodes double quote", () => {
		const result = serializeCookie("x", { value: 'a"b' })
		expect(result).toContain("%22")
	})

	it("encodes backslash", () => {
		const result = serializeCookie("x", { value: "a\\b" })
		expect(result).toContain("%5C")
	})

	it("preserves safe characters (!#$%&'*+-./:)", () => {
		const result = serializeCookie("x", { value: "!#$%&'*+-./:abc" })
		expect(result).toBe("x=!#$%&'*+-./:abc")
	})

	it("encodes unicode", () => {
		const result = serializeCookie("x", { value: "caf\u00e9" })
		expect(result).toContain("caf%C3%A9")
	})

	it("encodes emoji", () => {
		const result = serializeCookie("x", { value: "hi\ud83d\ude00" })
		expect(result).not.toContain("\ud83d\ude00")
	})
})

describe("serializeCookie — cookie name validation", () => {
	it("valid name with letters and digits", () => {
		expect(() => serializeCookie("abc123", { value: "v" })).not.toThrow()
	})

	it("valid name with special chars (!#$%&'*+-.^`|~)", () => {
		expect(() => serializeCookie("my!cookie#1", { value: "v" })).not.toThrow()
	})

	it("rejects empty name", () => {
		expect(() => serializeCookie("", { value: "v" })).toThrow("Invalid cookie name")
	})

	it("rejects name with space", () => {
		expect(() => serializeCookie("my cookie", { value: "v" })).toThrow("Invalid cookie name")
	})

	it("rejects name with semicolon", () => {
		expect(() => serializeCookie("my;cookie", { value: "v" })).toThrow("Invalid cookie name")
	})

	it("rejects name with equals", () => {
		expect(() => serializeCookie("my=cookie", { value: "v" })).toThrow("Invalid cookie name")
	})

	it("rejects name with comma", () => {
		expect(() => serializeCookie("my,cookie", { value: "v" })).toThrow("Invalid cookie name")
	})

	it("rejects name with tab", () => {
		expect(() => serializeCookie("my\tcookie", { value: "v" })).toThrow("Invalid cookie name")
	})
})

describe("serializeCookie — __Host- prefix", () => {
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

	it("__Host- auto-sets path to / when path omitted", () => {
		const result = serializeCookie("__Host-sid", {
			secure: true,
			value: "tok",
		})
		expect(result).toContain("Path=/")
	})

	it("rejects __Host- without secure", () => {
		expect(() => serializeCookie("__Host-sid", { path: "/", value: "tok" })).toThrow(
			"__Host- cookies require secure: true",
		)
	})

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
	it("valid __Secure- cookie", () => {
		const result = serializeCookie("__Secure-sid", {
			secure: true,
			value: "tok",
		})
		expect(result).toContain("__Secure-sid=tok")
		expect(result).toContain("Secure")
	})

	it("__Secure- with domain is allowed", () => {
		const result = serializeCookie("__Secure-sid", {
			domain: "example.com",
			secure: true,
			value: "tok",
		})
		expect(result).toContain("Domain=example.com")
	})

	it("rejects __Secure- without secure", () => {
		expect(() => serializeCookie("__Secure-sid", { value: "tok" })).toThrow("__Secure- cookies require secure: true")
	})
})

describe("serializeCookie — SameSite", () => {
	it("SameSite=Lax", () => {
		const result = serializeCookie("x", { sameSite: "lax", value: "v" })
		expect(result).toContain("SameSite=Lax")
	})

	it("SameSite=Strict", () => {
		const result = serializeCookie("x", { sameSite: "strict", value: "v" })
		expect(result).toContain("SameSite=Strict")
	})

	it("SameSite=None with secure", () => {
		const result = serializeCookie("x", { sameSite: "none", secure: true, value: "v" })
		expect(result).toContain("SameSite=None")
		expect(result).toContain("Secure")
	})

	it("rejects SameSite=None without secure", () => {
		expect(() => serializeCookie("x", { sameSite: "none", value: "v" })).toThrow(
			"SameSite=None cookies require secure: true",
		)
	})

	it("no SameSite when omitted", () => {
		const result = serializeCookie("x", { value: "v" })
		expect(result).not.toContain("SameSite")
	})
})

describe("serializeCookie — domain validation", () => {
	it("valid domain", () => {
		const result = serializeCookie("x", { domain: "example.com", value: "v" })
		expect(result).toContain("Domain=example.com")
	})

	it("subdomain", () => {
		const result = serializeCookie("x", { domain: ".example.com", value: "v" })
		expect(result).toContain("Domain=.example.com")
	})

	it("rejects domain with semicolon", () => {
		expect(() => serializeCookie("x", { domain: "evil.com; Path=/", value: "v" })).toThrow(
			"Cookie domain contains invalid characters",
		)
	})

	it("rejects domain with carriage return", () => {
		expect(() => serializeCookie("x", { domain: "evil.com\r", value: "v" })).toThrow(
			"Cookie domain contains invalid characters",
		)
	})

	it("rejects domain with newline", () => {
		expect(() => serializeCookie("x", { domain: "evil.com\n", value: "v" })).toThrow(
			"Cookie domain contains invalid characters",
		)
	})
})

describe("serializeCookie — path validation", () => {
	it("valid path", () => {
		const result = serializeCookie("x", { path: "/app/dashboard", value: "v" })
		expect(result).toContain("Path=/app/dashboard")
	})

	it("rejects path with semicolon (header injection)", () => {
		expect(() => serializeCookie("x", { path: "/; HttpOnly", value: "v" })).toThrow(
			"Cookie path contains invalid characters",
		)
	})

	it("rejects path with newline (response splitting)", () => {
		expect(() => serializeCookie("x", { path: "/\nSet-Cookie: evil=true", value: "v" })).toThrow(
			"Cookie path contains invalid characters",
		)
	})

	it("rejects path with carriage return", () => {
		expect(() => serializeCookie("x", { path: "/\rSet-Cookie: evil=true", value: "v" })).toThrow(
			"Cookie path contains invalid characters",
		)
	})
})

describe("serializeCookie — Max-Age validation", () => {
	it("valid Max-Age", () => {
		const result = serializeCookie("x", { maxAge: 3600, value: "v" })
		expect(result).toContain("Max-Age=3600")
	})

	it("Max-Age=0 (immediate expiry)", () => {
		const result = serializeCookie("x", { maxAge: 0, value: "v" })
		expect(result).toContain("Max-Age=0")
	})

	it("floors fractional Max-Age", () => {
		const result = serializeCookie("x", { maxAge: 3600.7, value: "v" })
		expect(result).toContain("Max-Age=3600")
	})

	it("rejects negative Max-Age", () => {
		expect(() => serializeCookie("x", { maxAge: -1, value: "v" })).toThrow("Invalid cookie Max-Age")
	})

	it("rejects Infinity Max-Age", () => {
		expect(() => serializeCookie("x", { maxAge: Infinity, value: "v" })).toThrow("Invalid cookie Max-Age")
	})

	it("rejects NaN Max-Age", () => {
		expect(() => serializeCookie("x", { maxAge: NaN, value: "v" })).toThrow("Invalid cookie Max-Age")
	})
})

describe("serializeCookie — Expires validation", () => {
	it("valid Expires date", () => {
		const date = new Date("2030-06-15T12:00:00Z")
		const result = serializeCookie("x", { expires: date, value: "v" })
		expect(result).toContain("Expires=")
		expect(result).toContain("2030")
	})

	it("rejects invalid Date (NaN timestamp)", () => {
		expect(() => serializeCookie("x", { expires: new Date("invalid"), value: "v" })).toThrow(
			"Invalid cookie Expires: date is invalid",
		)
	})
})

describe("serializeCookie — attribute ordering", () => {
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
