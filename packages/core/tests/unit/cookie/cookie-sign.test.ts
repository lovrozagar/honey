import { describe, expect, it } from "vitest"
import { sign, verify } from "../../../src/cookie-sign.ts"

const secret = "test-secret-key-at-least-32-chars-long"
const oldSecret = "old-secret-key-for-rotation-purposes"

describe("cookie signing — internal", () => {
	it("sign produces value.signature format", async () => {
		const signed = await sign("user-123", secret)
		expect(signed).toContain(".")
		expect(signed.startsWith("user-123.")).toBe(true)
	})

	it("verify returns original value for valid signature", async () => {
		const signed = await sign("user-123", secret)
		const value = await verify(signed, [secret])
		expect(value).toBe("user-123")
	})

	it("verify returns null for tampered signature", async () => {
		const signed = await sign("user-123", secret)
		const tampered = `${signed.split(".")[0]}.tampered`
		const value = await verify(tampered, [secret])
		expect(value).toBeNull()
	})

	it("verify with key rotation — old key still works", async () => {
		const signed = await sign("user-123", oldSecret)
		const value = await verify(signed, [secret, oldSecret])
		expect(value).toBe("user-123")
	})

	it("verify returns null for value without dot", async () => {
		const value = await verify("nodot", [secret])
		expect(value).toBeNull()
	})

	it("verify returns null for empty string", async () => {
		const value = await verify("", [secret])
		expect(value).toBeNull()
	})

	it("different keys produce different signatures", async () => {
		const sig1 = await sign("same-value", secret)
		const sig2 = await sign("same-value", oldSecret)
		expect(sig1).not.toBe(sig2)
	})

	it("value with dots preserved correctly", async () => {
		const signed = await sign("a.b.c", secret)
		const value = await verify(signed, [secret])
		expect(value).toBe("a.b.c")
	})
})

describe("cookie signing — consumer", () => {
	it("signed cookie round-trip", async () => {
		const original = "session-abc-123"
		const signed = await sign(original, secret)
		const verified = await verify(signed, [secret])
		expect(verified).toBe(original)
	})

	it("tampered cookie detected", async () => {
		const signed = await sign("admin", secret)
		const tampered = signed.replace("admin", "superadmin")
		const verified = await verify(tampered, [secret])
		expect(verified).toBeNull()
	})
})
