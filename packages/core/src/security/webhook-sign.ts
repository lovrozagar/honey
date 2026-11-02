/**
 * `./webhook`: signs an outgoing webhook to the Standard Webhooks scheme on WebCrypto alone, so Node, Bun and Workers
 * share it and a receiver verifies with any library for that scheme. Keys are imported per call: no secret sits in
 * module state.
 */

/** The three headers of a signed delivery. */
export type WebhookHeaders = Record<"webhook-id" | "webhook-signature" | "webhook-timestamp", string>

/** What `signWebhook` signs. */
export type SignWebhookOptions = {
	/** The payload, exactly as sent: bytes are signed unchanged. */
	body: string | Uint8Array
	/** The delivery's id, the same on every retry, so a receiver can drop a repeat. No spaces or control characters. */
	id: string
	/**
	 * One or more base64 secrets, the `whsec_` prefix optional, each 24 to 64 bytes decoded. During a rotation pass
	 * both; dropping the expired one is yours to do.
	 */
	secrets: string | readonly string[]
	/** When this attempt was sent, in whole seconds since the epoch. */
	timestamp: number
}

const SECRET_PREFIX = "whsec_"
const MIN_SECRET_BYTES = 24
const MAX_SECRET_BYTES = 64
const VALID_ID = /^[^\s\p{Cc}]+$/u

/** The key bytes of `secret`. Its errors never carry the secret, as they reach logs. */
function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
	const base64 = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret
	let binary: string
	try {
		binary = atob(base64)
	} catch {
		throw new TypeError("signWebhook: a secret is not valid base64")
	}
	if (binary.length < MIN_SECRET_BYTES || binary.length > MAX_SECRET_BYTES) {
		throw new TypeError(`signWebhook: a secret must decode to ${MIN_SECRET_BYTES} to ${MAX_SECRET_BYTES} bytes`)
	}
	return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

/** The bytes the scheme signs: `id.timestamp.body`, with a bytes body left as it is. */
function signedContent(id: string, timestamp: number, body: string | Uint8Array): Uint8Array<ArrayBuffer> {
	const encoder = new TextEncoder()
	const head = encoder.encode(`${id}.${timestamp}.`)
	const tail = typeof body === "string" ? encoder.encode(body) : body
	const content = new Uint8Array(head.length + tail.length)
	content.set(head)
	content.set(tail, head.length)
	return content
}

async function signature(key: Uint8Array<ArrayBuffer>, content: Uint8Array<ArrayBuffer>): Promise<string> {
	const algorithm = { hash: "SHA-256", name: "HMAC" }
	const cryptoKey = await crypto.subtle.importKey("raw", key, algorithm, false, ["sign"])
	const signed = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, content))
	let binary = ""
	for (const byte of signed) binary += String.fromCharCode(byte)
	return `v1,${btoa(binary)}`
}

/**
 * The headers of a signed delivery, one signature per secret. Sign each attempt with its own `timestamp`, as a
 * receiver refuses an old one. Its receivers verify with a Standard Webhooks library.
 *
 * @param options The delivery and the secrets to sign it with.
 * @returns The headers to send with `body`.
 * @throws {TypeError} For what could never verify: no secret, a bad one, an `id` or a `timestamp` no header can carry.
 *
 * @example
 * const headers = await signWebhook({ body, id: delivery.id, secrets: endpoint.secret, timestamp: Math.floor(Date.now() / 1000) })
 * await fetch(endpoint.url, { body, headers, method: "POST" })
 */
export async function signWebhook(options: SignWebhookOptions): Promise<WebhookHeaders> {
	const { body, id, secrets, timestamp } = options
	if (!VALID_ID.test(id))
		throw new TypeError("signWebhook: `id` must be non-empty, with no spaces or control characters")
	if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
		throw new TypeError("signWebhook: `timestamp` must be whole seconds since the epoch")
	}
	const keys = (typeof secrets === "string" ? [secrets] : secrets).map(secretBytes)
	if (keys.length === 0) throw new TypeError("signWebhook: pass at least one secret")
	const content = signedContent(id, timestamp, body)
	const signatures = await Promise.all(keys.map((key) => signature(key, content)))
	return { "webhook-id": id, "webhook-signature": signatures.join(" "), "webhook-timestamp": String(timestamp) }
}
