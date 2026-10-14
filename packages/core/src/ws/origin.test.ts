import { describe, expect, it } from "vitest"
import { originAllowed, validateOriginPolicy, type WSOriginPolicy } from "./origin.ts"

const SERVER = "https://app.example.com"

const predicate = () => true

describe("originAllowed: same-origin is the full origin (H18.12)", () => {
	it.each([
		["the same scheme, host and port", "https://app.example.com", true],
		["the same origin spelled with uppercase", "https://APP.example.com", true],
		["http against an https server", "http://app.example.com", false],
		["another port", "https://app.example.com:8443", false],
		["a sibling host", "https://evil.example.com", false],
		["a host that merely starts the same", "https://app.example.com.evil.net", false],
	])("%s, with credentials and no allowlist: %s", (_case, origin, allowed) => {
		expect(originAllowed(null, origin, SERVER, true)).toBe(allowed)
	})
})

describe("originAllowed: the default policy", () => {
	it.each([
		["a cross-origin upgrade with credentials", "https://evil.example.com", true, false],
		["a cross-origin upgrade without credentials", "https://evil.example.com", false, true],
		["no Origin at all (not a browser)", null, true, true],
		['the opaque "null" origin with credentials', "null", true, false],
		["an Origin that is no URL, with credentials", "not a url", true, false],
	])("%s: %s", (_case, origin, credentials, allowed) => {
		expect(originAllowed(null, origin, SERVER, credentials)).toBe(allowed)
	})
})

describe("originAllowed: an explicit policy", () => {
	const list = validateOriginPolicy(["https://partner.example.org", "http://localhost:5173"])

	it.each([
		["* allows any origin", "*", "https://evil.example.com", true],
		["a listed origin", list, "https://partner.example.org", true],
		["a listed origin spelled in uppercase", list, "HTTPS://PARTNER.example.org", true],
		["a listed origin on another port", list, "http://localhost:5174", false],
		["a listed host under another scheme", list, "http://partner.example.org", false],
		["the server's own origin, though unlisted", list, SERVER, true],
		['"null", which no list can name', list, "null", false],
		["a predicate saying yes", (origin: string) => origin.endsWith(".example.org"), "https://x.example.org", true],
		["a predicate saying no", (origin: string) => origin.endsWith(".example.org"), "https://x.example.net", false],
		[
			"a predicate answering a truthy non-true",
			(() => "yes") as unknown as WSOriginPolicy,
			"https://x.example.net",
			false,
		],
	])("%s", (_case, policy, origin, allowed) => {
		expect(originAllowed(policy as WSOriginPolicy, origin, SERVER, true)).toBe(allowed)
	})
})

describe("validateOriginPolicy", () => {
	it("keeps * and predicates, and freezes a list as normalized origins", () => {
		const list = validateOriginPolicy(["HTTPS://Partner.Example.org/", "http://localhost:5173"])
		expect([
			validateOriginPolicy("*"),
			validateOriginPolicy(predicate) === predicate,
			list,
			Object.isFrozen(list),
		]).toEqual(["*", true, ["https://partner.example.org", "http://localhost:5173"], true])
	})

	it.each([
		[
			"a host with no scheme",
			["partner.example.org"],
			'allowedOrigins: "partner.example.org" is not an origin like https://example.com',
		],
		[
			"a path",
			["https://partner.example.org/admin"],
			'allowedOrigins: "https://partner.example.org/admin" is not an origin',
		],
		["a query", ["https://partner.example.org/?x=1"], "is not an origin"],
		['the opaque "null"', ["null"], 'allowedOrigins: "null" is not an origin'],
		["a scheme with no origin", ["file:///tmp"], "is not an origin"],
		["a list of non-strings", [42], 'allowedOrigins must be "*", a list of origins, or a function'],
		["a string other than *", "https://x.example", 'allowedOrigins must be "*", a list of origins, or a function'],
	])("refuses %s", (_case, policy, message) => {
		expect(() => validateOriginPolicy(policy)).toThrow(message)
	})
})
