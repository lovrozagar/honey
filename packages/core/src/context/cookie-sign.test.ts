import { describe, expect, it, vi } from "vitest"
import { createCookieSigner } from "./cookie-sign.ts"
import { honey } from "../routing/app.ts"

const secret = "test-secret-key-at-least-32-chars-long"
const oldSecret = "old-secret-key-for-rotation-purposes"

/** A signer for the `sid` cookie, unless another name is given. */
const signer = (secrets: readonly [string, ...string[]] = [secret], name = "sid") =>
	createCookieSigner({ name, secrets })

/** A v1 signature: the HMAC of the value alone, bound to no cookie name. */
async function v1Signed(value: string, key: string): Promise<string> {
	const imported = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(key),
		{ hash: "SHA-256", name: "HMAC" },
		false,
		["sign"],
	)
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(value)))
	const b64 = btoa(String.fromCharCode(...mac))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "")
	return `${value}.${b64}`
}

describe("createCookieSigner: sign and verify", () => {
	// v0: 6285b4b10a
	// v0: 4389fb1039
	it("signs as the value, a dot, `~` and a 43-character base64url tag", async () => {
		expect(await signer().sign("user-123")).toMatch(/^user-123\.~[A-Za-z0-9_-]{43}$/)
	})

	// v0: 53df1b9e8b
	// v0: 8c6d0259f4
	// v0: b4a3951fbb
	it("verify answers the original value for its own signature", async () => {
		const s = signer()
		expect(await s.verify(await s.sign("session-abc-123"))).toBe("session-abc-123")
	})

	// v0: 950467f07a
	// v0: e37be0529d
	it("the first secret signs and any verifies, so secrets rotate", async () => {
		const signed = await signer([oldSecret]).sign("user-123")
		expect(await signer([secret, oldSecret]).verify(signed)).toBe("user-123")
		expect(await signer([secret, oldSecret]).sign("v")).toBe(await signer([secret]).sign("v"))
	})

	// v0: 9c8c533251
	// v0: 493d4fc6ca
	it("another secret signs differently and never verifies", async () => {
		const signed = await signer([secret]).sign("same-value")
		expect([
			signed === (await signer([oldSecret]).sign("same-value")),
			await signer([oldSecret]).verify(signed),
		]).toEqual([false, null])
	})

	// v0: 11b7293969
	// v0: 77e0bbfa3b
	// v0: e2fb35567b
	// v0: 372b86486d
	// v0: afad30cb63
	// v0: f847249873
	// v0: b593b5c7cb
	it.each([
		["dots", "a.b.c"],
		["dots", "user.id.12345"],
		["a lone dot", "."],
		["unicode", "café-\u{1F525}"],
		["emoji", "\u{1F680}\u{1F30D}"],
		["the empty string", ""],
		["10,000 characters", "x".repeat(10_000)],
	])("round-trips a value of %s whole", async (_label, value) => {
		const s = signer()
		expect(await s.verify(await s.sign(value))).toBe(value)
	})
})

describe("createCookieSigner: the cookie name is bound into every signature", () => {
	// v0: c3c6ba6f31
	it("a value signed for one cookie never verifies as another sharing the secret", async () => {
		const signed = await signer([secret], "role").sign("admin")
		expect([await signer([secret], "role").verify(signed), await signer([secret], "sid").verify(signed)]).toEqual([
			"admin",
			null,
		])
	})

	it("a v1 signature, bound to no name, never verifies", async () => {
		expect(await signer().verify(await v1Signed("user-1", secret))).toBeNull()
	})
})

