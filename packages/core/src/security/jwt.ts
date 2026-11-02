/**
 * `./jwt`: JWS compact tokens (RFC 7515, RFC 7519) on WebCrypto alone, so Node, Bun and Workers need no JWT library.
 * Claims follow jose's rules: `exp <= now - tolerance` is expired, `nbf > now + tolerance` is not yet valid, and a
 * max age counts from `iat`. An HMAC `secret` and a public key are separate options, so a token cannot choose which
 * one verifies it.
 */
import type { JwkSource } from "./jwks.ts"
import {
	ALGORITHMS,
	type AsymmetricAlgorithm,
	decodeBase64url,
	decodeJsonObject,
	encodeBase64url,
	hmacKey,
	isHmac,
	isJwsAlgorithm,
	type Jwk,
	type JwsAlgorithm,
	type JwtHeader,
	publicKey,
} from "./jws.ts"

export type { JwkLookup, JwkSource, RemoteJwksOptions } from "./jwks.ts"
export { remoteJwks } from "./jwks.ts"
export type { AsymmetricAlgorithm, Jwk, JwsAlgorithm, JwtHeader } from "./jws.ts"
export { isJwsAlgorithm } from "./jws.ts"

/** A token's claims. Verified only when they came from a `verifyJwt` success. */
export type JwtPayload = Record<string, unknown>

/**
 * Why a token was refused: `expired`, `invalid_claims` (issuer, audience or a time claim), `invalid_signature`,
 * `malformed`, or `unknown_key` (the issuer has no key for it).
 */
export type JwtVerifyError = "expired" | "invalid_claims" | "invalid_signature" | "malformed" | "unknown_key"

/** A verified token's claims, or why it was refused. */
export type JwtVerifyResult =
	| {
			/** Why the token was refused. */
			error: JwtVerifyError
			/** The token was refused. */
			success: false
	  }
	| {
			/** The verified claims. */
			payload: JwtPayload
			/** The token verified. */
			success: true
	  }

/** The claim rules every verify takes, whichever key it uses. */
export type JwtClaimOptions = {
	/** Accepted `aud` values: a token must carry one of them. */
	audience?: string | readonly string[]
	/** Seconds of clock skew allowed on the time claims. Default 0. */
	clockToleranceSeconds?: number
	/** Accepted `iss` values: a token must carry one of them. */
	issuer?: string | readonly string[]
	/** Refuses a token issued longer ago than this, in seconds, and requires `iat`. */
	maxAgeSeconds?: number
	/** Claims a token must carry, beyond `exp`. */
	requiredClaims?: readonly string[]
	/** Set `false` to accept a token with no `exp`, which never expires. Default `true`. */
	requireExp?: boolean
}

/** Verifies an HMAC token with a shared secret. */
export type JwtSecretOptions = JwtClaimOptions & {
	/** The `alg` values accepted. */
	algorithms: readonly JwsAlgorithm[]
	/** The HMAC secret. An empty or missing secret throws, so bad configuration never reads as a forged token. */
	secret: string
	/** Not with this kind of key: pass one of `secret`, `jwk` or `jwks`. */
	jwk?: never
	/** Not with this kind of key: pass one of `secret`, `jwk` or `jwks`. */
	jwks?: never
}

/** Verifies a token with one public key the app holds. */
export type JwtPublicKeyOptions = JwtClaimOptions & {
	/** The `alg` values accepted. */
	algorithms: readonly AsymmetricAlgorithm[]
	/** The public key. */
	jwk: Jwk
	/** Not with this kind of key: pass one of `secret`, `jwk` or `jwks`. */
	jwks?: never
	/** Not with this kind of key: pass one of `secret`, `jwk` or `jwks`. */
	secret?: never
}

/**
 * Verifies a token against an issuer's published keys. `audience` and `issuer` are required: those keys sign every
 * token that issuer gives any app, so only these two say the token is for yours.
 */
