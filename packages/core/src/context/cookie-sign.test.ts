import { describe, expect, it, vi } from "vitest"
import { createCookieSigner, sign, verify } from "./cookie-sign.ts"
import { honey } from "../routing/app.ts"

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
	// v0: 5688e4cb61
	it("returns null instead of throwing on malformed signatures", async () => {
		const malformed = ["v.%%%", "v.~", "v.~!!!", "v.a", "v.====", `v.${"A".repeat(44)}`, "v.~😀"]
		for (const bad of [...malformed, "value.!!!not-base64!!!", "value.~@@@"]) {
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

describe("createCookieSigner: keys imported once per signer", () => {
	it("imports each secret once, however many values it signs and verifies", async () => {
		const importKey = vi.spyOn(crypto.subtle, "importKey")
		try {
			const signer = createCookieSigner(["new", "old"])
			const signed = await signer.sign("v", { name: "sid" })
			for (let i = 0; i < 5; i++) expect(await signer.verify(signed, { name: "sid" })).toBe("v")
			expect(await signer.verify(await sign("w", "old"))).toBe("w")
			/* "new" and "old" once each for the signer; "old" once more for the standalone sign */
			expect(importKey).toHaveBeenCalledTimes(3)
		} finally {
			importKey.mockRestore()
		}
	})

	it("signs with the first secret, verifies with any, and matches the standalone functions", async () => {
		const signer = createCookieSigner(["new", "old"])
		const signed = await signer.sign("v", { name: "sid" })
		expect(signed).toBe(await sign("v", "new", { name: "sid" }))
		expect(await verify(signed, ["new"], { name: "sid" })).toBe("v")
		expect(await signer.verify(signed, { name: "other" })).toBeNull()
		expect(await signer.verify("v.tampered")).toBeNull()
	})

	it("an unusable secret is skipped for verify; signing with one rejects", async () => {
		const good = await sign("v", "good")
		expect(await createCookieSigner(["", "good"]).verify(good)).toBe("v")
		await expect(createCookieSigner(["", "good"]).sign("v")).rejects.toThrow()
		await expect(createCookieSigner([]).sign("v")).rejects.toThrow("no secret to sign with")
		expect(await createCookieSigner([]).verify(good)).toBeNull()
	})
})

describe("cookie-sign round-trip", () => {
	// v0: b4a3951fbb
	it("sign then verify with same secret → original value", async () => {
		const signed = await sign("session-token-abc", "my-secret")
		expect(signed).toContain(".")
		const value = await verify(signed, ["my-secret"])
		expect(value).toBe("session-token-abc")
	})

	// v0: 493d4fc6ca
	it("verify with wrong secret → null", async () => {
		const signed = await sign("data", "secret-1")
		const value = await verify(signed, ["wrong-secret"])
		expect(value).toBeNull()
	})

	// v0: e37be0529d
	it("key rotation — old secret still works", async () => {
		const signed = await sign("data", "old-secret")
		/* verify with new secret first, old second */
		const value = await verify(signed, ["new-secret", "old-secret"])
		expect(value).toBe("data")
	})

	// v0: d47f605f3c
	it("empty string → null", async () => {
		const value = await verify("", ["secret"])
		expect(value).toBeNull()
	})

	// v0: b12e12e98b
	it("no dot in signed string → null", async () => {
		const value = await verify("nodot", ["secret"])
		expect(value).toBeNull()
	})

	// v0: bd42fbf2aa
	it("tampered value → null", async () => {
		const signed = await sign("original", "secret")
		const tampered = `tampered${signed.slice(signed.indexOf("."))}`
		const value = await verify(tampered, ["secret"])
		expect(value).toBeNull()
	})
})

describe("cookie-sign with dots in value", () => {
	// v0: 77e0bbfa3b
	it("value with dots → sign/verify round-trip works", async () => {
		const signed = await sign("user.id.12345", "secret")
		/* should have at least 3 dots: 2 in value + 1 before sig */
		expect(signed.split(".").length).toBeGreaterThanOrEqual(4)
		const value = await verify(signed, ["secret"])
		expect(value).toBe("user.id.12345")
	})

	// v0: e2fb35567b
	it("value that is just a dot → works", async () => {
		const signed = await sign(".", "secret")
		const value = await verify(signed, ["secret"])
		expect(value).toBe(".")
	})
})

/* ══════════════════════════════════════════════
 * 3. COOKIE ENCODING — full range of special characters
 *
 * After fixing the emoji bug, verify CJK and other multi-byte.
 * ══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
 * 4. SSE — carriage returns in data
 *
 * response.ts:150-153 — splits on \r\n|\r|\n.
 * Each variant should produce separate data: lines.
 * ══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
 * 5. SSE — id with carriage return → throws
 * ══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
 * 6. ACCEPTS — equal q-values → server preference wins
 *
 * accepts.ts:66-75 — iterates supported types in server order,
 * picks the one with highest q. With equal q, first supported wins.
 * ══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
 * 7. NODE ADAPTER — array headers (e.g. multiple set-cookie)
 *
 * node.ts:18-25 — array headers use append().
 * ══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
 * 8. TESTCLIENT — HEAD and custom methods
 * ══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
 * 9. MIDDLEWARE CHAIN — route-level .use() stacks correctly
 * ══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
 * 10. ETAG — conditional request with mismatched ETag
 * ══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
 * 11. ETAG — skips non-GET/HEAD methods
 * ══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
 * 12. CORS — exposeHeaders on actual request
 * ══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
 * 13. CORS — preflight with explicit allowed methods
 * ══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
 * 14. CORS — maxAge on preflight
 * ══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
 * 15. BODYLIMIT — POST with no body (null body)
 * ══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
 * 16. DUPLICATE ROUTE REGISTRATION → throws
 * ══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
 * 17. WILDCARD NAME CONFLICT ON INSERT
 * ══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
 * 18. PARAM NAME CONFLICT ON INSERT
 * ══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
 * 19. NODE ADAPTER — response with streaming body + backpressure
 * ══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
 * 20. RESPONSE OPTIONS — custom status on noContent
 * ══════════════════════════════════════════════ */

describe("cookie-sign edge cases", () => {
	const edgeSecret = "test-edgeSecret-key-at-least-32-chars-long"

	// v0: 372b86486d
	it("signs and verifies unicode value", async () => {
		const signed = await sign("caf\u00e9-\u{1F525}", edgeSecret)
		const value = await verify(signed, [edgeSecret])
		expect(value).toBe("caf\u00e9-\u{1F525}")
	})

	// v0: afad30cb63
	it("signs and verifies emoji value", async () => {
		const signed = await sign("\u{1F680}\u{1F30D}", edgeSecret)
		const value = await verify(signed, [edgeSecret])
		expect(value).toBe("\u{1F680}\u{1F30D}")
	})

	// v0: e8dd21bc1c
	it("verify with empty secrets array → null", async () => {
		const signed = await sign("val", edgeSecret)
		const value = await verify(signed, [])
		expect(value).toBeNull()
	})

	// v0: f847249873
	it("signs and verifies empty string value", async () => {
		const signed = await sign("", edgeSecret)
		expect(signed.startsWith(".")).toBe(true)
		const value = await verify(signed, [edgeSecret])
		expect(value).toBe("")
	})

	// v0: b593b5c7cb
	it("signs and verifies very long value", async () => {
		const longVal = "x".repeat(10000)
		const signed = await sign(longVal, edgeSecret)
		const value = await verify(signed, [edgeSecret])
		expect(value).toBe(longVal)
	})
})

/* ═══════════════════════════════════════════
 * mergeTree conflicts
 * ═══════════════════════════════════════════ */

/* ═══════════════════════════════════════════
 * Body ignored for GET/DELETE/HEAD/OPTIONS
 * ═══════════════════════════════════════════ */

/* ═══════════════════════════════════════════
 * Middleware ordering: global → chain → route
 * ═══════════════════════════════════════════ */

/* ═══════════════════════════════════════════
 * CORS preflight
 * ═══════════════════════════════════════════ */

/* ═══════════════════════════════════════════
 * Wrong Content-Type → 415/422
 * ═══════════════════════════════════════════ */

describe("signed cookie HTTP round trip", () => {
	// v0: da277b4ba2
	it("Set-Cookie then Cookie header verifies", async () => {
		const proveSecret = "prove-proveSecret-key"
		const app = honey()
			.post("/login")
			.handler(async (ctx) => {
				const token = await sign("user-42", proveSecret)
				return ctx.res.text("ok", "in", {
					cookies: { sid: { httpOnly: true, path: "/", value: token } },
				})
			})
			.get("/me")
			.handler(async (ctx) => {
				const raw = ctx.cookies.sid
				const user = raw ? await verify(raw, [proveSecret]) : null
				if (!user) return ctx.res.text("unauthorized", "no", { status: 401 })
				return ctx.res.text("ok", user)
			})

		const login = await app.fetch(new Request("http://x/login", { method: "POST" }), {})
		expect(login.status).toBe(200)
		const setCookie = login.headers.get("set-cookie")
		expect(setCookie).toMatch(/^sid=user-42\./)
		const sid = setCookie?.split(";")[0]?.slice("sid=".length)
		expect(sid).toBeTruthy()

		const me = await app.fetch(new Request("http://x/me", { headers: { cookie: `sid=${sid}` } }), {})
		expect(me.status).toBe(200)
		expect(await me.text()).toBe("user-42")

		const bad = await app.fetch(new Request("http://x/me", { headers: { cookie: "sid=user-42.forged" } }), {})
		expect(bad.status).toBe(401)
	})
})
