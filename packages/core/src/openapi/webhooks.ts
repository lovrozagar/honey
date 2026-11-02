/**
 * The document's webhooks (OpenAPI 3.1): each event of the app's webhook contract, by type, as the
 * POST a subscriber serves. Every delivery is a Standard Webhooks one, so each states the three
 * signature headers, the `{ type, timestamp, data }` envelope and `x-honey-webhook`, which tells a
 * generator to emit a verifier. `data` converts on the output side, as the sender writes it.
 */
import type { WebhookContract, WebhookEvents } from "../security/webhook-contract.ts"
import { compareCodeUnits } from "../schema/canonicalize.ts"
import type { Operation } from "./paths.ts"
import type { Convert } from "./responses.ts"

/* C0, DEL and C1 */
const CONTROL = /\p{Cc}/u

/* the headers every delivery carries, in the order the scheme names them */
const HEADERS = ["webhook-id", "webhook-timestamp", "webhook-signature"]

/** The 3.1 `webhooks` of `contract`, by event type in code-unit order; each refusal reported through `error`. */
export function webhooksOf(
	contract: WebhookContract<WebhookEvents> | undefined,
	convert: Convert,
	error: (message: string) => void,
): Record<string, Record<string, Operation>> {
	const events = contract?.events ?? {}
	const out: Record<string, Record<string, Operation>> = {}
	for (const type of Object.keys(events).sort(compareCodeUnits)) {
		if (type === "") error("a webhook event needs a type")
		else if (CONTROL.test(type)) error(`webhook ${JSON.stringify(type)}: the type holds a control character`)
		const data = convert(events[type], "output", `${type}Data`)
		const envelope = {
			properties: { data, timestamp: { format: "date-time", type: "string" }, type: { const: type } },
			required: ["type", "timestamp", "data"],
			type: "object",
		}
		out[type] = {
			post: {
				"x-honey-webhook": "standard-webhooks",
				parameters: HEADERS.map((name) => ({ in: "header", name, required: true, schema: { type: "string" } })),
				requestBody: { content: { "application/json": { schema: envelope } }, required: true },
				responses: { "2XX": { description: "Received" } },
			},
		}
	}
	return out
}
