/**
 * Signed cookie values: HMAC-SHA256 over WebCrypto, verified in constant time by
 * `crypto.subtle.verify`. Key rotation is a secret list: the first signs, any verifies.
 *
 * The format is `<value>.~<sig>`, the HMAC of `"honey-cookie-v2\0" + name + "\0" + value`. The
 * cookie name is bound into the MAC, so a signature cannot be replayed under another cookie that
 * shares the secret. The unbound v1 format (`<value>.<sig>`, the HMAC of the value alone) is gone:
 * it never verifies.
 */

// per-process-constant: text-codec
const encoder = /* @__PURE__ */ new TextEncoder()

const V2_MARKER = "~"
const V2_DOMAIN = "honey-cookie-v2\0"
/* an HMAC-SHA256 tag is 32 bytes: 43 base64url characters, no padding */
const SIG_RE = /^[A-Za-z0-9_-]{43}$/

/** Options for `createCookieSigner()`: the cookie it signs for, and its secrets. */
export type CookieSignerOptions = {
	/** The cookie's name, bound into every signature: a value signed for one cookie never verifies as another. */
	name: string
	/** The first signs and any verifies, so secrets can rotate. */
	secrets: readonly [string, ...string[]]
}

/**
 * Import a secret's HMAC key. The rejection is observed here, so an unused unusable secret raises
 * no unhandled rejection; awaiting the key still throws.
 */
function importKey(secret: string): Promise<CryptoKey> {
	const key = crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, [
		"sign",
		"verify",
	])
	/* marked handled here; every caller awaits the key, and verify() answers false for one that failed */
	key.catch(() => undefined)
	return key
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = ""
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

/** Strict decode: the input must be the canonical encoding of a 32-byte tag. */
function fromBase64Url(str: string): Uint8Array<ArrayBuffer> | null {
	if (!SIG_RE.test(str)) return null
	const binary = atob(str.replaceAll("-", "+").replaceAll("_", "/"))
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
	/* non-zero trailing bits would make signatures malleable */
	if (toBase64Url(bytes) !== str) return null
	return bytes
}

function v2Payload(name: string, value: string): Uint8Array<ArrayBuffer> {
	return encoder.encode(`${V2_DOMAIN}${name}\0${value}`)
}

type Parsed = { payload: Uint8Array<ArrayBuffer>; sig: Uint8Array<ArrayBuffer>; value: string }

/** Split a signed value into the value, its tag and the payload the tag covers; `null` when malformed. */
function parseSigned(signed: string, name: string): Parsed | null {
	const marker = signed.lastIndexOf(`.${V2_MARKER}`)
	if (marker === -1) return null
	const value = signed.slice(0, marker)
	const sig = fromBase64Url(signed.slice(marker + 1 + V2_MARKER.length))
	if (sig === null) return null
	return { payload: v2Payload(name, value), sig, value }
}

async function verifiesWith(
	key: Promise<CryptoKey>,
	sig: Uint8Array<ArrayBuffer>,
	payload: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
	try {
		return await crypto.subtle.verify("HMAC", await key, sig, payload)
	} catch {
		/* an unusable secret never verifies */
		return false
	}
}

/** Signs and verifies one cookie's values: the first secret signs, any secret verifies, so secrets can rotate. */
export type CookieSigner = {
	/** Sign with the first secret, bound to the cookie's name. Rejects when WebCrypto cannot import that secret. */
	sign(value: string): Promise<string>
	/** The original value, or `null` when no secret verifies it for this cookie or the input is malformed. */
	verify(signed: string): Promise<string | null>
}

/**
 * The signer for one cookie: its name is bound into every signature, the first secret signs and any verifies.
 * Each key is imported once, on first use, and held by the signer, so a per-request verify costs no key import.
 * Build one per cookie, once. Throws `TypeError` for an empty name or no secret.
 */
export function createCookieSigner(options: CookieSignerOptions): CookieSigner {
	const { name, secrets } = options
	if (secrets.length === 0) throw new TypeError("createCookieSigner: secrets needs at least one secret")
	if (!name) throw new TypeError("createCookieSigner: name must be the cookie's name")
	let keys: Promise<CryptoKey>[] | null = null
	const keysOf = (): Promise<CryptoKey>[] => (keys ??= secrets.map(importKey))
	return {
		async sign(value) {
			const signature = await crypto.subtle.sign(
				"HMAC",
				await (keysOf()[0] as Promise<CryptoKey>),
				v2Payload(name, value),
			)
			return `${value}.${V2_MARKER}${toBase64Url(new Uint8Array(signature))}`
		},
		async verify(signed) {
			const parsed = parseSigned(signed, name)
			if (parsed === null) return null
			for (const key of keysOf()) if (await verifiesWith(key, parsed.sig, parsed.payload)) return parsed.value
			return null
		},
	}
}
