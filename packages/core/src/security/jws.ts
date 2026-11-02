/**
 * The JWS layer under `./jwt` (RFC 7515, RFC 7518) on WebCrypto alone, so it runs on Node, Bun and Workers: the
 * algorithms, base64url, and turning key material into a `CryptoKey`. Keys are imported per call: nothing outlives
 * the call, so no secret sits in module state (an HMAC import costs microseconds).
 */

/** How one `alg` imports its key and signs with it, in WebCrypto's terms. */
type AlgorithmEntry = {
	/** The parameters `importKey` takes for this algorithm. */
	readonly import: AlgorithmIdentifier | EcKeyImportParams | HmacImportParams | RsaHashedImportParams
	/** The JWK key type this algorithm uses. */
	readonly kty: "EC" | "OKP" | "RSA" | "oct"
	/** The parameters `sign` and `verify` take for this algorithm. */
	readonly sign: AlgorithmIdentifier | EcdsaParams | RsaPssParams
}

/** Every algorithm honey signs and verifies, in WebCrypto's terms. */
export const ALGORITHMS = {
	ES256: { import: { name: "ECDSA", namedCurve: "P-256" }, kty: "EC", sign: { hash: "SHA-256", name: "ECDSA" } },
	ES384: { import: { name: "ECDSA", namedCurve: "P-384" }, kty: "EC", sign: { hash: "SHA-384", name: "ECDSA" } },
	ES512: { import: { name: "ECDSA", namedCurve: "P-521" }, kty: "EC", sign: { hash: "SHA-512", name: "ECDSA" } },
	EdDSA: { import: { name: "Ed25519" }, kty: "OKP", sign: { name: "Ed25519" } },
	HS256: { import: { hash: "SHA-256", name: "HMAC" }, kty: "oct", sign: { name: "HMAC" } },
	HS384: { import: { hash: "SHA-384", name: "HMAC" }, kty: "oct", sign: { name: "HMAC" } },
	HS512: { import: { hash: "SHA-512", name: "HMAC" }, kty: "oct", sign: { name: "HMAC" } },
	PS256: { import: { hash: "SHA-256", name: "RSA-PSS" }, kty: "RSA", sign: { name: "RSA-PSS", saltLength: 32 } },
	PS384: { import: { hash: "SHA-384", name: "RSA-PSS" }, kty: "RSA", sign: { name: "RSA-PSS", saltLength: 48 } },
	PS512: { import: { hash: "SHA-512", name: "RSA-PSS" }, kty: "RSA", sign: { name: "RSA-PSS", saltLength: 64 } },
	RS256: { import: { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" }, kty: "RSA", sign: { name: "RSASSA-PKCS1-v1_5" } },
	RS384: { import: { hash: "SHA-384", name: "RSASSA-PKCS1-v1_5" }, kty: "RSA", sign: { name: "RSASSA-PKCS1-v1_5" } },
	RS512: { import: { hash: "SHA-512", name: "RSASSA-PKCS1-v1_5" }, kty: "RSA", sign: { name: "RSASSA-PKCS1-v1_5" } },
} as const satisfies Record<string, AlgorithmEntry>

/** A JWS `alg` honey signs and verifies. `none` is not one. */
export type JwsAlgorithm = keyof typeof ALGORITHMS

/** A JWS `alg` verified with a public key: every one but the HMAC family. */
export type AsymmetricAlgorithm = Exclude<JwsAlgorithm, "HS256" | "HS384" | "HS512">

/** A public JSON Web Key, as a JWKS endpoint serves it. */
export type Jwk = JsonWebKey & {
	/** The one algorithm this key is for, when the issuer states it. */
	alg?: string
	/** The id a token names in its header to pick this key. */
	kid?: string
}

/** A JOSE header, unverified. */
export type JwtHeader = Record<string, unknown> & {
	/** The algorithm the token claims. Nothing is trusted until it passes `algorithms`. */
	alg?: unknown
	/** The id of the key the token claims to be signed with. */
	kid?: unknown
}

const BASE64URL = /^[\w-]*$/
const BASE64_BLOCK = 4

/** `value` is one of the algorithms honey supports. */
export function isJwsAlgorithm(value: unknown): value is JwsAlgorithm {
	return typeof value === "string" && Object.hasOwn(ALGORITHMS, value)
}

/** `alg` is verified with a shared secret, never with a public key. */
export function isHmac(alg: JwsAlgorithm): boolean {
	return ALGORITHMS[alg].kty === "oct"
}

/** `bytes` as unpadded base64url. */
export function encodeBase64url(bytes: Uint8Array): string {
	let binary = ""
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

/** The bytes of a base64url segment, or `null` when it is not one. */
export function decodeBase64url(segment: string): Uint8Array<ArrayBuffer> | null {
	if (!BASE64URL.test(segment)) return null
	const base64 = segment.replaceAll("-", "+").replaceAll("_", "/")
	try {
		const binary = atob(base64.padEnd(Math.ceil(base64.length / BASE64_BLOCK) * BASE64_BLOCK, "="))
		return Uint8Array.from(binary, (char) => char.charCodeAt(0))
	} catch {
		/* a client's bad token, which the caller answers as `malformed`: nothing to report */
		return null
	}
}

/** The JSON object a base64url segment holds, or `null` when it holds anything else. */
export function decodeJsonObject(segment: string): Record<string, unknown> | null {
	const bytes = decodeBase64url(segment)
	if (bytes === null) return null
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null
	} catch {
		/* a client's bad token, which the caller answers as `malformed`: nothing to report */
		return null
	}
}

/** The HMAC key of `secret` for `alg`. */
export function hmacKey(secret: string, alg: JwsAlgorithm): Promise<CryptoKey> {
	const usage: KeyUsage[] = ["sign", "verify"]
	return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), ALGORITHMS[alg].import, false, usage)
}

/** Only the public members: issuers add `use`, `x5c` or a differing `alg`, which `importKey` rejects. */
function publicMembers(jwk: Jwk, alg: JwsAlgorithm): JsonWebKey {
	const { kty } = ALGORITHMS[alg]
	if (kty === "RSA") return { e: jwk.e, kty, n: jwk.n }
	if (kty === "EC") return { crv: jwk.crv, kty, x: jwk.x, y: jwk.y }
	return { crv: jwk.crv, kty, x: jwk.x }
}

/** The verifying key of `jwk` for `alg`. */
export function publicKey(jwk: Jwk, alg: JwsAlgorithm): Promise<CryptoKey> {
	return crypto.subtle.importKey("jwk", publicMembers(jwk, alg), ALGORITHMS[alg].import, false, ["verify"])
}
