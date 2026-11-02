/**
 * A `QueueStore` in this process's memory, for development and tests. Nothing survives a restart and
 * nothing is shared between processes, so it is no production store.
 */
import type { QueueBatchEntry, QueueSendOptions } from "./define.ts"
import type { ClaimedMessage, QueueClaim, QueueStore } from "./serve.ts"

/** A message `memoryQueueStore` gave up on. */
export type MemoryDeadLetter = {
	/** How many times it was delivered. */
	attempts: number
	/** The message as it was sent. */
	body: unknown
	/** The message's id. */
	id: string
	/** Why it left. */
	reason: string
}

/** A `QueueStore` you can also read the dead letters of. */
export type MemoryQueueStore = QueueStore & {
	/** What left the queue unprocessed, oldest first. */
	deadLetters(): readonly MemoryDeadLetter[]
}

type Entry = {
	attempts: number
	readonly body: unknown
	readonly id: string
	lease: { readonly receipt: string; until: number } | undefined
	visibleAt: number
}

const SECOND_MS = 1_000

const entryOf = ({ body, delaySeconds = 0 }: QueueBatchEntry): Entry => ({
	attempts: 0,
	body: structuredClone(body),
	id: crypto.randomUUID(),
	lease: undefined,
	visibleAt: Date.now() + delaySeconds * SECOND_MS,
})

/**
 * A queue store in memory, delivering in send order. Development only.
 *
 * @example
 * const store = memoryQueueStore()
 * await jobs.send(store, "welcome", { userId })
 * serveQueue(consumer, { env, store })
 */
export function memoryQueueStore(): MemoryQueueStore {
	const entries: Entry[] = []
	const letters: MemoryDeadLetter[] = []

	/* a receipt holds only while its lease does, so a redelivered message cannot be settled twice */
	const leased = (receipt: string) =>
		entries.find(({ lease }) => lease?.receipt === receipt && lease.until > Date.now())

	const remove = (entry: Entry) => {
		entries.splice(entries.indexOf(entry), 1)
	}

	const claimable = (entry: Entry, now: number) =>
		entry.visibleAt <= now && (entry.lease === undefined || entry.lease.until <= now)

	return {
		ack: async (receipt) => {
			const entry = leased(receipt)
			if (entry !== undefined) remove(entry)
		},
		claim: async ({ leaseSeconds, limit }: QueueClaim): Promise<ClaimedMessage[]> => {
			const now = Date.now()
			return entries
				.filter((entry) => claimable(entry, now))
				.slice(0, limit)
				.map((entry) => {
					const receipt = crypto.randomUUID()
					entry.attempts += 1
					entry.lease = { receipt, until: now + leaseSeconds * SECOND_MS }
					return { attempts: entry.attempts, body: entry.body, id: entry.id, receipt }
				})
		},
		deadLetter: async (receipt, reason) => {
			const entry = leased(receipt)
			if (entry === undefined) return
			remove(entry)
			letters.push({ attempts: entry.attempts, body: entry.body, id: entry.id, reason })
		},
		deadLetters: () => letters,
		extend: async (receipt, seconds) => {
			const lease = leased(receipt)?.lease
			if (lease !== undefined) lease.until = Date.now() + seconds * SECOND_MS
		},
		retry: async (receipt, { delaySeconds = 0 }: QueueSendOptions) => {
			const entry = leased(receipt)
			if (entry === undefined) return
			entry.lease = undefined
			entry.visibleAt = Date.now() + delaySeconds * SECOND_MS
		},
		send: async (body, options) => {
			entries.push(entryOf({ body, ...options }))
		},
		sendBatch: async (messages) => {
			entries.push(...messages.map(entryOf))
		},
	}
}