export type JwtKeySetOptions = Omit<JwtClaimOptions, "audience" | "issuer"> & {
	/** The `alg` values accepted. */
	algorithms: readonly AsymmetricAlgorithm[]
	/** Accepted `aud` values: for most issuers, your client id. */
	audience: string | readonly string[]
	/** Accepted `iss` values. */
	issuer: string | readonly string[]
	/** The issuer's keys, from `remoteJwks`. */
	jwks: JwkSource
	/** Not with this kind of key: pass one of `secret`, `jwk` or `jwks`. */
	jwk?: never
	/** Not with this kind of key: pass one of `secret`, `jwk` or `jwks`. */
	secret?: never
}

/** How `verifyJwt` checks a token: exactly one of `secret`, `jwk` or `jwks`. */
export type VerifyJwtOptions = JwtKeySetOptions | JwtPublicKeyOptions | JwtSecretOptions

/** How `signJwt` signs a token. */
export type SignJwtOptions = {
	/** The signing algorithm. */
	alg: JwsAlgorithm
	/** An HMAC secret, or a private `CryptoKey` from `importPkcs8`. */
	key: CryptoKey | string
	/** The key id to put in the header, for a verifier holding several keys. */
	kid?: string
}

const SEGMENTS = 3
const MS_PER_SECOND = 1000

const asList = (value: string | readonly string[]): readonly string[] => (typeof value === "string" ? [value] : value)

/**
 * The claims of `token`, unverified: for a token that arrived over a channel already trusted, or to route a request
 * before verifying it. Never authorize on this.
 *
 * @param token A compact JWS.
 * @returns The claims, or `null` when the token is not one.
 */
export function decodeJwtPayload(token: string): JwtPayload | null {
	const parts = token.split(".")
	const [, claims] = parts
	return parts.length === SEGMENTS ? decodeJsonObject(claims as string) : null
}

/**
 * A private signing key from a PKCS#8 PEM.
 *
 * @param pem The PEM, or its bare base64 body.
 * @param alg The algorithm the key signs with.
 * @returns The key, for `signJwt`.
 */
export function importPkcs8(pem: string, alg: AsymmetricAlgorithm): Promise<CryptoKey> {
	const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "")
	const der = Uint8Array.from(atob(body), (char) => char.charCodeAt(0))
	return crypto.subtle.importKey("pkcs8", der, ALGORITHMS[alg].import, false, ["sign"])
}

/**
 * Signs `payload` as a compact JWS. The header is `{ alg }`, plus `kid` when given. Set `exp` yourself:
 * `verifyJwt` refuses a token without one.
 *
 * @param payload The claims.
 * @param options The algorithm and key.
 * @returns The token.
 * @throws {TypeError} When a string key meets a non-HMAC `alg`, or is empty.
 */
export async function signJwt(payload: JwtPayload, options: SignJwtOptions): Promise<string> {
	const { alg, key, kid } = options
	if (typeof key === "string" && (!isHmac(alg) || key === "")) {
		throw new TypeError(`signJwt: a string key is a non-empty HMAC secret, and ${alg} needs a CryptoKey`)
	}
	const encoder = new TextEncoder()
	const header = kid === undefined ? { alg } : { alg, kid }
	const input = `${encodeBase64url(encoder.encode(JSON.stringify(header)))}.${encodeBase64url(encoder.encode(JSON.stringify(payload)))}`
	const signingKey = typeof key === "string" ? await hmacKey(key, alg) : key
	const signature = await crypto.subtle.sign(ALGORITHMS[alg].sign, signingKey, encoder.encode(input))
	return `${input}.${encodeBase64url(new Uint8Array(signature))}`
}

/** `payload` carries every claim `options` requires, and the `iss` and `aud` it accepts. */
function hasRequiredClaims(payload: JwtPayload, options: JwtClaimOptions): boolean {
	const { audience, issuer, maxAgeSeconds, requireExp = true } = options
	const required = [
		...(options.requiredClaims ?? []),
		...(requireExp ? ["exp"] : []),
		...(maxAgeSeconds === undefined ? [] : ["iat"]),
	]
	if (required.some((claim) => payload[claim] === undefined)) return false
	const { aud, iss } = payload
	if (issuer !== undefined && (typeof iss !== "string" || !asList(issuer).includes(iss))) return false
	const held: readonly unknown[] = Array.isArray(aud) ? aud : [aud]
	return audience === undefined || asList(audience).some((accepted) => held.includes(accepted))
}

