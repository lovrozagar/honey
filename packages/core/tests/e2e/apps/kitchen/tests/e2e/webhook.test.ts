import { expect, test } from "@playwright/test"
import { verifyWebhook, WebhookVerificationError } from "../../src/_gen/sdk/ts/kitchen.webhook.gen.ts"
import { WEBHOOK_SECRET } from "../../src/webhook-secret.ts"

type Sample = { body: string; headers: Record<string, string> }

/** The sample delivery, signed now: the receiver refuses one more than five minutes off its clock. */
const SAMPLE = () => `/api/webhook-sample?at=${Math.floor(Date.now() / 1000)}`

test.describe("webhooks", () => {
	test("the SDK verifies the delivery the app signs through its contract, typed by its event", async ({ request }) => {
		const res = await request.get(SAMPLE())
		expect(res.status()).toBe(200)
		const { body, headers } = (await res.json()) as Sample
		const event = await verifyWebhook(body, headers, WEBHOOK_SECRET)
		expect(event.known && event.type === "order.paid" ? event.data : undefined).toEqual({
			amount: 4200,
			orderId: "ord_1",
		})
		expect(event.id).toBe("msg_1")
	})

	test("the SDK refuses that delivery with one byte of its body changed", async ({ request }) => {
		const { body, headers } = (await (await request.get(SAMPLE())).json()) as Sample
		const tampered = body.replace("4200", "4201")
		expect(tampered).not.toBe(body)
		await expect(verifyWebhook(tampered, headers, WEBHOOK_SECRET)).rejects.toBeInstanceOf(WebhookVerificationError)
	})
})
