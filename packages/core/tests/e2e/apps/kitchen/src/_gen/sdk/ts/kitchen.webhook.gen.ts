import type { WebhookEvent } from "./kitchen.types.gen.js"

export type {
	OrderPaidWebhookEvent,
	OrderRefundedWebhookEvent,
	UnknownWebhookEvent,
	WebhookEvent,
} from "./kitchen.types.gen.js"

/** A webhook delivery that is not genuine: unsigned, signed by no key the receiver holds, stale, or not an event. */
export class WebhookVerificationError extends Error {
	override readonly name = "WebhookVerificationError"
}

/** A delivery's headers: a `Headers`, or a record in any case as Node's `IncomingHttpHeaders` holds them. */
export type WebhookHeaders = Headers | Readonly<Record<string, string | readonly string[] | undefined>>

/** A verified Standard Webhooks event, untyped: the delivery's id and its body's envelope. */
type VerifiedWebhook = { id: string; type: string; timestamp: string; data: unknown }

/* how far a delivery's timestamp may be from now, either way, in seconds */
const TOLERANCE = 300

/** The header `name` (lower case) of `headers`, read case-insensitively; several values are one space-separated. */
function headerOf(headers: WebhookHeaders, name: string): string | undefined {
	if (headers instanceof Headers) return headers.get(name) ?? undefined
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name && value !== undefined) return typeof value === "string" ? value : value.join(" ")
	}
	return undefined
}

/** `text`'s base64 bytes, or undefined when it is not base64. */
function base64Bytes(text: string): Uint8Array<ArrayBuffer> | undefined {
	let binary: string
	try {
		binary = atob(text)
	} catch {
		return undefined
	}
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
	return bytes
}

/** The HMAC-SHA256 keys of `secrets` (`whsec_` and base64); a secret that is not one is a `TypeError`. */
function keysOf(secrets: string | readonly string[]): Promise<CryptoKey[]> {
	const list = typeof secrets === "string" ? [secrets] : secrets
	if (list.length === 0) throw new TypeError("verifyWebhook: no secret to verify with")
	return Promise.all(
		list.map((secret) => {
			const bytes = base64Bytes(secret.startsWith("whsec_") ? secret.slice(6) : secret)
			if (!bytes?.length) throw new TypeError("verifyWebhook: a secret is not a base64 key, with or without whsec_")
			return crypto.subtle.importKey("raw", bytes, { hash: "SHA-256", name: "HMAC" }, false, ["verify"])
		}),
	)
}

/** The bytes a Standard Webhooks signature covers: `{id}.{timestamp}.{body}`. */
function signedContent(id: string, timestamp: string, body: Uint8Array): Uint8Array<ArrayBuffer> {
	const prefix = new TextEncoder().encode(`${id}.${timestamp}.`)
	const bytes = new Uint8Array(prefix.length + body.length)
	bytes.set(prefix)
	bytes.set(body, prefix.length)
	return bytes
}

/** `body` parsed as a Standard Webhooks envelope, or a `WebhookVerificationError` naming why it is not one. */
function envelopeOf(text: string): Omit<VerifiedWebhook, "id"> {
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch (cause) {
		throw new WebhookVerificationError("the signed body is not a Standard Webhooks event: not JSON", { cause })
	}
	const event = value as Partial<Record<"data" | "timestamp" | "type", unknown>> | null
	if (
		typeof event !== "object" ||
		event === null ||
		Array.isArray(event) ||
		typeof event.type !== "string" ||
		typeof event.timestamp !== "string" ||
		!("data" in event)
	)
		throw new WebhookVerificationError("the signed body is not a Standard Webhooks event { type, timestamp, data }")
	return { data: event.data, timestamp: event.timestamp, type: event.type }
}

/**
 * Verifies a Standard Webhooks delivery and returns its event. The body is the raw text (or bytes) as received, before
 * any parse; `secrets` holds the receiver's key or, while rotating, both. A delivery whose `webhook-signature` holds no
 * `v1` signature one of the keys makes over its id, timestamp and body, whose timestamp is more than five minutes
 * from now either way, or whose body is not a `{ type, timestamp, data }` event is a `WebhookVerificationError`; a
 * secret that is not a key is a `TypeError`. Signatures are checked by WebCrypto, in constant time.
 */
async function verifyStandardWebhook(
	body: string | Uint8Array,
	headers: WebhookHeaders,
	secrets: string | readonly string[],
): Promise<VerifiedWebhook> {
	const keys = await keysOf(secrets)
	const [id, timestamp, signatures] = ["webhook-id", "webhook-timestamp", "webhook-signature"].map((name) => {
		const value = headerOf(headers, name)
		if (!value) throw new WebhookVerificationError(`the delivery is missing the ${name} header`)
		return value
	}) as [string, string, string]
	const sentAt = /^\d+$/.test(timestamp) ? Number(timestamp) : Number.NaN
	if (!(Math.abs(Date.now() / 1000 - sentAt) <= TOLERANCE))
		throw new WebhookVerificationError(`the delivery's timestamp ${timestamp} is outside the tolerance of now`)
	const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body
	const content = signedContent(id, timestamp, bytes)
	const candidates = signatures
		.split(" ")
		.flatMap((entry) => (entry.startsWith("v1,") ? [base64Bytes(entry.slice(3))] : []))
		.filter((signature) => signature !== undefined)
	for (const signature of candidates) {
		for (const key of keys) {
			if (await crypto.subtle.verify("HMAC", key, signature, content)) {
				const text = typeof body === "string" ? body : new TextDecoder().decode(body)
				return { id, ...envelopeOf(text) }
			}
		}
	}
	throw new WebhookVerificationError("no signature matches a key the receiver holds")
}

const KNOWN: ReadonlySet<string> = new Set(["order.paid", "order.refunded"])

/**
 * Verifies a Standard Webhooks delivery against the receiver's secret (or, while rotating, both) and returns its
 * event: pass the body as received, before any parse, and the request's headers. A forged, tampered, stale or
 * malformed delivery is a `WebhookVerificationError`; a secret that is not a `whsec_` key is a `TypeError`.
 */
export async function verifyWebhook(
	body: string | Uint8Array,
	headers: WebhookHeaders,
	secret: string | readonly string[],
): Promise<WebhookEvent> {
	const event = await verifyStandardWebhook(body, headers, secret)
	return { ...event, known: KNOWN.has(event.type) } as WebhookEvent
}
