/**
 * The cookie codec: what serializeCookie accepts and writes (names, values, attributes, the
 * __Host- and __Secure- prefixes, SameSite=None), and how a Cookie request header is read into
 * ctx.cookies.
 */
import { describe, expect, it } from "vitest"
import { type CookieOptions, serializeCookie } from "../../src/context/cookie.ts"
import { honey } from "../../src/routing/app.ts"

type Attributes = Omit<CookieOptions, "value">

describe("serializeCookie: names", () => {
	// v0: ece34ba16b
	// v0: 12a8441d56
	// v0: e02e3900ee
	// v0: 451fc6704f
	// v0: 06320b684a
	it.each(["session123", "my-cookie_name", "also-valid.name"])("%j is a valid name", (name) => {
		expect(serializeCookie(name, { value: "x" })).toBe(`${name}=x`)
	})

	// v0: 359ff28b79
	// v0: a229bb2e6e
	// v0: 0aeba08f6e
	// v0: 156640eaba
	// v0: c672e080d0
	// v0: 55497e815c
	// v0: 37735249bb
	// v0: 01cbac5c85
	// v0: 612ba20416
	// v0: 3bef1e472e
	// v0: af8eee528a
	it.each(["bad name", "bad=name", "bad;name", "bad\tname", "bad,name", ""])("%j is refused", (name) => {
		expect(() => serializeCookie(name, { value: "x" })).toThrow("Invalid cookie name")
	})
})

describe("serializeCookie: values", () => {
	// v0: 74c631eef8
	// v0: f5645f854e
	// v0: dded716d7b
	// v0: b1ef864500
	// v0: e91bf4dcee
	// v0: 0e3854798a
	// v0: 3b4d5015e7
	// v0: d9c2c8b2f1
	// v0: 1bf111f8c0
	// v0: 9cb78022d1
	// v0: 7750e4ac8f
	// v0: 75c679a2fe
	it.each([
		["abc123", "abc123"],
		["abc123-_.~", "abc123-_.~"],
		["", ""],
		["hello world", "hello%20world"],
		["a;b;c", "a%3Bb%3Bc"],
		["a,b,c", "a%2Cb%2Cc"],
		["a\tb", "a%09b"],
		['x"y\\z', "x%22y%5Cz"],
		["%41", "%2541"],
		["🍯", "%F0%9F%8D%AF"],
		["日本語", "%E6%97%A5%E6%9C%AC%E8%AA%9E"],
		["happy🎉", "happy%F0%9F%8E%89"],
	])("%j is written as %j: everything outside the cookie octets is percent-encoded", (value, written) => {
		expect(serializeCookie("n", { value })).toBe(`n=${written}`)
	})
})

describe("serializeCookie: attributes", () => {
	// v0: 691690c966
	// v0: cd2f470bf5
	// v0: 8ec07e2fe0
	// v0: 5a721126c3
	// v0: 23b65028a6
	it.each<[Attributes, string]>([
		[{ maxAge: 0 }, "Max-Age=0"],
		[{ maxAge: 3600 }, "Max-Age=3600"],
		[{ expires: new Date("2030-01-01T00:00:00Z") }, "Expires=Tue, 01 Jan 2030 00:00:00 GMT"],
		[{ httpOnly: true }, "HttpOnly"],
		[{ sameSite: "strict" }, "SameSite=Strict"],
		[{ domain: "example.com", path: "/app" }, "Domain=example.com; Path=/app"],
		[{ domain: ".example.com", path: "/api/v1" }, "Domain=.example.com; Path=/api/v1"],
		[
			{ domain: "example.com", httpOnly: true, maxAge: 60, path: "/app", sameSite: "lax", secure: true },
			"Domain=example.com; Path=/app; Max-Age=60; HttpOnly; Secure; SameSite=Lax",
		],
	])("%o is written as %j", (attributes, written) => {
		expect(serializeCookie("s", { ...attributes, value: "x" })).toBe(`s=x; ${written}`)
	})

	// v0: 76bcf6013e
	// v0: 2cbe4d1b56
	// v0: 1b05d3ca4e
	// v0: 3a6be2952e
	// v0: 4fd3f7f538
	// v0: 760a6c9347
	// v0: 84a8323bad
	// v0: b3e8705bfe
	it.each<[Attributes, string]>([
		[{ path: "/; Secure; HttpOnly" }, "Cookie path contains invalid characters"],
		[{ path: "/\r\nX-Injected: yes" }, "Cookie path contains invalid characters"],
		[{ domain: "evil.com; Path=/" }, "Cookie domain contains invalid characters"],
		[{ domain: "evil.com\r\nX-Injected: yes" }, "Cookie domain contains invalid characters"],
		[{ expires: new Date("invalid") }, "Invalid cookie Expires: date is invalid"],
	])("%o, which would inject an attribute or cannot be written, is refused", (attributes, message) => {
		expect(() => serializeCookie("s", { ...attributes, value: "x" })).toThrow(message)
	})

	it.each([Infinity, Number.NaN, -1])("Max-Age %d is refused", (maxAge) => {
		expect(() => serializeCookie("s", { maxAge, value: "x" })).toThrow("Invalid cookie Max-Age")
	})
})

