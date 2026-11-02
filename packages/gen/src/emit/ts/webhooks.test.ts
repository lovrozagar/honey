/**
 * A TS SDK whose document declares Standard Webhooks events exports `verifyWebhook`: it checks a delivery's signature
 * on WebCrypto against the receiver's secrets, refuses a tampered, stale or unsigned one, and returns the event typed
 * by its `type`, with `known: false` for a type the document did not declare.
 */
import { Webhook } from "standardwebhooks"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { emittedWebhooks } from "./__fixtures__/emitted.ts"
import { generateSdk } from "./sdk.ts"

/** A Standard Webhooks event `type` as core documents it: the marker and the `{ type, timestamp, data }` envelope. */
const event = (type: string, data: Record<string, unknown>) => ({
	post: {
		"x-honey-webhook": "standard-webhooks",
		requestBody: {
			content: {
				"application/json": {
					schema: {
						properties: { data, timestamp: { format: "date-time", type: "string" }, type: { const: type } },
						required: ["type", "timestamp", "data"],
						type: "object",
					},
				},
			},
			required: true,
		},
		responses: { "2XX": { description: "Received" } },
	},
})

const PAID = { properties: { amount: { type: "integer" } }, required: ["amount"], type: "object" }

const document = (webhooks: Record<string, unknown>) => ({
	info: { title: "T", version: "1" },
	openapi: "3.1.0",
	paths: { "/health": { get: { operationId: "health", responses: { 200: { description: "ok" } } } } },
	webhooks,
})

const DOC = document({ "order.paid": event("order.paid", PAID), "order.refunded": event("order.refunded", PAID) })

type Verify = (body: string, headers: unknown, secret: string | readonly string[]) => Promise<Record<string, unknown>>

const sdk = await emittedWebhooks(DOC, { name: "Api", stem: "api" })
const verifyWebhook = sdk.verifyWebhook as Verify
const WebhookVerificationError = sdk.WebhookVerificationError as new (...args: never[]) => Error

/* Standard Webhooks' shared test vector */
const VECTOR = {
	body: '{"test": 2432232314}',
	id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
	secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
	signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
	timestamp: 1614265330,
}

const SECRET = "whsec_c2VjcmV0LWtleS1mb3ItdGhlLXRlc3RzLW9ubHk="
const OTHER = "whsec_YW5vdGhlci1rZXktbm9ib2R5LXNpZ25zLXdpdGg="
const NOW = 1_800_000_000

/** A delivery of `body` the library signs with `secret` at `at` seconds, its headers as a plain record. */
function delivery(body: string, secret = SECRET, at = NOW, id = "msg_1") {
	const signature = new Webhook(secret).sign(id, new Date(at * 1000), body)
	return {
		body,
		headers: { "webhook-id": id, "webhook-signature": signature, "webhook-timestamp": String(at) } as Record<
			string,
			string
		>,
	}
}

const PAID_BODY = JSON.stringify({ data: { amount: 42 }, timestamp: "2027-01-15T08:00:00.000Z", type: "order.paid" })

beforeEach(() => {
	vi.useFakeTimers({ now: NOW * 1000, toFake: ["Date"] })
})
afterEach(() => {
	vi.useRealTimers()
})

describe("verifyWebhook: a genuine delivery", () => {
	it("verifies Standard Webhooks' shared test vector at its timestamp", async () => {
		vi.setSystemTime(VECTOR.timestamp * 1000)
		const body = JSON.stringify({ data: { test: 2432232314 }, timestamp: "2021-02-25T15:02:10Z", type: "test" })
		/* the vector signs its own body, so the envelope is checked by a delivery of it below; here, the signature */
		const headers = {
			"webhook-id": VECTOR.id,
			"webhook-signature": VECTOR.signature,
			"webhook-timestamp": String(VECTOR.timestamp),
		}
		await expect(verifyWebhook(VECTOR.body, headers, VECTOR.secret)).rejects.toThrow(/not a Standard Webhooks event/)
		await expect(verifyWebhook(body, headers, VECTOR.secret)).rejects.toBeInstanceOf(WebhookVerificationError)
		await expect(verifyWebhook(VECTOR.body, headers, OTHER)).rejects.toThrow(/no signature matches/)
	})

	it("returns the library-signed event, typed and known", async () => {
		const { body, headers } = delivery(PAID_BODY)
		expect(await verifyWebhook(body, headers, SECRET)).toEqual({
			data: { amount: 42 },
			id: "msg_1",
			known: true,
			timestamp: "2027-01-15T08:00:00.000Z",
			type: "order.paid",
		})
	})

	it("reads the headers from a Headers and from an upper-case record", async () => {
		const { body, headers } = delivery(PAID_BODY)
		const upper = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toUpperCase(), v]))
		expect((await verifyWebhook(body, new Headers(headers), SECRET)).type).toBe("order.paid")
		expect((await verifyWebhook(body, upper, SECRET)).type).toBe("order.paid")
	})

	it("verifies under either key of a rotated pair", async () => {
		for (const key of [SECRET, OTHER]) {
			const { body, headers } = delivery(PAID_BODY, key)
			expect((await verifyWebhook(body, headers, [SECRET, OTHER])).id).toBe("msg_1")
		}
	})

	it("verifies when one of several signatures matches, and refuses a v2 signature alone", async () => {
		const { body, headers } = delivery(PAID_BODY)
		const signature = headers["webhook-signature"] as string
		const several = { ...headers, "webhook-signature": `v1,${btoa("x".repeat(32))} v2,abc ${signature}` }
		expect((await verifyWebhook(body, several, SECRET)).known).toBe(true)
		const v2 = { ...headers, "webhook-signature": signature.replace("v1,", "v2,") }
		await expect(verifyWebhook(body, v2, SECRET)).rejects.toBeInstanceOf(WebhookVerificationError)
	})
})

