import { Webhook } from "standardwebhooks"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { webhookContract } from "./webhook.ts"

const SECRET = `whsec_${btoa("k".repeat(32))}`
const OTHER = `whsec_${btoa("o".repeat(32))}`
const OCCURRED = new Date("2026-11-02T12:00:00.000Z")

const now = () => Math.floor(Date.now() / 1000)

const events = webhookContract({
	"batch.complete": z.object({ batchId: z.string(), rows: z.number() }),
	ping: z.object({}),
})

describe("webhookContract: one signed attempt of a declared event", () => {
	it("sends the Standard Webhooks envelope as JSON, which the official library verifies", async () => {
		const { body, headers } = await events.sign(
			"batch.complete",
			{ batchId: "b_1", rows: 3 },
			{ id: "msg_1", occurredAt: OCCURRED, secrets: SECRET },
		)
		expect([headers["content-type"], headers["webhook-id"], new Webhook(SECRET).verify(body, headers)]).toEqual([
			"application/json",
			"msg_1",
			{ data: { batchId: "b_1", rows: 3 }, timestamp: "2026-11-02T12:00:00.000Z", type: "batch.complete" },
		])
	})

	it("signs under each rotated secret, either verifying alone", async () => {
		const { body, headers } = await events.sign(
			"ping",
			{},
			{ id: "msg_1", occurredAt: OCCURRED, secrets: [SECRET, OTHER] },
		)
		const verifies = (secret: string) => new Webhook(secret).verify(body, headers) !== undefined
		expect([headers["webhook-signature"].split(" ").length, verifies(SECRET), verifies(OTHER)]).toEqual([2, true, true])
	})

	it("gives every attempt of one delivery the same body and id, and its own timestamp", async () => {
		const attempt = (timestamp: number) =>
			events.sign("ping", {}, { id: "msg_1", occurredAt: OCCURRED, secrets: SECRET, timestamp })
		const [first, retry] = [await attempt(1_000), await attempt(4_600)]
		expect([
			retry.body === first.body,
			retry.headers["webhook-id"] === first.headers["webhook-id"],
			[first.headers["webhook-timestamp"], retry.headers["webhook-timestamp"]],
		]).toEqual([true, true, ["1000", "4600"]])
	})

	it("verifies a retry an hour after the event, as each attempt is signed when it is sent", async () => {
		const hourAgo = new Date(Date.now() - 3_600_000)
		const late = await events.sign("ping", {}, { id: "msg_1", occurredAt: hourAgo, secrets: SECRET })
		const stale = await events.sign(
			"ping",
			{},
			{ id: "msg_1", occurredAt: hourAgo, secrets: SECRET, timestamp: now() - 3_600 },
		)
		expect(new Webhook(SECRET).verify(late.body, late.headers)).toMatchObject({ type: "ping" })
		expect(() => new Webhook(SECRET).verify(stale.body, stale.headers)).toThrow(/timestamp/i)
	})

	it("refuses what could never verify: an invalid occurredAt and a bad secret", async () => {
		await expect(
			events.sign("ping", {}, { id: "msg_1", occurredAt: new Date(Number.NaN), secrets: SECRET }),
		).rejects.toThrow(TypeError)
		await expect(
			events.sign("ping", {}, { id: "msg_1", occurredAt: OCCURRED, secrets: btoa("short") }),
		).rejects.toThrow(TypeError)
	})
})
