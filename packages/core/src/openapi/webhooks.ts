/**
 * The document's webhooks (OpenAPI 3.1): each request the API sends a subscriber, by name, as the
 * operation the subscriber serves. Its body converts on the output side, as the API writes it. A
 * signed webhook states how as `x-honey-signature`, which the SDKs' verify helpers read; a
 * declaration that cannot be signed or sent as written is refused.
 */
import { compareCodeUnits } from "../schema/canonicalize.ts"
import type { Operation } from "./paths.ts"
import type { Convert } from "./responses.ts"

export type WebhookSignature = {
	readonly algorithm: "hmac-sha256"
	readonly encoding: "base64" | "hex"
	readonly header: string
	/** what precedes the digest in the header, as `sha256=` */
	readonly prefix?: string
}

export type OpenApiWebhook = {
	readonly body: unknown
	readonly description?: string
	/** `"post"` by default */
	readonly method?: string
	readonly signature?: WebhookSignature
	readonly summary?: string
}

const METHODS: readonly string[] = ["delete", "get", "patch", "post", "put"]
/* C0, DEL and C1 */
const CONTROL = /\p{Cc}/u
/* a summary or description is CommonMark text: tabs and line breaks are its own */
const STRAY = /(?![\t\n\r])\p{Cc}/u
/* RFC 9110 token: a header name */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** Each reason `signature` cannot be checked as written. */
function signatureErrors(signature: WebhookSignature): string[] {
	const errors: string[] = []
	if (signature.algorithm !== "hmac-sha256")
		errors.push(`signature algorithm "${signature.algorithm}" is not hmac-sha256`)
	if (signature.encoding !== "hex" && signature.encoding !== "base64")
		errors.push(`signature encoding "${signature.encoding}" is not hex or base64`)
	if (!TOKEN.test(signature.header))
		errors.push(`signature header ${JSON.stringify(signature.header)} is not a header name`)
	if (signature.prefix !== undefined && CONTROL.test(signature.prefix))
		errors.push("the signature prefix holds a control character")
	return errors
}

/** Each reason `webhook` cannot be sent as written. */
function webhookErrors(webhook: OpenApiWebhook, method: string): string[] {
	const errors = METHODS.includes(method) ? [] : [`method "${webhook.method}" is not one of ${METHODS.join(", ")}`]
	for (const [field, text] of [
		["summary", webhook.summary],
		["description", webhook.description],
	] as const) {
		if (text !== undefined && STRAY.test(text)) errors.push(`the ${field} holds a control character`)
	}
	return webhook.signature === undefined ? errors : [...errors, ...signatureErrors(webhook.signature)]
}

/** The 3.1 `webhooks` of `webhooks`, by name in code-unit order; each refusal reported through `error`. */
export function webhooksOf(
	webhooks: Readonly<Record<string, OpenApiWebhook>> | undefined,
	convert: Convert,
	error: (message: string) => void,
): Record<string, Record<string, Operation>> {
	const out: Record<string, Record<string, Operation>> = {}
	for (const name of Object.keys(webhooks ?? {}).sort(compareCodeUnits)) {
		const webhook = (webhooks as Record<string, OpenApiWebhook>)[name] as OpenApiWebhook
		const method = (webhook.method ?? "post").toLowerCase()
		if (name === "") error("a webhook needs a name")
		else if (CONTROL.test(name)) error(`webhook ${JSON.stringify(name)}: the name holds a control character`)
		for (const reason of webhookErrors(webhook, method)) error(`webhook ${JSON.stringify(name)}: ${reason}`)
		const operation: Operation = {}
		if (webhook.summary !== undefined) operation.summary = webhook.summary
		if (webhook.description !== undefined) operation.description = webhook.description
		const schema = convert(webhook.body, "output", `${name}Webhook`)
		operation.requestBody = { content: { "application/json": { schema } }, required: true }
		operation.responses = { "200": { description: "Received" } }
		if (webhook.signature !== undefined) operation["x-honey-signature"] = signatureOf(webhook.signature)
		out[name] = { [method]: operation }
	}
	return out
}

/** The signature as the SDKs read it: its own fields only, in one order. */
function signatureOf(signature: WebhookSignature): WebhookSignature {
	const { algorithm, encoding, header, prefix } = signature
	return prefix === undefined ? { algorithm, encoding, header } : { algorithm, encoding, header, prefix }
}
