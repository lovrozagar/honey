/**
 * The adversarial suite's token cases: a public key signed with as an HMAC secret, and a token with no
 * expiry. Each is a failing input first and the it second; the mutation harness reruns this directory
 * with each guard disabled.
 */
import { resolve as resolvePath } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { guardNamed } from "../../structure/mutation-harness.ts"

const REPO = resolvePath(import.meta.dirname, "../../../../..")

const mutant = guardNamed(process.env.HONEY_MUTANT)
if (mutant !== undefined) {
	vi.doMock(resolvePath(REPO, mutant.module), async (importOriginal) => {
		const original = await importOriginal<Record<string, unknown>>()
		return { ...original, ...mutant.disable(original) }
	})
}

/* imported after the mock, so a mutant reaches every module that uses it */
const { signJwt, verifyJwt } = (await import(
	resolvePath(REPO, "packages/core/src/security/jwt.ts")
)) as typeof import("../../../src/security/jwt.ts")

const EXPIRES = 4_102_444_800

async function publicJwk(): Promise<JsonWebKey> {
	const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair
	return crypto.subtle.exportKey("jwk", pair.publicKey)
}

describe("v1 adversarial: a public key never verifies as an HMAC secret", () => {
	it("refuses a token signed with the published key's own text", async () => {
		const jwk = await publicJwk()
		const forged = await signJwt({ exp: EXPIRES, sub: "admin" }, { alg: "HS256", key: JSON.stringify(jwk) })
		const result = await verifyJwt(forged, { algorithms: ["ES256"], jwk })
		expect(result.success).toBe(false)
	})
})

describe("v1 adversarial: a token with no expiry never lives forever by default", () => {
	it("refuses a signed token that carries no exp", async () => {
		const token = await signJwt({ sub: "user" }, { alg: "HS256", key: "secret" })
		const result = await verifyJwt(token, { algorithms: ["HS256"], secret: "secret" })
		expect(result).toEqual({ error: "invalid_claims", success: false })
	})
})