describe("verifyWebhook: a delivery it refuses", () => {
	it("refuses a changed body, a changed id and the wrong key", async () => {
		const { body, headers } = delivery(PAID_BODY)
		const refused = [
			verifyWebhook(body.replace("42", "43"), headers, SECRET),
			verifyWebhook(body, { ...headers, "webhook-id": "msg_2" }, SECRET),
			verifyWebhook(body, headers, OTHER),
		]
		for (const verdict of refused) await expect(verdict).rejects.toBeInstanceOf(WebhookVerificationError)
	})

	it("refuses a timestamp 301 seconds old or ahead, and accepts one 300 seconds either way", async () => {
		for (const skew of [-301, 301]) {
			const { body, headers } = delivery(PAID_BODY, SECRET, NOW + skew)
			await expect(verifyWebhook(body, headers, SECRET)).rejects.toThrow(/outside the tolerance/)
		}
		for (const skew of [-300, 300]) {
			const { body, headers } = delivery(PAID_BODY, SECRET, NOW + skew)
			expect((await verifyWebhook(body, headers, SECRET)).known).toBe(true)
		}
	})

	it.each(["webhook-id", "webhook-timestamp", "webhook-signature"])("refuses a delivery without %s", async (name) => {
		const { body, headers } = delivery(PAID_BODY)
		const without = Object.fromEntries(Object.entries(headers).filter(([k]) => k !== name))
		await expect(verifyWebhook(body, without, SECRET)).rejects.toThrow(`missing the ${name} header`)
	})

	it("throws a TypeError for a secret that is not base64, a configuration fault and no delivery's", async () => {
		const { body, headers } = delivery(PAID_BODY)
		await expect(verifyWebhook(body, headers, "whsec_not base64!")).rejects.toBeInstanceOf(TypeError)
		await expect(verifyWebhook(body, headers, [])).rejects.toBeInstanceOf(TypeError)
	})

	it("refuses a signed body that is not an event", async () => {
		for (const text of ["[1]", "not json", JSON.stringify({ data: {}, type: 1 })]) {
			const { body, headers } = delivery(text)
			await expect(verifyWebhook(body, headers, SECRET)).rejects.toThrow(/not a Standard Webhooks event/)
		}
	})
})

describe("verifyWebhook: an event type the document did not declare", () => {
	it("returns it with known: false, its type and its data", async () => {
		const text = JSON.stringify({ data: { why: "new" }, timestamp: "2027-01-15T08:00:00Z", type: "order.lost" })
		const { body, headers } = delivery(text)
		expect(await verifyWebhook(body, headers, SECRET)).toEqual({
			data: { why: "new" },
			id: "msg_1",
			known: false,
			timestamp: "2027-01-15T08:00:00Z",
			type: "order.lost",
		})
	})
})

describe("the event types", () => {
	const typesOf = (webhooks: Record<string, unknown>) =>
		generateSdk(document(webhooks), { name: "Api", stem: "api" }).files["api.types.gen.ts"] ?? ""

	it("documents each event by its type and the webhook's summary, else its description", () => {
		const summarized = event("order.paid", PAID)
		const described = event("order.refunded", PAID)
		const text = typesOf({
			"order.paid": { post: { ...summarized.post, description: "Not this", summary: "An order was paid" } },
			"order.refunded": { post: { ...described.post, description: "An order was refunded" } },
		})
		expect([
			text.includes("/** The order.paid webhook event: An order was paid */"),
			text.includes("/** The order.refunded webhook event: An order was refunded */"),
		]).toEqual([true, true])
	})

	it("names an event whose type starts with no letter after Event, so the name is an identifier", () => {
		expect(typesOf({ "2fa.enabled": event("2fa.enabled", PAID) })).toMatch(
			/^export type Event2faEnabledWebhookEvent = /m,
		)
	})

	it("refuses an event whose type names one of the SDK's own webhook types", () => {
		expect(() => generateSdk(document({ unknown: event("unknown", PAID) }), { name: "Api" })).toThrow(
			'webhook event "unknown" names the type UnknownWebhookEvent, which the SDK declares itself',
		)
	})

	it("refuses two event types whose TS names collide, naming both", () => {
		const colliding = document({ "order.paid": event("order.paid", PAID), order_paid: event("order_paid", PAID) })
		expect(() => generateSdk(colliding, { name: "Api", stem: "api" })).toThrow(
			'webhook events "order.paid" and "order_paid" both name the type OrderPaidWebhookEvent',
		)
	})
})
