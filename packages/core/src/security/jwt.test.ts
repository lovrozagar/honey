import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { KNOWN_ANSWER } from "../../tests/fixture/jwt-known-answer.ts"
import {
	type AsymmetricAlgorithm,
	decodeJwtPayload,
	importPkcs8,
	isJwsAlgorithm,
	type Jwk,
	type JwkSource,
	type JwsAlgorithm,
	type JwtClaimOptions,
	signJwt,
	verifyJwt,
} from "./jwt.ts"

const SECRET = "test-secret-at-least-32-bytes-long!!"
const KNOWN_ANSWER_SECRET = "known-answer-secret-of-32-bytes!!"
const NOW = 1_900_000_000
const FUTURE = NOW + 3600

const encodeJson = (value: unknown): string =>
	btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "")

const hs256 = (payload: Record<string, unknown>) => signJwt(payload, { alg: "HS256", key: SECRET })

const verifyHs256 = (token: string, options: JwtClaimOptions = {}) =>
	verifyJwt(token, { algorithms: ["HS256"], secret: SECRET, ...options })

const failure = (error: string) => ({ error, success: false })

const rsaParams = (name: string, hash: string): RsaHashedKeyGenParams => ({
	hash,
	modulusLength: 2048,
	name,
	publicExponent: new Uint8Array([1, 0, 1]),
})

async function rsaPair(): Promise<{ jwk: JsonWebKey; privateKey: CryptoKey }> {
	const pair = (await crypto.subtle.generateKey(rsaParams("RSASSA-PKCS1-v1_5", "SHA-256"), true, [
		"sign",
		"verify",
	])) as CryptoKeyPair
	return { jwk: await crypto.subtle.exportKey("jwk", pair.publicKey), privateKey: pair.privateKey }
}

const knownAnswerKey = (alg: AsymmetricAlgorithm): Jwk =>
	alg.startsWith("RS") || alg.startsWith("PS")
		? KNOWN_ANSWER.keys.RSA
		: KNOWN_ANSWER.keys[alg as "EdDSA" | "ES256" | "ES384" | "ES512"]

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] })
	vi.setSystemTime(NOW * 1000)
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

describe("verifyJwt accepts what jose signed", () => {
	it("HS256", async () => {
		const result = await verifyJwt(KNOWN_ANSWER.tokens.HS256, {
			algorithms: ["HS256"],
			issuer: "https://issuer.test",
			secret: KNOWN_ANSWER_SECRET,
		})
		expect(result).toEqual({ payload: KNOWN_ANSWER.payload, success: true })
	})

	const asymmetric = (Object.keys(KNOWN_ANSWER.tokens) as JwsAlgorithm[]).filter(
		(alg): alg is AsymmetricAlgorithm => alg !== "HS256",
	)

	it.each(asymmetric)("%s", async (alg) => {
		const result = await verifyJwt(KNOWN_ANSWER.tokens[alg], {
			algorithms: [alg],
			issuer: "https://issuer.test",
			jwk: knownAnswerKey(alg),
		})
		expect(result).toEqual({ payload: KNOWN_ANSWER.payload, success: true })
	})

	it("signs HS256 byte for byte as jose did", async () => {
		expect(await signJwt(KNOWN_ANSWER.payload, { alg: "HS256", key: KNOWN_ANSWER_SECRET })).toBe(
			KNOWN_ANSWER.tokens.HS256,
		)
	})
})

