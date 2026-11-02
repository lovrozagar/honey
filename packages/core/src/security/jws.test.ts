import { describe, expect, it } from "vitest"
import { decodeBase64url, decodeJsonObject, encodeBase64url, isHmac, isJwsAlgorithm, publicKey } from "./jws.ts"

const text = (value: string) => encodeBase64url(new TextEncoder().encode(value))

describe("base64url", () => {
	it("round trips every byte, unpadded and URL safe", () => {
		const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
		const encoded = encodeBase64url(bytes)
		expect(encoded).toMatch(/^[\w-]+$/)
		expect(decodeBase64url(encoded)).toEqual(bytes)
	})

	it.each(["a+b", "a/b", "a=", "a b"])("%s is not base64url", (segment) => {
		expect(decodeBase64url(segment)).toBeNull()
	})

	it("a length no base64 has is refused", () => {
		expect(decodeBase64url("a")).toBeNull()
	})
})

describe("decodeJsonObject", () => {
	it("reads an object", () => {
		expect(decodeJsonObject(text('{"a":1}'))).toEqual({ a: 1 })
	})

	it.each(["[1]", "null", "1", "not json"])("%s is no object", (value) => {
		expect(decodeJsonObject(text(value))).toBeNull()
	})

	it("a segment that is not base64url is no object", () => {
		expect(decodeJsonObject("!!")).toBeNull()
	})
})

describe("algorithms", () => {
	it("an inherited name is no algorithm", () => {
		expect(isJwsAlgorithm("toString")).toBe(false)
	})

	it("only the HS family is HMAC", () => {
		expect(isHmac("HS384")).toBe(true)
		expect(isHmac("RS256")).toBe(false)
	})
})

describe("publicKey", () => {
	it("drops what an issuer adds that importKey would refuse", async () => {
		const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair
		const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
		const key = await publicKey({ ...jwk, alg: "other", key_ops: ["wrapKey"], use: "enc" }, "EdDSA")
		expect(key.usages).toEqual(["verify"])
	})
})
