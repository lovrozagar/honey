import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { memoryQueueStore } from "./memory-store.ts"

const LEASE = { leaseSeconds: 30, limit: 10 }

beforeEach(() => {
	vi.useFakeTimers({ now: 0 })
})

afterEach(() => {
	vi.useRealTimers()
})

describe("memoryQueueStore: claiming", () => {
	it("delivers in send order, up to the limit, counting attempts from 1", async () => {
		const store = memoryQueueStore()
		await store.sendBatch([{ body: "a" }, { body: "b" }, { body: "c" }])
		const claimed = await store.claim({ leaseSeconds: 30, limit: 2 })
		expect(claimed.map(({ attempts, body }) => [body, attempts])).toEqual([
			["a", 1],
			["b", 1],
		])
	})

	it("holds a delayed message until its time", async () => {
		const store = memoryQueueStore()
		await store.send("later", { delaySeconds: 5 })
		expect(await store.claim(LEASE)).toEqual([])
		vi.advanceTimersByTime(5_000)
		expect((await store.claim(LEASE)).length).toBe(1)
	})

	it("holds a delayed batch message until its time", async () => {
		const store = memoryQueueStore()
		await store.sendBatch([{ body: "later", delaySeconds: 5 }])
		expect(await store.claim(LEASE)).toEqual([])
	})

	it("copies a body, so a sender's later edit reaches nobody", async () => {
		const store = memoryQueueStore()
		const body = { n: 1 }
		await store.send(body)
		body.n = 2
		expect((await store.claim(LEASE))[0]?.body).toEqual({ n: 1 })
	})

	it("refuses a body the wire could not carry", async () => {
		await expect(memoryQueueStore().send(() => {})).rejects.toThrow()
	})
})

describe("memoryQueueStore: leases", () => {
	it("hides a leased message, and hands an expired one out again with its attempts", async () => {
		const store = memoryQueueStore()
		await store.send("a")
		await store.claim(LEASE)
		expect(await store.claim(LEASE)).toEqual([])
		vi.advanceTimersByTime(30_000)
		expect((await store.claim(LEASE))[0]?.attempts).toBe(2)
	})

	it("extends a lease from now", async () => {
		const store = memoryQueueStore()
		await store.send("a")
		const [claimed] = await store.claim(LEASE)
		vi.advanceTimersByTime(20_000)
		await store.extend(claimed?.receipt as string, 30)
		vi.advanceTimersByTime(29_000)
		expect(await store.claim(LEASE)).toEqual([])
	})
})

describe("memoryQueueStore: settling", () => {
	it("forgets an acked message", async () => {
		const store = memoryQueueStore()
		await store.send("a")
		const [claimed] = await store.claim(LEASE)
		await store.ack(claimed?.receipt as string)
		vi.advanceTimersByTime(60_000)
		expect(await store.claim(LEASE)).toEqual([])
	})

	it("redelivers a retry after its delay", async () => {
		const store = memoryQueueStore()
		await store.send("a")
		const [claimed] = await store.claim(LEASE)
		await store.retry(claimed?.receipt as string, { delaySeconds: 5 })
		expect(await store.claim(LEASE)).toEqual([])
		vi.advanceTimersByTime(5_000)
		expect((await store.claim(LEASE))[0]?.attempts).toBe(2)
	})

	it("keeps a dead letter with its reason", async () => {
		const store = memoryQueueStore()
		await store.send("a")
		const [claimed] = await store.claim(LEASE)
		await store.deadLetter(claimed?.receipt as string, "why")
		expect([await store.claim(LEASE), store.deadLetters().map(({ body, reason }) => [body, reason])]).toEqual([
			[],
			[["a", "why"]],
		])
	})

	it("refuses a receipt whose lease ran out, though nobody has claimed since", async () => {
		const store = memoryQueueStore()
		await store.send("a")
		const [claimed] = await store.claim(LEASE)
		vi.advanceTimersByTime(30_000)
		await store.ack(claimed?.receipt as string)
		expect((await store.claim(LEASE)).length).toBe(1)
	})

	it("lets a stale receipt change nothing, once its lease is lost", async () => {
		const store = memoryQueueStore()
		await store.send("a")
		const [first] = await store.claim(LEASE)
		vi.advanceTimersByTime(30_000)
		const [second] = await store.claim(LEASE)
		const stale = first?.receipt as string
		await store.ack(stale)
		await store.retry(stale, { delaySeconds: 0 })
		await store.deadLetter(stale, "why")
		await store.extend(stale, 300)
		expect([second?.attempts, store.deadLetters().length]).toEqual([2, 0])
		await store.ack(second?.receipt as string)
		expect(await store.claim(LEASE)).toEqual([])
	})
})
