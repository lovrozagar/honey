import { describe, expect, it, vi } from "vitest"
import { timingSafeEqual } from "./crypto.ts"

const LONG = "x".repeat(10_000)

describe("timingSafeEqual(): equal inputs", () => {
	// v0: 6e37ccbd80
	// v0: 7418ceb793
	// v0: 9378529aee
	// v0: 8eb192eeb4
	// v0: ced719d5fc
	// v0: 50c6946384
	// v0: 127f69daab
	// v0: 122985f3fb
	// v0: 0745b6dcb9
	// v0: c53801dd07
	// v0: 7bdf357f7d
	it.each([
		["secret123", "secret123"],
		["", ""],
		[LONG, LONG],
		["p@$$w0rd!#%", "p@$$w0rd!#%"],
		["   ", "   "],
		["a\nb\tc", "a\nb\tc"],
		["a\0b", "a\0b"],
		["héllo", "héllo"],
		["sk_live_abc123def456", "sk_live_abc123def456"],
	])("%j and %j are equal", async (a, b) => {
		expect(await timingSafeEqual(a, b)).toBe(true)
	})

	// v0: 78ae9e7b6f
	it("equal bytes are equal", async () => {
		expect(await timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
	})
})

describe("timingSafeEqual(): unequal inputs", () => {
	// v0: 2b23747948
	// v0: f162bcef3f
	// v0: 4a993bf47e
	// v0: 414eea7e5f
	// v0: f92efc1cb6
	// v0: 2163c3a7a2
	it.each([
		["secret123", "secret456"],
		["short", "much-longer-string"],
		["abcdef", "abcdeg"],
		[`${"x".repeat(9999)}a`, `${"x".repeat(9999)}b`],
		["p@$$w0rd!#%", "p@$$w0rd!#&"],
		["   ", "  "],
		["a\nb", "a\nc"],
		["a\0b", "a\0c"],
		["héllo", "hello"],
		["sk_live_abc123def456", "sk_live_wrong_key"],
		["", "x"],
	])("%j and %j differ", async (a, b) => {
		expect(await timingSafeEqual(a, b)).toBe(false)
	})

	it("unequal bytes, and bytes of another length, differ", async () => {
		expect([
			await timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])),
			await timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0])),
		]).toEqual([false, false])
	})
})

describe("timingSafeEqual(): strings compare by code unit", () => {
	// v0: 0155d3c6a6
	it("two different lone surrogates are not equal, nor is one and the U+FFFD UTF-8 would make of it", async () => {
		expect([await timingSafeEqual("tok\ud800", "tok\udfff"), await timingSafeEqual("tok\ud800", "tok�")]).toEqual([
			false,
			false,
		])
	})

	// v0: 42cbce9ce6
	it("a string never equals bytes, even bytes spelling its code units", async () => {
		expect([
			await timingSafeEqual("\u0001\u0002", new Uint8Array([0, 1, 0, 2])),
			await timingSafeEqual(new Uint8Array([0, 1, 0, 2]), "\u0001\u0002"),
		]).toEqual([false, false])
	})
})

describe("timingSafeEqual(): no key outlives a call", () => {
	it("each comparison MACs under a key of its own, drawn fresh", async () => {
		const draw = vi.spyOn(crypto, "getRandomValues")
		await timingSafeEqual("a", "a")
		await timingSafeEqual("a", "a")
		const keys = draw.mock.calls.map(([bytes]) => Array.from(bytes as Uint8Array).join(","))
		draw.mockRestore()
		expect([keys.length, new Set(keys).size]).toEqual([2, 2])
	})
})
