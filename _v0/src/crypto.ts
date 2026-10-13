let cachedKey: CryptoKey | null = null

async function getKey(): Promise<CryptoKey> {
	if (cachedKey === null) {
		cachedKey = await crypto.subtle.generateKey({ hash: "SHA-256", name: "HMAC" }, false, ["sign", "verify"])
	}
	return cachedKey
}

/**
 * Strings are compared by UTF-16 code unit, not by their UTF-8 encoding: UTF-8
 * replaces every lone surrogate with U+FFFD, so two different strings would
 * compare equal.
 */
function toBytes(value: string | Uint8Array): Uint8Array<ArrayBuffer> {
	if (typeof value !== "string") return new Uint8Array(value)
	const bytes = new Uint8Array(value.length * 2)
	for (let i = 0; i < value.length; i++) {
		const unit = value.charCodeAt(i)
		bytes[i * 2] = unit >> 8
		bytes[i * 2 + 1] = unit & 0xff
	}
	return bytes
}

/**
 * Constant-time equality. Both sides are MACed with a per-process random key and
 * the MACs are compared by `crypto.subtle.verify`, so neither content nor length
 * leaks through timing.
 */
export async function timingSafeEqual(a: string | Uint8Array, b: string | Uint8Array): Promise<boolean> {
	/* A string never equals bytes: tag the kind so "ab" and its code units differ. */
	const aIsString = typeof a === "string"
	if (aIsString !== (typeof b === "string")) return false
	const key = await getKey()
	const sig = await crypto.subtle.sign("HMAC", key, toBytes(a))
	return crypto.subtle.verify("HMAC", key, sig, toBytes(b))
}
