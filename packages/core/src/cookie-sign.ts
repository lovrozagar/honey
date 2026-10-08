const encoder = new TextEncoder()

/**
 * Signed value formats:
 *
 * - v2 (current): `<value>.~<sig>`, where `sig` is the HMAC-SHA256 of
 *   `"honey-cookie-v2\0" + name + "\0" + value`. The cookie name is bound into
 *   the MAC, so a signature cannot be replayed under another cookie that shares
 *   the secret. `~` is outside the base64url alphabet, so the two formats never
 *   overlap.
 * - v1 (legacy): `<value>.<sig>`, the HMAC of the value alone. `verify` accepts
 *   it while `legacy` is true (the default) so cookies issued before the change
 *   keep working during a migration window.
 */
const V2_MARKER = "~"
const V2_DOMAIN = "honey-cookie-v2\0"
/* An HMAC-SHA256 tag is 32 bytes: 43 base64url characters, no padding. */
const SIG_RE = /^[A-Za-z0-9_-]{43}$/

export type SignOptions = {
	/** The cookie name to bind the signature to. Pass the same name to `verify`. */
	name?: string
}

export type VerifyOptions = {
	/** The cookie name the signature must be bound to. */
	name?: string
	/**
	 * Also accept legacy (v1) signatures, which are not bound to a name.
	 * Default `true`; set `false` once every v1 cookie has expired.
	 */
	legacy?: boolean
}

const MAX_CACHED_KEYS = 32
const keyCache = new Map<string, Promise<CryptoKey>>()

function importKey(secret: string): Promise<CryptoKey> {
	let key = keyCache.get(secret)
	if (key === undefined) {
		key = crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, [
			"sign",
			"verify",
		])
		if (keyCache.size >= MAX_CACHED_KEYS) {
			const oldest = keyCache.keys().next().value
			if (oldest !== undefined) keyCache.delete(oldest)
		}
		keyCache.set(secret, key)
		/* A rejected import must not stay cached. */
		key.catch(() => keyCache.delete(secret))
	}
	return key
}

function toBase64Url(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer)
	let binary = ""
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i])
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Strict decode: the input must be the canonical encoding of a 32-byte tag. */
function fromBase64Url(str: string): Uint8Array<ArrayBuffer> | null {
	if (!SIG_RE.test(str)) return null
	let binary: string
	try {
		binary = atob(str.replace(/-/g, "+").replace(/_/g, "/"))
	} catch {
		return null
	}
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}
	/* Reject non-zero trailing bits, which would make signatures malleable. */
	if (toBase64Url(bytes.buffer) !== str) return null
	return bytes
}

function v2Payload(name: string, value: string): Uint8Array<ArrayBuffer> {
	return encoder.encode(`${V2_DOMAIN}${name}\0${value}`)
}

export async function sign(value: string, secret: string, opts: SignOptions = {}): Promise<string> {
	const key = await importKey(secret)
	const signature = await crypto.subtle.sign("HMAC", key, v2Payload(opts.name ?? "", value))
	return `${value}.${V2_MARKER}${toBase64Url(signature)}`
}

/** Returns the original value, or `null` when no secret verifies it or the input is malformed. */
export async function verify(signed: string, secrets: string[], opts: VerifyOptions = {}): Promise<string | null> {
	if (typeof signed !== "string" || signed.length === 0) return null
	const lastDot = signed.lastIndexOf(".")
	if (lastDot === -1) return null

	const value = signed.slice(0, lastDot)
	let sigText = signed.slice(lastDot + 1)
	const isV2 = sigText.startsWith(V2_MARKER)
	if (isV2) sigText = sigText.slice(V2_MARKER.length)
	else if (opts.legacy === false) return null

	const sig = fromBase64Url(sigText)
	if (sig === null) return null
	const payload = isV2 ? v2Payload(opts.name ?? "", value) : encoder.encode(value)

	for (const secret of secrets) {
		try {
			const key = await importKey(secret)
			if (await crypto.subtle.verify("HMAC", key, sig, payload)) return value
		} catch {
			/* An unusable secret never verifies. */
		}
	}

	return null
}