describe("serializeCookie: prefixes and SameSite=None", () => {
	// v0: e3f7aa8a13
	// v0: 079fbe5355
	// v0: 90472b5873
	// v0: ef40476dcb
	// v0: 1ca1590427
	// v0: 1889abf7bd
	// v0: 1fc20c6185
	it.each<[string, Attributes, string]>([
		["__Host-session", { secure: true }, "__Host-session=abc; Path=/; Secure"],
		["__Host-session", { path: "/", secure: true }, "__Host-session=abc; Path=/; Secure"],
		["__Secure-tok", { secure: true }, "__Secure-tok=abc; Secure"],
		["test", { sameSite: "none", secure: true }, "test=abc; Secure; SameSite=None"],
	])("%s with %o is written as %j", (name, attributes, written) => {
		expect(serializeCookie(name, { ...attributes, value: "abc" })).toBe(written)
	})

	// v0: 1a836ba61c
	// v0: 08817ca50f
	// v0: 4e2862707c
	// v0: db00d8ea00
	// v0: ce5bc350cf
	// v0: 72a3784846
	// v0: e559b68f33
	// v0: e64fa6a7d3
	// v0: 7c486e5769
	it.each<[string, Attributes, string]>([
		["__Host-session", {}, "__Host- cookies require secure: true"],
		["__Host-session", { domain: "example.com", secure: true }, "__Host- cookies must not set domain"],
		["__Host-session", { path: "/sub", secure: true }, "__Host- cookies must have path"],
		["__Secure-tok", {}, "__Secure- cookies require secure: true"],
		["test", { sameSite: "none" }, "SameSite=None cookies require secure: true"],
	])("%s with %o is refused", (name, attributes, message) => {
		expect(() => serializeCookie(name, { ...attributes, value: "abc" })).toThrow(message)
	})
})

describe("the Cookie request header", () => {
	// v0: 1eecf079c0
	// v0: 4ba5c0a7d6
	// v0: 6b31db1278
	// v0: 6a1f31a18b
	// v0: 97756099ee
	// v0: 6765925003
	// v0: edabe155f3
	// v0: aa3e6437d5
	// v0: 9f73d9ed54
	// v0: 0fe35fc4f6
	// v0: bb15bc3392
	// v0: 1d3f256c8b
	// v0: 002c05f8ea
	// v0: a21ed4877e
	// v0: 50fd66947b
	// v0: 37b8d1a621
	// v0: 7d2670cf02
	// v0: 32aded0191
	// v0: effd5c43d4
	// v0: 5df78d907c
	// v0: 0fcde92333
	// v0: 26681dec69
	it.each([
		["session=abc; theme=dark; lang=en", { lang: "en", session: "abc", theme: "dark" }],
		["token=abc123; path=/api", { path: "/api", token: "abc123" }],
		["  name = Alice ;  age = 30  ", { age: "30", name: "Alice" }],
		["a=1;\tb=2;\tc=3", { a: "1", b: "2", c: "3" }],
		["token=abc=def=ghi", { token: "abc=def=ghi" }],
		["empty=; other=val", { empty: "", other: "val" }],
		["malformed; valid=yes; also_bad", { valid: "yes" }],
		["", {}],
		['session="abc=def"; token="hello world"', { session: "abc=def", token: "hello world" }],
		["msg=hello%20world%21", { msg: "hello world!" }],
		["b=%ZZbad; c=abc%ZZdef; d=hello%ZZworld; e=abc%", { b: "%ZZbad", c: "abc%ZZdef", d: "hello%ZZworld", e: "abc%" }],
	])("%j is read as %j", async (header, cookies) => {
		const app = honey<{}>()
		app.get("/read").handler((ctx) => ctx.res.json("ok", { ...ctx.cookies }))
		const res = await app.fetch(new Request("http://localhost/read", { headers: { cookie: header } }), {})
		expect([res.status, await res.json()]).toEqual([200, cookies])
	})
})
