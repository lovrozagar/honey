/**
 * `timingSafeEqual(a, b)`: constant-time equality for secrets (an API key, a token), on WebCrypto
 * alone, so it runs on Node, Bun and Workers. Both sides are MACed under a key drawn fresh for the
 * call and the MACs compared by `crypto.subtle.verify`, so neither the content nor the length of
 * either side leaks through timing, and no key outlives the comparison (no module state, H23).
 */

/**
 * Strings compare by UTF-16 code unit, not by their UTF-8 encoding: UTF-8 turns every lone
 * surrogate into U+FFFD, so two different strings would compare equal.
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

export async function timingSafeEqual(a: string | Uint8Array, b: string | Uint8Array): Promise<boolean> {
	/* a string never equals bytes: "ab" and its code units differ */
	if ((typeof a === "string") !== (typeof b === "string")) return false
	const raw = crypto.getRandomValues(new Uint8Array(32))
	const key = await crypto.subtle.importKey("raw", raw, { hash: "SHA-256", name: "HMAC" }, false, ["sign", "verify"])
	const mac = await crypto.subtle.sign("HMAC", key, toBytes(a))
	return crypto.subtle.verify("HMAC", key, mac, toBytes(b))
}
