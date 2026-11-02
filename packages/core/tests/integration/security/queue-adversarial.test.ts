/**
 * The adversarial suite's queue cases: a sender ahead of its consumer, a handler settling twice, and
 * a message that always fails. Each is a failing input first and the property that answers it
 * second; the mutation harness reruns this directory with each guard disabled.
 */
import { resolve as resolvePath } from "node:path"
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
const { workersQueue } = (await import(
	resolvePath(REPO, "packages/core/src/queue/workers.ts")
)) as typeof import("../../../src/queue/workers.ts")

const { memoryQueueStore, serveQueue } = (await import(
	resolvePath(REPO, "packages/core/src/queue/serve.ts")
)) as typeof import("../../../src/queue/serve.ts")

const { defineConsumer, queueContract, queueMessage } = (await import(
	resolvePath(REPO, "packages/core/src/queue/define.ts")
)) as typeof import("../../../src/queue/define.ts")

const { SILENT } = (await import(
	resolvePath(REPO, "packages/core/src/telemetry/logger.ts")
)) as typeof import("../../../src/telemetry/logger.ts")

const jobs = queueContract({ job: queueMessage<number>() })

const message = (body: unknown) => {
	const calls: string[] = []
	return {
		ack: () => void calls.push("ack"),
		attempts: 1,
		body,
		calls,
		id: "m1",
		retry: () => void calls.push("retry"),
	}
}

const CTX = { waitUntil: () => {} }

describe("v1 adversarial: a sender ahead of its consumer", () => {
	it("never acks a type the consumer does not know, so the body survives", async () => {
		const consumer = defineConsumer<{}>()(jobs, { handlers: { job: () => {} }, logger: SILENT })
		const m = message({ data: 1, type: "added-next-deploy" })
		await workersQueue(consumer)({ messages: [m], queue: "q" }, {}, CTX)
		expect(m.calls).toEqual(["retry"])
	})
})

describe("v1 adversarial: a handler settling twice", () => {
	it("lets only the first settle reach the platform", async () => {
		const consumer = defineConsumer<{}>()(jobs, {
			handlers: {
				job: ({ message: own }) => {
					own.ack()
					own.retry()
				},
			},
			logger: SILENT,
		})
		const m = message({ data: 1, type: "job" })
		await workersQueue(consumer)({ messages: [m], queue: "q" }, {}, CTX)
		expect(m.calls).toEqual(["ack"])
	})
})

describe("v1 adversarial: a message that always fails", () => {
	it("stops at maxAttempts instead of running forever", async () => {
		vi.useFakeTimers({ now: 0 })
		const store = memoryQueueStore()
		await jobs.send(store, "job", 1)
		const job = vi.fn(async () => {
			throw new Error("down")
		})
		const consumer = defineConsumer<{}>()(jobs, { handlers: { job }, logger: SILENT })
		const running = serveQueue(consumer, { env: {}, maxAttempts: 2, pollMs: 10, store })
		await vi.advanceTimersByTimeAsync(1_000)
		await running.close(0)
		vi.useRealTimers()
		expect([job.mock.calls.length, store.deadLetters().length]).toEqual([2, 1])
	})
})
