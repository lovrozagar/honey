/**
 * A TS SDK's Standard Webhooks events: one type per event the document declares, the `WebhookEvent` union a receiver
 * narrows (`known` first, then `type`), and `${stem}.webhooks.gen.ts`, a receiver's whole import: the verifier and
 * `verifyWebhook`, which marks whether a delivery's type is one of them. Written only for a document that declares one.
 */
import type { IR, IRWebhookEvent } from "../../ir/model.ts"
import { blockCommentText, tsString } from "../shared/escape.ts"
import { compareCodeUnits, pascalWords } from "../shared/lang.ts"
import { irToTs, type TypeOptions } from "../shared/type-emitter.ts"
import { webhookSource } from "./http.ts"

/** The catch-all event and the union, declared beside the events. */
export const WEBHOOK_TYPES = ["UnknownWebhookEvent", "WebhookEvent"] as const

type NamedEvent = { readonly doc: string | undefined; readonly event: IRWebhookEvent; readonly name: string }

/** `ir`'s events in code-unit order of their type, each named; two that name one type throw, naming both. */
function namedEvents(ir: IR): NamedEvent[] {
	const named = ir.webhooks
		.flatMap(({ description, event, summary }) => (event ? [{ doc: summary ?? description, event }] : []))
		.sort((a, b) => compareCodeUnits(a.event.type, b.event.type))
		.map((entry) => {
			const base = pascalWords(entry.event.type)
			return { ...entry, name: `${/^[A-Za-z]/.test(base) ? "" : "Event"}${base}WebhookEvent` }
		})
	const byName = new Map<string, string>()
	for (const { event, name } of named) {
		const type = JSON.stringify(event.type)
		if ((WEBHOOK_TYPES as readonly string[]).includes(name))
			throw new Error(`webhook event ${type} names the type ${name}, which the SDK declares itself`)
		const taken = byName.get(name)
		if (taken !== undefined)
			throw new Error(`webhook events ${JSON.stringify(taken)} and ${type} both name the type ${name}`)
		byName.set(name, event.type)
	}
	return named
}

/** The type names `ir`'s events declare, for the component names to stay clear of; none without events. */
export function webhookTypeNames(ir: IR): string[] {
	const names = namedEvents(ir).map(({ name }) => name)
	return names.length === 0 ? [] : [...names, ...WEBHOOK_TYPES]
}

/** The event types and their union, for `types.gen.ts`; empty for a document without events. */
export function webhookTypesText(ir: IR, types: TypeOptions): string {
	const named = namedEvents(ir)
	if (named.length === 0) return ""
	const events = named.map(
		({
			doc,
			event,
			name,
		}) => `/** The ${blockCommentText(event.type)} webhook event${doc ? `: ${blockCommentText(doc)}` : ""} */
export type ${name} = { id: string; known: true; type: ${tsString(event.type)}; timestamp: string; data: ${irToTs(event.data, types)} }`,
	)
	return `${events.join("\n")}
/** An event of a type this SDK's document does not declare: a newer API's, its data as sent. */
export type UnknownWebhookEvent = { id: string; known: false; type: string; timestamp: string; data: unknown }
/** A verified delivery: check \`known\`, then switch on \`type\` for its typed \`data\`. */
export type WebhookEvent = ${[...named.map(({ name }) => name), "UnknownWebhookEvent"].join(" | ")}

`
}

/**
 * The `${stem}.webhooks.gen.ts` text of `ir`: the runtime's verifier verbatim, then `verifyWebhook` over it. It imports
 * only the event types, which compile away, so a receiver that imports it bundles no client.
 */
export function webhooksText(ir: IR, stem: string): string {
	const known = namedEvents(ir).map(({ event }) => tsString(event.type))
	return `import type { WebhookEvent } from "./${stem}.types.gen"

${webhookSource()}

const KNOWN: ReadonlySet<string> = new Set([${known.join(", ")}])

/**
 * Verifies a Standard Webhooks delivery against the receiver's secret (or, while rotating, both) and returns its
 * event: pass the body as received, before any parse, and the request's headers. A forged, tampered, stale or
 * malformed delivery is a \`WebhookVerificationError\`; a secret that is not a \`whsec_\` key is a \`TypeError\`.
 */
export async function verifyWebhook(
	body: string | Uint8Array,
	headers: WebhookHeaders,
	secret: string | readonly string[],
): Promise<WebhookEvent> {
	const event = await verifyStandardWebhook(body, headers, secret)
	return { ...event, known: KNOWN.has(event.type) } as WebhookEvent
}
`
}
