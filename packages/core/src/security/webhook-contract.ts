/**
 * The events an API sends its subscribers, declared once: the contract signs each delivery attempt
 * to the Standard Webhooks scheme, and `generateOpenApi` documents each event from it, so a
 * generated SDK verifies and types what the sender wrote.
 */
import type { InferOutput, StandardSchemaLike } from "../validation/standard-schema.ts"
import { signWebhook, type WebhookHeaders } from "./webhook-sign.ts"

/** The event types of a contract, each with the schema of its `data`. */
export type WebhookEvents = Readonly<Record<string, StandardSchemaLike>>

/** One attempt of a delivery: what stays across retries, and when this attempt is sent. */
export type WebhookSignOptions = {
	/** The delivery's id, the same on every retry, so a receiver can drop a repeat. No spaces or control characters. */
	id: string
	/** When the event happened, the same on every retry; the body's `timestamp`. */
	occurredAt: Date
	/** One or more base64 secrets, the `whsec_` prefix optional, each 24 to 64 bytes decoded. */
	secrets: string | readonly string[]
	/** When this attempt is sent, in whole seconds since the epoch; now when left out. */
	timestamp?: number
}

/** A signed attempt, ready to POST: the JSON body and every header to send with it. */
export type SignedWebhook = {
	/** `{ type, timestamp, data }` as JSON, exactly as signed. */
	body: string
	/** The three signature headers and the body's content type. */
	headers: WebhookHeaders & {
		/** Always JSON: the body is the envelope as JSON text. */
		"content-type": "application/json"
	}
}

/** The events an API sends, and how to sign one attempt of each. */
export type WebhookContract<Events extends WebhookEvents> = {
	/** The schema of each event type's `data`. */
	readonly events: Events
	/**
	 * Signs one attempt of `type` with `data`. No schema runs here: `data` is typed as the schema's
	 * output, which is what the document states and each SDK decodes.
	 */
	sign<Type extends keyof Events & string>(
		type: Type,
		data: InferOutput<Events[Type]>,
		options: WebhookSignOptions,
	): Promise<SignedWebhook>
}

/**
 * Declares the events an API sends, by type. Pass it as `generateOpenApi`'s `webhooks` to document
 * them, and sign each attempt with `sign`: keep `id` and `occurredAt` across retries, and each
 * attempt gets its own timestamp, so a retry hours later still verifies.
 *
 * @param events Each event type with the schema of its `data`.
 * @returns The contract: its events, and `sign`.
 * @throws {TypeError} From `sign`, for what could never verify: an invalid `occurredAt`, a bad secret, id or timestamp.
 *
 * @example
 * const events = webhookContract({ "order.shipped": z.object({ orderId: z.string() }) })
 * const { body, headers } = await events.sign("order.shipped", { orderId }, { id: delivery.id, occurredAt: delivery.at, secrets: endpoint.secret })
 * await fetch(endpoint.url, { body, headers, method: "POST" })
 */
export function webhookContract<Events extends WebhookEvents>(events: Events): WebhookContract<Events> {
	return {
		events,
		sign: async (type, data, { id, occurredAt, secrets, timestamp }) => {
			if (Number.isNaN(occurredAt.getTime())) throw new TypeError("webhookContract: `occurredAt` is not a valid date")
			const body = JSON.stringify({ data, timestamp: occurredAt.toISOString(), type })
			const signed = await signWebhook({ body, id, secrets, timestamp: timestamp ?? Math.floor(Date.now() / 1000) })
			return { body, headers: { ...signed, "content-type": "application/json" } }
		},
	}
}
