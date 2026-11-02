/**
 * The adversarial suite's webhook cases: a secret too short to protect anything, and a signature that
 * leaves the id and timestamp out, so a captured delivery replays, signed directly or through a contract. Each is a failing input first and
 * the it second; the mutation harness reruns this directory with each guard disabled.
 */
import { resolve as resolvePath } from "node:path"
import { Webhook } from "standardwebhooks"
import { describe, expect, it, vi } from "vitest"
import { guardNamed } from "../../structure/mutation-harness.ts"

const REPO = resolvePath(import.meta.dirname, "../../../../..")

const mutant = guardNamed(process.env.HONEY_MUTANT)
if (mutant !== undefined) {
	vi.doMock(resolvePath(REPO, mutant.module), async (importOriginal) => {
		const original = await importOriginal<Record<string, unknown>>()
		return { ...original, ...mutant.disable(original) }
	})
}

/* imported after the mock, so a mutant reaches every module that uses it */
const { signWebhook, webhookContract } = (await import(
	resolvePath(REPO, "packages/core/src/security/webhook.ts")
)) as typeof import("../../../src/security/webhook.ts")

const SECRET = btoa("k".repeat(32))

describe("v1 adversarial: a short secret never signs", () => {
	it("refuses a secret under 24 bytes", async () => {
		await expect(signWebhook({ body: "x", id: "a", secrets: btoa("short"), timestamp: 1 })).rejects.toThrow(TypeError)
	})
})

describe("v1 adversarial: a signature covers the delivery, not only its body", () => {
	it("changes with the id and with the timestamp", async () => {
		const sign = async (id: string, timestamp: number) =>
			(await signWebhook({ body: "x", id, secrets: SECRET, timestamp }))["webhook-signature"]
		const base = await sign("a", 1)
		expect([(await sign("b", 1)) === base, (await sign("a", 2)) === base]).toEqual([false, false])
	})
})

describe("v1 adversarial: a contract-signed delivery replayed under another id fails", () => {
	it("refuses the captured body and signature sent as a new delivery", async () => {
		const events = webhookContract({
			ping: { "~standard": { validate: (value) => ({ value }), vendor: "t", version: 1 } },
		})
		const secret = `whsec_${SECRET}`
		const { body, headers } = await events.sign("ping", {}, { id: "msg_1", occurredAt: new Date(), secrets: secret })
		const replayed = { ...headers, "webhook-id": "msg_2" }
		expect(new Webhook(secret).verify(body, headers)).toMatchObject({ type: "ping" })
		expect(() => new Webhook(secret).verify(body, replayed)).toThrow()
	})
})
