import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { remoteJwks, type JwkSource } from "./jwks.ts"
import type { Jwk } from "./jws.ts"
import { signJwt, verifyJwt } from "./jwt.ts"

const NOW = 1_900_000_000
const FUTURE = NOW + 3600
const JWKS_URL = "https://idp.test/jwks"

const failure = (error: string) => ({ error, success: false })

const claims = { aud: "api", exp: FUTURE, iss: "idp" }

async function rsaPair(): Promise<{ jwk: JsonWebKey; privateKey: CryptoKey }> {
	const pair = (await crypto.subtle.generateKey(
		{ hash: "SHA-256", modulusLength: 2048, name: "RSASSA-PKCS1-v1_5", publicExponent: new Uint8Array([1, 0, 1]) },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair
	return { jwk: await crypto.subtle.exportKey("jwk", pair.publicKey), privateKey: pair.privateKey }
}

function issuerOptions(jwks: JwkSource) {
	return { algorithms: ["RS256"], audience: "api", issuer: "idp", jwks } as const
}

function serve(body: () => unknown) {
	const fetchMock = vi.fn(async () => Response.json(body()))
	vi.stubGlobal("fetch", fetchMock)
	return fetchMock
}

const noKey: JwkSource = () => Promise.resolve(null)

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] })
	vi.setSystemTime(NOW * 1000)
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

describe("remoteJwks picks a key", () => {
	it("imports a provider key with extra members and no alg", async () => {
		const { jwk, privateKey } = await rsaPair()
		const published = { e: jwk.e, kid: "k1", kty: "RSA", n: jwk.n, use: "sig", x5t: "thumb" }
		serve(() => ({ keys: [published] }))
		const token = await signJwt(claims, { alg: "RS256", key: privateKey, kid: "k1" })
		expect((await verifyJwt(token, issuerOptions(remoteJwks(JWKS_URL)))).success).toBe(true)
	})

	it("needs no kid when one key can verify, and refuses to guess among several", async () => {
		const one = await rsaPair()
		const two = await rsaPair()
		let keys: Jwk[] = [one.jwk]
		serve(() => ({ keys }))
		const token = await signJwt(claims, { alg: "RS256", key: one.privateKey })
		expect((await verifyJwt(token, issuerOptions(remoteJwks(JWKS_URL)))).success).toBe(true)
		keys = [one.jwk, two.jwk]
		expect(await verifyJwt(token, issuerOptions(remoteJwks(JWKS_URL)))).toEqual(failure("unknown_key"))
	})

	it("skips a key stated for another algorithm", async () => {
		const { jwk, privateKey } = await rsaPair()
		serve(() => ({ keys: [{ ...jwk, alg: "RS512", kid: "k1" }] }))
		const token = await signJwt(claims, { alg: "RS256", key: privateKey, kid: "k1" })
		expect(await verifyJwt(token, issuerOptions(remoteJwks(JWKS_URL)))).toEqual(failure("unknown_key"))
	})
})

