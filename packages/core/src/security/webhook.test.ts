import { describe, expect, it } from "vitest"
import * as z from "zod"
import { signWebhook, webhookContract } from "./webhook.ts"

const SECRET = `whsec_${btoa("k".repeat(32))}`

describe("./webhook: the contract and signWebhook sign alike", () => {
	it("gives a contract attempt the headers signWebhook gives its body", async () => {
		const events = webhookContract({ ping: z.object({}) })
		const delivery = { id: "msg_1", secrets: SECRET, timestamp: 1_793_000_000 }
		const { body, headers } = await events.sign("ping", {}, { ...delivery, occurredAt: new Date(0) })
		expect(headers).toEqual({ ...(await signWebhook({ ...delivery, body })), "content-type": "application/json" })
	})
})