describe("createCookieSigner: what never verifies", () => {
	// v0: 11553fdc11
	// v0: b578a00a66
	// v0: bd42fbf2aa
	it("a tampered value or signature", async () => {
		const signed = await signer().sign("admin")
		const tampered = [signed.replace("admin", "superadmin"), `${signed.split(".")[0]}.tampered`]
		expect(await Promise.all(tampered.map((t) => signer().verify(t)))).toEqual([null, null])
	})

	// v0: 47e9efe991
	// v0: f8bf858ce9
	// v0: d47f605f3c
	// v0: b12e12e98b
	// v0: 05c081e30f
	// v0: 5688e4cb61
	it("malformed input answers null instead of throwing", async () => {
		const malformed = ["", "nodot", "v.%%%", "v.~", "v.~!!!", "v.a", "v.====", `v.${"A".repeat(44)}`, "v.~😀"]
		for (const bad of [...malformed, "value.!!!not-base64!!!", "value.~@@@"]) {
			expect(await signer().verify(bad)).toBeNull()
		}
	})

	// v0: 5659d0718f
	it("a signature with non-zero trailing bits (no malleability)", async () => {
		const signed = await signer().sign("v")
		const sig = signed.slice(signed.lastIndexOf("~") + 1)
		const last = sig.at(-1) ?? "A"
		/* 43 chars carry 258 bits for 256: flip a trailing bit that decoding would ignore */
		const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
		const tweaked = alphabet[alphabet.indexOf(last) ^ 1]
		expect(await signer().verify(`v.~${sig.slice(0, -1)}${tweaked}`)).toBeNull()
	})

	it("a secret WebCrypto cannot import is skipped for verify; signing with one rejects", async () => {
		const good = await signer(["good"]).sign("v")
		expect([await signer(["", "good"]).verify(good), await signer([""]).verify(good)]).toEqual(["v", null])
		await expect(signer(["", "good"]).sign("v")).rejects.toThrow()
	})
})

describe("createCookieSigner: its options", () => {
	// v0: f1364ad495
	// v0: e8dd21bc1c
	it("refuses an empty secret list or an empty name when built, so it never answers for one", () => {
		expect(() => createCookieSigner({ name: "sid", secrets: [] as unknown as [string] })).toThrow(
			new TypeError("createCookieSigner: secrets needs at least one secret"),
		)
		expect(() => createCookieSigner({ name: "", secrets: [secret] })).toThrow(
			new TypeError("createCookieSigner: name must be the cookie's name"),
		)
	})

	it("types name and at least one secret as required", () => {
		// @ts-expect-error name is required
		expect(() => createCookieSigner({ secrets: [secret] })).toThrow(TypeError)
		// @ts-expect-error at least one secret
		expect(() => createCookieSigner({ name: "sid", secrets: [] })).toThrow(TypeError)
	})

	it("imports each secret once, however many values it signs and verifies", async () => {
		const importKey = vi.spyOn(crypto.subtle, "importKey")
		try {
			const s = signer([secret, oldSecret])
			const signed = await s.sign("v")
			for (let i = 0; i < 5; i++) expect(await s.verify(signed)).toBe("v")
			expect(await s.verify(await signer([oldSecret]).sign("w"))).toBe("w")
			/* the two secrets once each for `s`; oldSecret once more for the other signer */
			expect(importKey).toHaveBeenCalledTimes(3)
		} finally {
			importKey.mockRestore()
		}
	})
})

describe("signed cookie HTTP round trip", () => {
	// v0: da277b4ba2
	it("Set-Cookie then Cookie header verifies", async () => {
		const sid = signer(["prove-proveSecret-key"])
		const app = honey()
			.post("/login")
			.handler(async (ctx) => {
				const token = await sid.sign("user-42")
				return ctx.res.text("ok", "in", { cookies: { sid: { httpOnly: true, path: "/", value: token } } })
			})
			.get("/me")
			.handler(async (ctx) => {
				const raw = ctx.cookies.sid
				const user = raw ? await sid.verify(raw) : null
				return user === null ? ctx.res.text("unauthorized", "no") : ctx.res.text("ok", user)
			})
		const login = await app.fetch(new Request("http://x/login", { method: "POST" }), {})
		const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? ""
		const me = await app.fetch(new Request("http://x/me", { headers: { cookie } }), {})
		const bad = await app.fetch(new Request("http://x/me", { headers: { cookie: "sid=user-42.forged" } }), {})
		expect([login.status, cookie.startsWith("sid=user-42.~"), me.status, await me.text(), bad.status]).toEqual([
			200,
			true,
			200,
			"user-42",
			401,
		])
	})
})