describe("remoteJwks fetches", () => {
	it("caches, refetches on an unknown kid, and holds the cooldown", async () => {
		const one = await rsaPair()
		const two = await rsaPair()
		let keys: Jwk[] = [{ ...one.jwk, kid: "k1" }]
		const fetchMock = serve(() => ({ keys }))
		const options = issuerOptions(remoteJwks(JWKS_URL))

		const first = await signJwt(claims, { alg: "RS256", key: one.privateKey, kid: "k1" })
		expect((await verifyJwt(first, options)).success).toBe(true)
		expect((await verifyJwt(first, options)).success).toBe(true)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		keys = [...keys, { ...two.jwk, kid: "k2" }]
		const rotated = await signJwt(claims, { alg: "RS256", key: two.privateKey, kid: "k2" })
		expect(await verifyJwt(rotated, options)).toEqual(failure("unknown_key"))
		expect(fetchMock).toHaveBeenCalledTimes(1)

		vi.setSystemTime((NOW + 31) * 1000)
		expect((await verifyJwt(rotated, options)).success).toBe(true)
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it("fetches again once maxAgeMs has passed", async () => {
		const { jwk, privateKey } = await rsaPair()
		const fetchMock = serve(() => ({ keys: [jwk] }))
		const options = issuerOptions(remoteJwks(JWKS_URL))
		const token = await signJwt({ ...claims, exp: NOW + 7200 }, { alg: "RS256", key: privateKey })
		await verifyJwt(token, options)
		vi.setSystemTime((NOW + 601) * 1000)
		await verifyJwt(token, options)
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it("concurrent lookups share one fetch, and each gets the key", async () => {
		const { jwk, privateKey } = await rsaPair()
		const fetchMock = serve(() => ({ keys: [jwk] }))
		const options = issuerOptions(remoteJwks(JWKS_URL))
		const token = await signJwt(claims, { alg: "RS256", key: privateKey })
		const results = await Promise.all([1, 2, 3].map(() => verifyJwt(token, options)))
		expect(results.every((result) => result.success)).toBe(true)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})
})

describe("remoteJwks through an outage", () => {
	it("throws when the endpoint fails and no keys are held", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("down", { status: 503 })),
		)
		const { privateKey } = await rsaPair()
		const token = await signJwt(claims, { alg: "RS256", key: privateKey, kid: "k1" })
		await expect(verifyJwt(token, issuerOptions(remoteJwks(JWKS_URL)))).rejects.toThrow("JWKS fetch failed: 503")
	})

	it("throws on a body that is no key set", async () => {
		serve(() => ({ nope: true }))
		const { privateKey } = await rsaPair()
		const token = await signJwt(claims, { alg: "RS256", key: privateKey })
		await expect(verifyJwt(token, issuerOptions(remoteJwks(JWKS_URL)))).rejects.toThrow("JWKS has no keys")
	})

	it("holds a failure for the cooldown rather than fetching again", async () => {
		const fetchMock = vi.fn(async () => new Response("down", { status: 503 }))
		vi.stubGlobal("fetch", fetchMock)
		const { privateKey } = await rsaPair()
		const options = issuerOptions(remoteJwks(JWKS_URL))
		const token = await signJwt(claims, { alg: "RS256", key: privateKey })
		await expect(verifyJwt(token, options)).rejects.toThrow("JWKS fetch failed")
		await expect(verifyJwt(token, options)).rejects.toThrow("JWKS fetch failed")
		expect(fetchMock).toHaveBeenCalledTimes(1)
		vi.setSystemTime((NOW + 31) * 1000)
		await expect(verifyJwt(token, options)).rejects.toThrow("JWKS fetch failed")
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})
})

describe("remoteJwks with keys held through an outage", () => {
	it("serves held keys for staleMs, then throws", async () => {
		const { jwk, privateKey } = await rsaPair()
		let up = true
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => (up ? Response.json({ keys: [jwk] }) : new Response("down", { status: 503 }))),
		)
		const options = issuerOptions(remoteJwks(JWKS_URL, { maxAgeMs: 1000, staleMs: 2000 }))
		const token = await signJwt({ ...claims, exp: NOW + 7200 }, { alg: "RS256", key: privateKey })
		expect((await verifyJwt(token, options)).success).toBe(true)
		up = false
		vi.setSystemTime(NOW * 1000 + 2500)
		expect((await verifyJwt(token, options)).success).toBe(true)
		vi.setSystemTime(NOW * 1000 + 3500)
		await expect(verifyJwt(token, options)).rejects.toThrow("JWKS fetch failed")
	})

	it("a failed refetch for an unknown kid leaves the kid unknown, not an outage", async () => {
		const { jwk, privateKey } = await rsaPair()
		let up = true
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => (up ? Response.json({ keys: [{ ...jwk, kid: "k1" }] }) : new Response("", { status: 503 }))),
		)
		const options = issuerOptions(remoteJwks(JWKS_URL))
		const known = await signJwt(claims, { alg: "RS256", key: privateKey, kid: "k1" })
		expect((await verifyJwt(known, options)).success).toBe(true)
		up = false
		vi.setSystemTime((NOW + 31) * 1000)
		const forged = await signJwt(claims, { alg: "RS256", key: privateKey, kid: "k9" })
		expect(await verifyJwt(forged, options)).toEqual(failure("unknown_key"))
	})

	it("replaces a fetch that never settles, as one left behind by a finished Workers request", async () => {
		const { jwk, privateKey } = await rsaPair()
		const fetchMock = vi
			.fn<() => Promise<Response>>()
			.mockImplementationOnce(() => new Promise<Response>(() => undefined))
			.mockImplementation(async () => Response.json({ keys: [jwk] }))
		vi.stubGlobal("fetch", fetchMock)
		const options = issuerOptions(remoteJwks(JWKS_URL, { cooldownMs: 0, timeoutMs: 10 }))
		const token = await signJwt(claims, { alg: "RS256", key: privateKey })
		await expect(verifyJwt(token, options)).rejects.toThrow("timed out")
		vi.setSystemTime(NOW * 1000 + 11)
		expect((await verifyJwt(token, options)).success).toBe(true)
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it("gives up on an endpoint that never answers", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise<Response>(() => undefined)),
		)
		const { privateKey } = await rsaPair()
		const token = await signJwt(claims, { alg: "RS256", key: privateKey })
		await expect(verifyJwt(token, issuerOptions(remoteJwks(JWKS_URL, { timeoutMs: 10 })))).rejects.toThrow("timed out")
	})
})

describe("verifyJwt over a key source of the app's own", () => {
	it("a null from the source is unknown_key", async () => {
		const { privateKey } = await rsaPair()
		const token = await signJwt(claims, { alg: "RS256", key: privateKey })
		expect(await verifyJwt(token, issuerOptions(noKey))).toEqual(failure("unknown_key"))
	})
})