describe("verifyJwt round trips every algorithm", () => {
	const params: Record<AsymmetricAlgorithm, AlgorithmIdentifier | EcKeyGenParams | RsaHashedKeyGenParams> = {
		ES256: { name: "ECDSA", namedCurve: "P-256" },
		ES384: { name: "ECDSA", namedCurve: "P-384" },
		ES512: { name: "ECDSA", namedCurve: "P-521" },
		EdDSA: { name: "Ed25519" },
		PS256: rsaParams("RSA-PSS", "SHA-256"),
		PS384: rsaParams("RSA-PSS", "SHA-384"),
		PS512: rsaParams("RSA-PSS", "SHA-512"),
		RS256: rsaParams("RSASSA-PKCS1-v1_5", "SHA-256"),
		RS384: rsaParams("RSASSA-PKCS1-v1_5", "SHA-384"),
		RS512: rsaParams("RSASSA-PKCS1-v1_5", "SHA-512"),
	}

	it.each(["HS256", "HS384", "HS512"] as const)("%s", async (alg) => {
		const token = await signJwt({ a: 1, exp: FUTURE }, { alg, key: SECRET })
		expect(await verifyJwt(token, { algorithms: [alg], secret: SECRET })).toEqual({
			payload: { a: 1, exp: FUTURE },
			success: true,
		})
	})

	it.each(Object.keys(params) as AsymmetricAlgorithm[])("%s", async (alg) => {
		const pair = (await crypto.subtle.generateKey(params[alg], true, ["sign", "verify"])) as CryptoKeyPair
		const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
		const token = await signJwt({ a: 1, exp: FUTURE }, { alg, key: pair.privateKey, kid: "k1" })
		expect(await verifyJwt(token, { algorithms: [alg], jwk })).toEqual({
			payload: { a: 1, exp: FUTURE },
			success: true,
		})
	})
})

describe("verifyJwt claim checks", () => {
	it("is expired from the second exp + tolerance is reached", async () => {
		expect((await verifyHs256(await hs256({ exp: NOW - 29 }), { clockToleranceSeconds: 30 })).success).toBe(true)
		expect(await verifyHs256(await hs256({ exp: NOW - 30 }), { clockToleranceSeconds: 30 })).toEqual(failure("expired"))
		expect(await verifyHs256(await hs256({ exp: NOW }))).toEqual(failure("expired"))
		expect((await verifyHs256(await hs256({ exp: NOW + 1 }))).success).toBe(true)
	})

	it("requires exp unless told not to", async () => {
		expect(await verifyHs256(await hs256({ sub: "u" }))).toEqual(failure("invalid_claims"))
		expect((await verifyHs256(await hs256({ sub: "u" }), { requireExp: false })).success).toBe(true)
	})

	it("still refuses an expired token with exp optional", async () => {
		expect(await verifyHs256(await hs256({ exp: NOW }), { requireExp: false })).toEqual(failure("expired"))
	})

	it("refuses a missing required claim", async () => {
		expect(await verifyHs256(await hs256({ exp: FUTURE }), { requiredClaims: ["sub"] })).toEqual(
			failure("invalid_claims"),
		)
	})

	it.each([[{ exp: "soon" }], [{ exp: FUTURE, nbf: "now" }], [{ exp: FUTURE, iat: "then" }]])(
		"refuses the non-numeric time claim in %j",
		async (payload) => {
			expect(await verifyHs256(await hs256(payload))).toEqual(failure("invalid_claims"))
		},
	)

	it("refuses a token not yet valid beyond the tolerance", async () => {
		const options = { clockToleranceSeconds: 30 }
		expect(await verifyHs256(await hs256({ exp: FUTURE, nbf: NOW + 31 }), options)).toEqual(failure("invalid_claims"))
		expect((await verifyHs256(await hs256({ exp: FUTURE, nbf: NOW + 30 }), options)).success).toBe(true)
	})

	it("holds a max age to iat", async () => {
		const options = { maxAgeSeconds: 3600 }
		expect(await verifyHs256(await hs256({ exp: FUTURE }), options)).toEqual(failure("invalid_claims"))
		expect(await verifyHs256(await hs256({ exp: FUTURE, iat: NOW - 3601 }), options)).toEqual(failure("expired"))
		expect(await verifyHs256(await hs256({ exp: FUTURE, iat: NOW + 1 }), options)).toEqual(failure("invalid_claims"))
		expect((await verifyHs256(await hs256({ exp: FUTURE, iat: NOW - 3600 }), options)).success).toBe(true)
	})
})

