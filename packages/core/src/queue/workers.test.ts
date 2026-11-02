import { describe, expect, it, vi } from "vitest"
import { SILENT } from "../telemetry/logger.ts"
import { deadLetter, defineConsumer, type QueueContext, queueContract, queueMessage } from "./define.ts"
import { workersQueue } from "./workers.ts"

const contract = queueContract({ job: queueMessage<number>() })

const message = (body: unknown, id = "m1") => {
	const calls: unknown[][] = []
	return {
		ack: () => void calls.push(["ack"]),
		attempts: 1,
		body,
		calls,
		id,
		retry: (...args: unknown[]) => void calls.push(["retry", ...args]),
	}
}

const JOB = { data: 1, type: "job" }

const ctx = () => {
	const waited: Promise<unknown>[] = []
	return { waited, waitUntil: (promise: Promise<unknown>) => void waited.push(promise) }
}

type Job = (context: QueueContext<{}, number>) => Promise<void> | void

const consumerOf = (job: Job, onDeadLetter?: (letter: never, env: {}) => Promise<void>) =>
	defineConsumer<{}>()(contract, {
		handlers: { job },
		logger: SILENT,
		...(onDeadLetter === undefined ? {} : { onDeadLetter: onDeadLetter as never }),
	})

describe("workersQueue: a batch", () => {
	it("acks what ran", async () => {
		const m = message(JOB)
		await workersQueue(consumerOf(async () => {}))({ messages: [m], queue: "jobs" }, {}, ctx())
		expect(m.calls).toEqual([["ack"]])
	})

	it("retries a failure with its delay, leaving the rest of the batch alone", async () => {
		const bad = message({ data: 2, type: "job" }, "bad")
		const good = message(JOB, "good")
		const consumer = defineConsumer<{}>()(contract, {
			handlers: {
				job: ({ data }) => {
					if (data === 2) throw new Error("no")
				},
			},
			logger: SILENT,
			retryDelay: () => 7,
		})
		await workersQueue(consumer)({ messages: [bad, good], queue: "jobs" }, {}, ctx())
		expect([bad.calls, good.calls]).toEqual([[["retry", { delaySeconds: 7 }]], [["ack"]]])
	})

	it("calls retry with nothing when there is no delay, leaving it to the platform", async () => {
		const m = message(JOB)
		const job = async () => {
			throw new Error("no")
		}
		await workersQueue(consumerOf(job))({ messages: [m], queue: "jobs" }, {}, ctx())
		expect(m.calls).toEqual([["retry"]])
	})
})

describe("workersQueue: running", () => {
	it("runs a batch's messages at once", async () => {
		let release = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let started = 0
		const job = async () => {
			started++
			if (started === 2) release()
			await gate
		}
		const batch = { messages: [message(JOB, "a"), message(JOB, "b")], queue: "jobs" }
		await workersQueue(consumerOf(job))(batch, {}, ctx())
		expect(started).toBe(2)
	})

	it("reports throw deadLetter, then acks", async () => {
		const order: string[] = []
		const m = message(JOB)
		m.ack = () => void order.push("ack")
		const job = async () => {
			throw deadLetter("no account")
		}
		const report = async () => void order.push("report")
		await workersQueue(consumerOf(job, report))({ messages: [m], queue: "jobs" }, {}, ctx())
		expect(order).toEqual(["report", "ack"])
	})

	it("acks a dead letter whose report failed: the handler already gave up on it", async () => {
		const m = message(JOB)
		const job = async () => {
			throw deadLetter("no account")
		}
		const report = async () => {
			throw new Error("reporter down")
		}
		await workersQueue(consumerOf(job, report))({ messages: [m], queue: "jobs" }, {}, ctx())
		expect(m.calls).toEqual([["ack"]])
	})

	it("hands background work to waitUntil", async () => {
		const context = ctx()
		const job: Job = ({ background }) => background(Promise.resolve())
		await workersQueue(consumerOf(job))({ messages: [message(JOB)], queue: "jobs" }, {}, context)
		expect(context.waited.length).toBe(1)
	})
})

describe("workersQueue: a dead-letter queue", () => {
	const never = vi.fn(async () => {})
	const options = { deadLetterQueues: ["jobs-dlq"] }

	it("reports the body and acks, never running a handler", async () => {
		const letters: unknown[] = []
		const m = message({ data: 9, type: "gone" })
		const report = async (letter: unknown) => void letters.push(letter)
		await workersQueue(consumerOf(never, report), options)({ messages: [m], queue: "jobs-dlq" }, {}, ctx())
		expect([letters, m.calls, never.mock.calls.length]).toEqual([
			[
				{
					attempts: 1,
					body: { data: 9, type: "gone" },
					id: "m1",
					queue: "jobs-dlq",
					reason: "moved to a dead-letter queue",
					type: "gone",
				},
			],
			[["ack"]],
			0,
		])
	})

	it("retries a letter whose report failed, after a minute", async () => {
		const m = message(JOB)
		const report = async () => {
			throw new Error("reporter down")
		}
		await workersQueue(consumerOf(never, report), options)({ messages: [m], queue: "jobs-dlq" }, {}, ctx())
		expect(m.calls).toEqual([["retry", { delaySeconds: 60 }]])
	})

	it("logs and acks with no reporter", async () => {
		const m = message(JOB)
		await workersQueue(consumerOf(never), options)({ messages: [m], queue: "jobs-dlq" }, {}, ctx())
		expect(m.calls).toEqual([["ack"]])
	})

	it("runs handlers for a queue it was not told about", async () => {
		const job = vi.fn(async () => {})
		await workersQueue(consumerOf(job), options)({ messages: [message(JOB)], queue: "jobs" }, {}, ctx())
		expect(job).toHaveBeenCalledOnce()
	})
})
