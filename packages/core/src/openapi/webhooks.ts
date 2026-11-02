/**
 * The document's webhooks (OpenAPI 3.1): each request the API sends a subscriber, by name, as the
 * operation the subscriber serves. Its body converts on the output side, as the API writes it. A
 * declaration that cannot be sent as written is refused.
 */
import { compareCodeUnits } from "../schema/canonicalize.ts"
import type { Operation } from "./paths.ts"
import type { Convert } from "./responses.ts"

/** One request the API sends a subscriber. */
export type OpenApiWebhook = {
	/** the JSON request body's schema, converted as output the API writes */
	readonly body: unknown
	/** what the webhook is; CommonMark */
	readonly description?: string
	/** `"post"` by default */
	readonly method?: string
	/** a short label for the operation */
	readonly summary?: string
}

const METHODS: readonly string[] = ["delete", "get", "patch", "post", "put"]
/* C0, DEL and C1 */
const CONTROL = /\p{Cc}/u
/* a summary or description is CommonMark text: tabs and line breaks are its own */
const STRAY = /(?![\t\n\r])\p{Cc}/u

/** Each reason `webhook` cannot be sent as written. */
function webhookErrors(webhook: OpenApiWebhook, method: string): string[] {
	const errors = METHODS.includes(method) ? [] : [`method "${webhook.method}" is not one of ${METHODS.join(", ")}`]
	for (const [field, text] of [
		["summary", webhook.summary],
		["description", webhook.description],
	] as const) {
		if (text !== undefined && STRAY.test(text)) errors.push(`the ${field} holds a control character`)
	}
	return errors
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
		out[name] = { [method]: operation }
	}
	return out
}
