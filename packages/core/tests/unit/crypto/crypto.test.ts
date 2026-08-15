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
