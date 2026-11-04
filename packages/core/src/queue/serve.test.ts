import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SILENT } from "../telemetry/logger.ts"
import { deadLetter, defineConsumer, type QueueContext, queueContract, queueMessage } from "./define.ts"
import { memoryQueueStore } from "./memory-store.ts"
import { type QueueHandle, type QueueStore, serveQueue } from "./serve.ts"

const contract = queueContract({ job: queueMessage<number>() })

type Job = (context: QueueContext<{}, number>) => Promise<void> | void
type Extra = { onDeadLetter?: (letter: never, env: {}) => Promise<void> }

const consumerOf = (job: Job, extra: Extra = {}) =>
	defineConsumer<{}>()(contract, { handlers: { job }, logger: SILENT, ...extra } as never)

const SEND = (store: QueueStore, n = 1) => contract.send(store, "job", n)

const handles: QueueHandle[] = []
const served = (...args: Parameters<typeof serveQueue<{}>>) => {
	const handle = serveQueue(...args)
	handles.push(handle)
	return handle
}

const held = () => {
	let release = () => {}
	const done = new Promise<void>((resolve) => {
		release = resolve
	})
	return { done, release: () => release() }
}

const reporting = () => {
	const letters: { reason: string; attempts: number; kept: boolean; queue: string; body: unknown }[] = []
	return { letters, onDeadLetter: async (letter: never) => void letters.push(letter) }
}

const tick = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
	vi.useFakeTimers({ now: 0 })
})

afterEach(async () => {
	await Promise.all(handles.splice(0).map((handle) => handle.close(0).catch(() => {})))
	vi.advanceTimersByTime(0)
	vi.useRealTimers()
})

describe("serveQueue: running", () => {
	it("runs a sent message and acks it", async () => {
		const store = memoryQueueStore()
		await SEND(store)
		const job = vi.fn(async () => {})
		served(consumerOf(job), { env: {}, store })
		await tick()
		expect(job).toHaveBeenCalledOnce()
		vi.advanceTimersByTime(60_000)
		expect(await store.claim({ leaseSeconds: 1, limit: 1 })).toEqual([])
	})

	it("waits pollMs on an empty claim, then finds what arrived", async () => {
		const store = memoryQueueStore()
		const job = vi.fn(async () => {})
		served(consumerOf(job), { env: {}, pollMs: 500, store })
		await tick()
		await SEND(store)
		await vi.advanceTimersByTimeAsync(499)
		expect(job).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(job).toHaveBeenCalledOnce()
	})

	it("never runs more than concurrency at once, and starts the next as one ends", async () => {
		const store = memoryQueueStore()
		for (const n of [1, 2, 3]) await SEND(store, n)
		const gates = [held(), held(), held()]
		const started: number[] = []
		const job: Job = ({ data }) => {
			started.push(data)
			return gates[data - 1]?.done
		}
		served(consumerOf(job), { concurrency: 2, env: {}, store })
		await tick()
		expect(started).toEqual([1, 2])
		gates[0]?.release()
		await tick()
		expect(started).toEqual([1, 2, 3])
		for (const gate of gates) gate.release()
	})

	it("carries the attempt count from the claim", async () => {
		const store = memoryQueueStore()
		await SEND(store)
		const attempts: number[] = []
		const job: Job = ({ message }) => {
			attempts.push(message.attempts)
			if (message.attempts === 1) throw new Error("again")
		}
		served(consumerOf(job), { env: {}, pollMs: 10, store })
		await vi.advanceTimersByTimeAsync(100)
		expect(attempts).toEqual([1, 2])
	})
})