/** Why the time claims of `payload` fail at this moment, or `null` when they pass. */
function timeError(payload: JwtPayload, options: JwtClaimOptions): JwtVerifyError | null {
	const { clockToleranceSeconds: tolerance = 0, maxAgeSeconds } = options
	const { exp, iat, nbf } = payload
	const now = Math.floor(Date.now() / MS_PER_SECOND)
	if ([exp, iat, nbf].some((claim) => claim !== undefined && typeof claim !== "number")) return "invalid_claims"
	if (maxAgeSeconds !== undefined && typeof iat === "number") {
		const age = now - iat
		if (age - tolerance > maxAgeSeconds) return "expired"
		if (age < -tolerance) return "invalid_claims"
	}
	if (typeof nbf === "number" && nbf > now + tolerance) return "invalid_claims"
	return typeof exp === "number" && exp <= now - tolerance ? "expired" : null
}

/** Why `payload` fails the claim rules, or `null` when it passes. */
function claimError(payload: JwtPayload, options: JwtClaimOptions): JwtVerifyError | null {
	return hasRequiredClaims(payload, options) ? timeError(payload, options) : "invalid_claims"
}

/** The key that verifies a token of `alg`, or why there is none. An HMAC `alg` only ever meets a `secret`. */
async function verifyingKey(
	options: VerifyJwtOptions,
	header: JwtHeader,
	alg: JwsAlgorithm,
): Promise<CryptoKey | JwtVerifyError> {
	const { jwk, jwks, secret } = options
	if (secret !== undefined || (jwk === undefined && jwks === undefined)) {
		if (typeof secret !== "string" || secret === "") throw new TypeError("verifyJwt: pass a `secret`, `jwk` or `jwks`")
		return isHmac(alg) ? hmacKey(secret, alg) : "invalid_signature"
	}
	if (isHmac(alg)) return "invalid_signature"
	const asymmetric = alg as AsymmetricAlgorithm
	const material = jwk ?? (await (jwks as JwkSource)({ ...header, alg: asymmetric }))
	if (material === null) return "unknown_key"
	try {
		return await publicKey(material, alg)
	} catch {
		/* a key that does not fit the token's alg cannot verify it, and the result says so */
		return "invalid_signature"
	}
}

/**
 * Verifies the signature, then the claims. Every refusal of the token is a result; it throws only for what the token
 * did not cause: a missing secret, or a `jwks` lookup that could not reach the issuer.
 *
 * @param token A compact JWS.
 * @param options The accepted algorithms, the key, and the claim rules.
 * @returns The verified claims, or why the token was refused.
 *
 * @example
 * const result = await verifyJwt(token, { algorithms: ["HS256"], audience: "api", issuer: "auth", secret })
 * if (!result.success) throw new HoneyError({ errorKey: "unauthorized", status: "unauthorized" })
 */
export async function verifyJwt(token: string, options: VerifyJwtOptions): Promise<JwtVerifyResult> {
	const parts = token.split(".")
	if (parts.length !== SEGMENTS) return { error: "malformed", success: false }
	const [headerPart = "", payloadPart = "", signaturePart = ""] = parts
	const header = decodeJsonObject(headerPart)
	const payload = decodeJsonObject(payloadPart)
	const signature = decodeBase64url(signaturePart)
	if (header === null || payload === null || signature === null) return { error: "malformed", success: false }

	const { alg } = header
	const accepted: readonly JwsAlgorithm[] = options.algorithms
	if (!isJwsAlgorithm(alg) || !accepted.includes(alg) || header["crit"] !== undefined) {
		return { error: "malformed", success: false }
	}
	const key = await verifyingKey(options, header, alg)
	if (typeof key === "string") return { error: key, success: false }
	const input = new TextEncoder().encode(`${headerPart}.${payloadPart}`)
	if (!(await crypto.subtle.verify(ALGORITHMS[alg].sign, key, signature, input))) {
		return { error: "invalid_signature", success: false }
	}
	const error = claimError(payload, options)
	return error === null ? { payload, success: true } : { error, success: false }
}