describe("verifyJwt issuer and audience", () => {
	it("matches the issuer against one or several", async () => {
		const token = await hs256({ exp: FUTURE, iss: "https://www.facebook.com" })
		const several = ["https://facebook.com", "https://www.facebook.com"]
		expect((await verifyHs256(token, { issuer: several })).success).toBe(true)
		expect(await verifyHs256(token, { issuer: "https://evil.test" })).toEqual(failure("invalid_claims"))
		expect(await verifyHs256(await hs256({ exp: FUTURE }), { issuer: "anyrow" })).toEqual(failure("invalid_claims"))
	})

	it("matches the audience in a string or an array", async () => {
		const exp = FUTURE
		expect((await verifyHs256(await hs256({ aud: "a", exp }), { audience: "a" })).success).toBe(true)
		expect((await verifyHs256(await hs256({ aud: ["b", "a"], exp }), { audience: "a" })).success).toBe(true)
		expect((await verifyHs256(await hs256({ aud: "a", exp }), { audience: ["x", "a"] })).success).toBe(true)
		expect(await verifyHs256(await hs256({ aud: "b", exp }), { audience: "a" })).toEqual(failure("invalid_claims"))
		expect(await verifyHs256(await hs256({ exp }), { audience: "a" })).toEqual(failure("invalid_claims"))
	})
})

describe("verifyJwt refuses forgeries", () => {
	it("a tampered payload or another secret is an invalid signature", async () => {
		const [header, , signature] = (await hs256({ exp: FUTURE, sub: "u" })).split(".")
		const tampered = `${header}.${encodeJson({ exp: FUTURE, sub: "admin" })}.${signature}`
		expect(await verifyHs256(tampered)).toEqual(failure("invalid_signature"))
		const other = await signJwt({ exp: FUTURE }, { alg: "HS256", key: "another-secret" })
		expect(await verifyHs256(other)).toEqual(failure("invalid_signature"))
	})

	it("an alg outside the allow list, alg none, or a crit header is malformed", async () => {
		const payload = encodeJson({ exp: FUTURE })
		expect(await verifyHs256(`${encodeJson({ alg: "none" })}.${payload}.`)).toEqual(failure("malformed"))
		expect(await verifyHs256(`${encodeJson({ alg: "HS512" })}.${payload}.c2ln`)).toEqual(failure("malformed"))
		const crit = { alg: "HS256", b64: false, crit: ["b64"] }
		expect(await verifyHs256(`${encodeJson(crit)}.${payload}.c2ln`)).toEqual(failure("malformed"))
		const emptyCrit = { alg: "HS256", crit: [] }
		expect(await verifyHs256(`${encodeJson(emptyCrit)}.${payload}.c2ln`)).toEqual(failure("malformed"))
	})

	it("a secret never verifies an asymmetric token, nor a JWK an HMAC one", async () => {
		const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
			"sign",
			"verify",
		])) as CryptoKeyPair
		const es256 = await signJwt({ exp: FUTURE }, { alg: "ES256", key: pair.privateKey })
		expect(await verifyJwt(es256, { algorithms: ["ES256", "HS256"], secret: SECRET })).toEqual(
			failure("invalid_signature"),
		)
		const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
		const accepted = ["ES256", "HS256"] as unknown as readonly AsymmetricAlgorithm[]
		expect(await verifyJwt(await hs256({ exp: FUTURE }), { algorithms: accepted, jwk })).toEqual(
			failure("invalid_signature"),
		)
	})

	it("a public key's own bytes are no HMAC secret (algorithm confusion)", async () => {
		const { jwk } = await rsaPair()
		const forged = await signJwt({ exp: FUTURE }, { alg: "HS256", key: JSON.stringify(jwk) })
		const accepted = ["HS256", "RS256"] as unknown as readonly AsymmetricAlgorithm[]
		expect(await verifyJwt(forged, { algorithms: accepted, jwk })).toEqual(failure("invalid_signature"))
	})
})

