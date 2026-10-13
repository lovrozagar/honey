import { describe, expect, it } from "vitest"
import { timingSafeEqual } from "../../../src/crypto.ts"

describe("timingSafeEqual — internal", () => {
	it("equal strings → true", async () => {
		expect(await timingSafeEqual("secret123", "secret123")).toBe(true)
	})

	it("different strings → false", async () => {
		expect(await timingSafeEqual("secret123", "secret456")).toBe(false)
	})

	it("different lengths → false", async () => {
		expect(await timingSafeEqual("short", "much-longer-string")).toBe(false)
	})

	it("empty strings → true", async () => {
		expect(await timingSafeEqual("", "")).toBe(true)
	})

	it("unicode strings work", async () => {
		expect(await timingSafeEqual("héllo", "héllo")).toBe(true)
		expect(await timingSafeEqual("héllo", "hello")).toBe(false)
	})

	it("single char difference → false", async () => {
		expect(await timingSafeEqual("abcdef", "abcdeg")).toBe(false)
	})
})

describe("timingSafeEqual — consumer", () => {
	it("API key comparison: valid → true, invalid → false", async () => {
		const storedKey = "sk_live_abc123def456"
		expect(await timingSafeEqual(storedKey, "sk_live_abc123def456")).toBe(true)
		expect(await timingSafeEqual(storedKey, "sk_live_wrong_key")).toBe(false)
	})
})

describe("timingSafeEqual — code units", () => {
	it("different lone surrogates are not equal", async () => {
		expect(await timingSafeEqual("tok\ud800", "tok\udfff")).toBe(false)
		expect(await timingSafeEqual("tok\ud800", "tok�")).toBe(false)
	})

	it("compares bytes", async () => {
		expect(await timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
		expect(await timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
	})

	it("a string never equals bytes", async () => {
		expect(await timingSafeEqual("\u0001\u0002", new Uint8Array([0, 1, 0, 2]))).toBe(false)
	})
})