describe("serveQueue: dead letters", () => {
	it("dead-letters a retry at maxAttempts, with the retry's reason", async () => {
		const store = memoryQueueStore()
		await SEND(store)
		const { letters, onDeadLetter } = reporting()
		const job = async () => {
			throw new Error("down")
		}
		served(consumerOf(job, { onDeadLetter }), { env: {}, maxAttempts: 3, pollMs: 10, queue: "jobs", store })
		await vi.advanceTimersByTimeAsync(100)
		/* not kept: the store's deadLetter takes it off the queue */
		expect(letters.map(({ attempts, kept, queue, reason }) => [reason, attempts, queue, kept])).toEqual([
			["down", 3, "jobs", false],
		])
		expect(store.deadLetters().map(({ reason }) => reason)).toEqual(["down"])
	})

	it("treats a handler's own retry at maxAttempts the same way", async () => {
		const store = memoryQueueStore()
		await SEND(store)
		const job: Job = ({ message }) => message.retry()
		served(consumerOf(job), { env: {}, maxAttempts: 1, store })
		await tick()
		expect(store.deadLetters().map(({ reason }) => reason)).toEqual(["retried by the handler"])
	})

	it("dead-letters a claim past maxAttempts without running it", async () => {
		const store = memoryQueueStore()
		await SEND(store)
		await store.claim({ leaseSeconds: 0, limit: 1 })
		await store.claim({ leaseSeconds: 0, limit: 1 })
		const { letters, onDeadLetter } = reporting()
		const job = vi.fn(async () => {})
		served(consumerOf(job, { onDeadLetter }), { env: {}, maxAttempts: 2, store })
		await tick()
		expect([job.mock.calls.length, letters.map(({ reason }) => reason)]).toEqual([0, ["lease lost past maxAttempts"]])
	})
})

describe("serveQueue: dead letters and the store", () => {
	it("honours throw deadLetter on the first attempt, once", async () => {
		const store = memoryQueueStore()
		await SEND(store)
		const { letters, onDeadLetter } = reporting()
		const job = async () => {
			throw deadLetter("no account")
		}
		served(consumerOf(job, { onDeadLetter }), { env: {}, store })
		await vi.advanceTimersByTimeAsync(5_000)
		expect(letters.map(({ reason }) => reason)).toEqual(["no account"])
	})

	it("leaves an unreported letter leased when the store refused it", async () => {
		const store = memoryQueueStore()
		await SEND(store)
		const { letters, onDeadLetter } = reporting()
		const seen: string[] = []
		const failing = {
			...store,
			deadLetter: async () => {
				throw new Error("store down")
			},
		}
		const job = async () => {
			throw deadLetter("no account")
		}
		served(consumerOf(job, { onDeadLetter }), {
			env: {},
			onError: (_error, { operation }) => void seen.push(operation),
			store: failing,
		})
		await tick()
		expect([letters, seen]).toEqual([[], ["deadLetter"]])
	})
})

describe("serveQueue: leases", () => {
	it("extends a running message every half lease, until it settles", async () => {
		const store = memoryQueueStore()
		await SEND(store)
		const gate = held()
		const extend = vi.fn(store.extend)
		served(
			consumerOf(() => gate.done),
			{ env: {}, leaseSeconds: 10, store: { ...store, extend } },
		)
		await vi.advanceTimersByTimeAsync(15_000)
		expect(extend.mock.calls.map(([, seconds]) => seconds)).toEqual([10, 10, 10])
		gate.release()
		await vi.advanceTimersByTimeAsync(20_000)
		expect(extend).toHaveBeenCalledTimes(3)
	})

	it("stops extending at the first settle, though the handler runs on", async () => {
		const store = memoryQueueStore()
		await SEND(store)
		const gate = held()
		const extend = vi.fn(store.extend)
		const job: Job = async ({ message }) => {
			message.ack()
			await gate.done
		}
		served(consumerOf(job), { env: {}, leaseSeconds: 10, store: { ...store, extend } })
		await vi.advanceTimersByTimeAsync(20_000)
		expect(extend).not.toHaveBeenCalled()
		gate.release()
	})

	it("keeps a handler running when extend fails", async () => {
		const store = memoryQueueStore()
		await SEND(store)
		const gate = held()
		const seen: string[] = []
		const extend = async () => {
			throw new Error("store down")
		}
		served(
			consumerOf(() => gate.done),
			{
				env: {},
				leaseSeconds: 10,
				onError: (_error, { operation }) => void seen.push(operation),
				store: { ...store, extend },
			},
		)
		await vi.advanceTimersByTimeAsync(5_000)
		expect(seen).toEqual(["extend"])
		gate.release()
	})
})