describe("verifyJwt refuses what is not a token for this key", () => {
	it("an HMAC token never reaches a key source", async () => {
		const source = vi.fn<JwkSource>(() => Promise.resolve(null))
		const accepted = ["HS256", "RS256"] as unknown as readonly AsymmetricAlgorithm[]
		const options = { algorithms: accepted, audience: "api", issuer: "idp", jwks: source }
		expect(await verifyJwt(await hs256({ exp: FUTURE }), options)).toEqual(failure("invalid_signature"))
		expect(source).not.toHaveBeenCalled()
	})

	it("a key that does not fit the token's algorithm is an invalid signature", async () => {
		const { privateKey } = await rsaPair()
		const token = await signJwt({ exp: FUTURE }, { alg: "RS256", key: privateKey })
		expect(await verifyJwt(token, { algorithms: ["RS256"], jwk: { kty: "RSA" } })).toEqual(failure("invalid_signature"))
	})

	it.each(["not-a-jwt", "a.b", "a.b.c.d", "!!!.e30.sig", `${encodeJson({ alg: "HS256" })}.${encodeJson([1])}.sig`])(
		"%s is malformed",
		async (token) => {
			expect(await verifyHs256(token)).toEqual(failure("malformed"))
		},
	)

	it("no key at all is a configuration error, not a forged token", async () => {
		const token = await hs256({ exp: FUTURE })
		await expect(verifyJwt(token, { algorithms: ["HS256"], secret: "" })).rejects.toThrow(TypeError)
		const unset = { algorithms: ["HS256"], secret: undefined } as unknown as Parameters<typeof verifyJwt>[1]
		await expect(verifyJwt(token, unset)).rejects.toThrow(TypeError)
	})
})

describe("signJwt", () => {
	it("refuses a string key for an asymmetric algorithm, and an empty secret", async () => {
		await expect(signJwt({}, { alg: "RS256", key: "secret" })).rejects.toThrow(TypeError)
		await expect(signJwt({}, { alg: "HS256", key: "" })).rejects.toThrow(TypeError)
	})
})

describe("decode and helpers", () => {
	it("decodeJwtPayload reads UTF-8 and base64url characters without verifying", async () => {
		const payload = { name: "Željko ✓", path: "a?b>c~~" }
		const token = await signJwt(payload, { alg: "HS256", key: "any" })
		expect(token.split(".")[1]).toMatch(/[-_]/)
		expect(decodeJwtPayload(token)).toEqual(payload)
	})

	it("decodeJwtPayload returns null for garbage", () => {
		expect(decodeJwtPayload("garbage")).toBeNull()
		expect(decodeJwtPayload("a.!!.c")).toBeNull()
		expect(decodeJwtPayload(`a.${btoa("not json")}.c`)).toBeNull()
		expect(decodeJwtPayload("a.a.c")).toBeNull()
	})

	it("isJwsAlgorithm knows exactly the supported algorithms", () => {
		expect(["HS256", "HS512", "RS256", "PS512", "ES512", "EdDSA"].every(isJwsAlgorithm)).toBe(true)
		expect(["none", "toString", "", 1].some(isJwsAlgorithm)).toBe(false)
	})

	it("importPkcs8 takes a PEM or its bare body", async () => {
		const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
			"sign",
			"verify",
		])) as CryptoKeyPair
		const body = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))))
		const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
		for (const pem of [body, `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`]) {
			const token = await signJwt({ exp: FUTURE }, { alg: "ES256", key: await importPkcs8(pem, "ES256") })
			expect((await verifyJwt(token, { algorithms: ["ES256"], jwk })).success).toBe(true)
		}
	})
})
