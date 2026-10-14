import { describe, expect, it } from "vitest"
import { sign, verify } from "./cookie-sign.ts"

const secret = "test-secret-key-at-least-32-chars-long"
const oldSecret = "old-secret-key-for-rotation-purposes"

describe("cookie signing — internal", () => {
	// v0: 6285b4b10a
	it("sign produces value.signature format", async () => {
		const signed = await sign("user-123", secret)
		expect(signed).toContain(".")
		expect(signed.startsWith("user-123.")).toBe(true)
	})

	// v0: 53df1b9e8b
	it("verify returns original value for valid signature", async () => {
		const signed = await sign("user-123", secret)
		const value = await verify(signed, [secret])
		expect(value).toBe("user-123")
	})

	// v0: 11553fdc11
	it("verify returns null for tampered signature", async () => {
		const signed = await sign("user-123", secret)
		const tampered = `${signed.split(".")[0]}.tampered`
		const value = await verify(tampered, [secret])
		expect(value).toBeNull()
	})

	// v0: 950467f07a
	it("verify with key rotation — old key still works", async () => {
		const signed = await sign("user-123", oldSecret)
		const value = await verify(signed, [secret, oldSecret])
		expect(value).toBe("user-123")
	})

	// v0: 47e9efe991
	it("verify returns null for value without dot", async () => {
		const value = await verify("nodot", [secret])
		expect(value).toBeNull()
	})

	// v0: f8bf858ce9
	it("verify returns null for empty string", async () => {
		const value = await verify("", [secret])
		expect(value).toBeNull()
	})

	// v0: 9c8c533251
	it("different keys produce different signatures", async () => {
		const sig1 = await sign("same-value", secret)
		const sig2 = await sign("same-value", oldSecret)
		expect(sig1).not.toBe(sig2)
	})

	// v0: 11b7293969
	it("value with dots preserved correctly", async () => {
		const signed = await sign("a.b.c", secret)
		const value = await verify(signed, [secret])
		expect(value).toBe("a.b.c")
	})
})

describe("cookie signing — consumer", () => {
	// v0: 8c6d0259f4
	it("signed cookie round-trip", async () => {
		const original = "session-abc-123"
		const signed = await sign(original, secret)
		const verified = await verify(signed, [secret])
		expect(verified).toBe(original)
	})

	// v0: b578a00a66
	it("tampered cookie detected", async () => {
		const signed = await sign("admin", secret)
		const tampered = signed.replace("admin", "superadmin")
		const verified = await verify(tampered, [secret])
		expect(verified).toBeNull()
	})
})

describe("cookie signing — v2 format", () => {
	// v0: c3c6ba6f31
	it("binds the signature to the cookie name", async () => {
		const signed = await sign("admin", secret, { name: "role" })
		expect(await verify(signed, [secret], { name: "role" })).toBe("admin")
		expect(await verify(signed, [secret], { name: "other" })).toBeNull()
		expect(await verify(signed, [secret])).toBeNull()
	})

	// v0: 4389fb1039
	it("uses a marker outside the base64url alphabet", async () => {
		const signed = await sign("v", secret)
		expect(signed).toMatch(/^v\.~[A-Za-z0-9_-]{43}$/)
	})

	// v0: 1cf1e501af
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
	// v0: 05c081e30f
	it("returns null instead of throwing on malformed signatures", async () => {
		for (const bad of ["v.%%%", "v.~", "v.~!!!", "v.a", "v.====", `v.${"A".repeat(44)}`, "v.~😀"]) {
			expect(await verify(bad, [secret])).toBeNull()
		}
	})

	// v0: 5659d0718f
	it("rejects signatures with non-zero trailing bits (no malleability)", async () => {
		const signed = await sign("v", secret)
		const sig = signed.slice(signed.lastIndexOf("~") + 1)
		const last = sig.at(-1) ?? "A"
		/* 43 chars carry 258 bits for 256: flip a trailing bit that decoding would ignore. */
		const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
		const tweaked = alphabet[alphabet.indexOf(last) ^ 1]
		expect(await verify(`v.~${sig.slice(0, -1)}${tweaked}`, [secret])).toBeNull()
	})

	// v0: f1364ad495
	it("an empty secrets list never verifies", async () => {
		expect(await verify(await sign("v", secret), [])).toBeNull()
	})
})

describe("cookie signing — unusable secrets", () => {
	it("a secret WebCrypto cannot import is skipped, not thrown", async () => {
		const signed = await sign("v", "good")
		expect(await verify(signed, ["", "good"])).toBe("v")
		expect(await verify(signed, [""])).toBeNull()
	})
})