describe("serveQueue: a failing store", () => {
	const operations = async (broken: Partial<QueueStore>, job: Job = async () => {}) => {
		const store = memoryQueueStore()
		await SEND(store)
		const seen: string[] = []
		served(consumerOf(job), {
			env: {},
			onError: (_error, { operation }) => void seen.push(operation),
			pollMs: 100,
			store: { ...store, ...broken },
		})
		await tick()
		return seen
	}
	const down = async () => {
		throw new Error("store down")
	}

	it("reports a failed ack and leaves the message to its lease", async () => {
		expect(await operations({ ack: down })).toEqual(["ack"])
	})

	it("reports a failed retry", async () => {
		const job = async () => {
			throw new Error("no")
		}
		expect(await operations({ retry: down }, job)).toEqual(["retry"])
	})

	it("reports a failed claim, waits pollMs, and claims again", async () => {
		const claim = vi.fn(down)
		const seen = await operations({ claim })
		await vi.advanceTimersByTimeAsync(100)
		expect([seen, claim.mock.calls.length]).toEqual([["claim", "claim"], 2])
	})

	it("logs a failure when onError is missing or throws", async () => {
		const store = memoryQueueStore()
		const error = vi.fn()
		const logger = { ...SILENT, error }
		const broken = { ...store, claim: down }
		const onError = () => {
			throw new Error("reporter down")
		}
		served(
			consumerOf(async () => {}, { logger } as never),
			{ env: {}, pollMs: 100, store: broken },
		)
		served(
			consumerOf(async () => {}, { logger } as never),
			{ env: {}, onError, pollMs: 100, store: broken },
		)
		await tick()
		expect(error).toHaveBeenCalledTimes(2)
	})
})

describe("serveQueue: close", () => {
	it("wakes a poll wait and stops claiming", async () => {
		const store = memoryQueueStore()
		const claim = vi.fn(store.claim)
		const handle = served(
			consumerOf(async () => {}),
			{ env: {}, pollMs: 60_000, store: { ...store, claim } },
		)
		await tick()
		await handle.close()
		await vi.advanceTimersByTimeAsync(120_000)
		expect(claim).toHaveBeenCalledOnce()
	})

	it("wakes a full consumer waiting for room", async () => {
		const store = memoryQueueStore()
		await SEND(store)
		const gate = held()
		const handle = served(
			consumerOf(() => gate.done),
			{ concurrency: 1, env: {}, store },
		)
		await tick()
		let closed = false
		const closing = handle.close().then(() => {
			closed = true
		})
		gate.release()
		await closing
		expect(closed).toBe(true)
	})
})

describe("serveQueue: close and running work", () => {
	it("waits without limit for running work and its background promises", async () => {
		const store = memoryQueueStore()
		await SEND(store)
		const gate = held()
		const job: Job = ({ background }) => background(gate.done)
		const handle = served(consumerOf(job), { env: {}, store })
		await tick()
		let closed = false
		const closing = handle.close().then(() => {
			closed = true
		})
		await vi.advanceTimersByTimeAsync(3_600_000)
		expect(closed).toBe(false)
		gate.release()
		await closing
	})

	it("stops waiting and extending at the timeout, leaving the lease to expire", async () => {
		const store = memoryQueueStore()
		await SEND(store)
		const gate = held()
		const extend = vi.fn(store.extend)
		const handle = served(
			consumerOf(() => gate.done),
			{ env: {}, leaseSeconds: 10, store: { ...store, extend } },
		)
		await tick()
		const closing = handle.close(1_000)
		await vi.advanceTimersByTimeAsync(1_000)
		await closing
		await vi.advanceTimersByTimeAsync(30_000)
		expect([extend.mock.calls.length, vi.getTimerCount()]).toEqual([0, 0])
		expect((await store.claim({ leaseSeconds: 1, limit: 1 })).length).toBe(1)
		gate.release()
	})

	it("treats a timeout past the timer's range as a long wait", async () => {
		const store = memoryQueueStore()
		await SEND(store)
		const gate = held()
		const handle = served(
			consumerOf(() => gate.done),
			{ env: {}, store },
		)
		await tick()
		let closed = false
		const closing = handle.close(2 ** 40).then(() => {
			closed = true
		})
		await vi.advanceTimersByTimeAsync(60_000)
		expect(closed).toBe(false)
		gate.release()
		await closing
	})
})

describe("serveQueue: close at the edges", () => {
	it("answers the same close twice", async () => {
		const handle = served(
			consumerOf(async () => {}),
			{ env: {}, store: memoryQueueStore() },
		)
		const first = handle.close()
		expect(handle.close()).toBe(first)
		await first
	})

	it("stays closed when a handler closes it", async () => {
		const store = memoryQueueStore()
		await SEND(store)
		const job: Job = () => void handle.close()
		const handle = served(consumerOf(job), { env: {}, store })
		await vi.advanceTimersByTimeAsync(5_000)
		expect(vi.getTimerCount()).toBe(0)
	})
})
