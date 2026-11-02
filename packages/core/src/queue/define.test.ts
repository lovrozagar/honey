import { describe, expect, it, vi } from "vitest"
import { SILENT } from "../telemetry/logger.ts"
import { deadLetter, defineConsumer, QueueDeadLetter, queueContract, queueMessage, type QueueTarget } from "./define.ts"

const target = () => {
	const sent: unknown[][] = []
	const queue: QueueTarget = {
		send: async (...args) => {
			sent.push(["send", ...args])
		},
		sendBatch: async (...args) => {
			sent.push(["sendBatch", ...args])
		},
	}
	return { queue, sent }
}

const contract = queueContract({ email: queueMessage<{ to: string }>(), ping: queueMessage<number>() })

describe("queueContract: sending", () => {
	it("writes the type and data as one body", async () => {
		const { queue, sent } = target()
		await contract.send(queue, "email", { to: "a" })
		expect(sent).toEqual([["send", { data: { to: "a" }, type: "email" }, undefined]])
	})

	it("passes a delay through", async () => {
		const { queue, sent } = target()
		await contract.send(queue, "ping", 1, { delaySeconds: 30 })
		expect(sent).toEqual([["send", { data: 1, type: "ping" }, { delaySeconds: 30 }]])
	})

	it("sends a batch with each message's delay", async () => {
		const { queue, sent } = target()
		await contract.sendBatch(queue, [
			{ data: 1, type: "ping" },
			{ data: { to: "a" }, delaySeconds: 5, type: "email" },
		])
		expect(sent).toEqual([
			[
				"sendBatch",
				[{ body: { data: 1, type: "ping" } }, { body: { data: { to: "a" }, type: "email" }, delaySeconds: 5 }],
			],
		])
	})

	it("sends nothing for an empty batch, which Workers refuses", async () => {
		const { queue, sent } = target()
		await contract.sendBatch(queue, [])
		expect(sent).toEqual([])
	})

	it("runs no schema: the consumer is what checks a body", async () => {
		const validate = vi.fn(() => ({ issues: [{ message: "no" }] }))
		const checked = queueContract({ job: { "~standard": { validate, vendor: "test", version: 1 } } })
		const { queue, sent } = target()
		await checked.send(queue, "job", "anything")
		expect([validate.mock.calls.length, sent.length]).toEqual([0, 1])
	})
})

describe("queueMessage", () => {
	it("passes any data through", async () => {
		expect(await queueMessage<string>()["~standard"].validate("x")).toEqual({ value: "x" })
	})
})

describe("deadLetter", () => {
	it("makes an error carrying its reason", () => {
		const signal = deadLetter("no such account")
		expect([signal instanceof QueueDeadLetter, signal.message]).toEqual([true, "no such account"])
	})
})

describe("defineConsumer", () => {
	it("refuses a type with no handler", () => {
		const consume = defineConsumer<{}>()
		const handlers = { email: async () => {} } as never
		expect(() => consume(contract, { handlers, logger: SILENT })).toThrow('"ping"')
	})

	it("logs through honey's logger when given none", () => {
		const handlers = { email: async () => {}, ping: async () => {} }
		expect(typeof defineConsumer<{}>()(contract, { handlers }).logger.child).toBe("function")
	})
})
