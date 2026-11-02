/**
 * `./webhook`: outgoing webhooks to the Standard Webhooks scheme on WebCrypto alone, so Node, Bun and
 * Workers share it. `webhookContract` declares the events an API sends and signs each attempt;
 * `signWebhook` signs any body for receivers outside that contract.
 */
export {
	type SignedWebhook,
	type WebhookContract,
	webhookContract,
	type WebhookEvents,
	type WebhookSignOptions,
} from "./webhook-contract.ts"
export { type SignWebhookOptions, signWebhook, type WebhookHeaders } from "./webhook-sign.ts"
