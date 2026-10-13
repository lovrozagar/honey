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

describe("cookie signing — v2 format", () => {
	it("binds the signature to the cookie name", async () => {
		const signed = await sign("admin", secret, { name: "role" })
		expect(await verify(signed, [secret], { name: "role" })).toBe("admin")
		expect(await verify(signed, [secret], { name: "other" })).toBeNull()
		expect(await verify(signed, [secret])).toBeNull()
	})

	it("uses a marker outside the base64url alphabet", async () => {
		const signed = await sign("v", secret)
		expect(signed).toMatch(/^v\.~[A-Za-z0-9_-]{43}$/)
	})

	it("still verifies legacy v1 signatures (dual verification)", async () => {
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(secret),
			{ hash: "SHA-256", name: "HMAC" },
			false,
			["sign"],
		)
		const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("user-1")))
		const b64 = btoa(String.fromCharCode(...mac))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "")
		const legacy = `user-1.${b64}`
		expect(await verify(legacy, [secret], { name: "sid" })).toBe("user-1")
		expect(await verify(legacy, [secret], { legacy: false, name: "sid" })).toBeNull()
	})
})

describe("cookie signing — malformed input", () => {
	it("returns null instead of throwing on malformed signatures", async () => {
		for (const bad of ["v.%%%", "v.~", "v.~!!!", "v.a", "v.====", `v.${"A".repeat(44)}`, "v.~😀"]) {
			expect(await verify(bad, [secret])).toBeNull()
		}
	})

	it("rejects signatures with non-zero trailing bits (no malleability)", async () => {
		const signed = await sign("v", secret)
		const sig = signed.slice(signed.lastIndexOf("~") + 1)
		const last = sig.at(-1) ?? "A"
		/* 43 chars carry 258 bits for 256: flip a trailing bit that decoding would ignore. */
		const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
		const tweaked = alphabet[alphabet.indexOf(last) ^ 1]
		expect(await verify(`v.~${sig.slice(0, -1)}${tweaked}`, [secret])).toBeNull()
	})

	it("an empty secrets list never verifies", async () => {
		expect(await verify(await sign("v", secret), [])).toBeNull()
	})
})
