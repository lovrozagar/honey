/**
 * A consumer in a long-running process, on one claim loop for Node and Bun. The loop claims as much
 * as `concurrency` has room for and keeps each running message's lease alive, so a crash loses
 * nothing: its leases expire and the messages redeliver. Delivery is at-least-once.
 *
 * Attempts are counted at claim. Past `maxAttempts` a message goes to `store.deadLetter` and
 * `onDeadLetter`, including one whose leases kept expiring because the process died on it.
 */
import type { QueueConsumer, QueueSendOptions, QueueTarget } from "./define.ts"
import { deliver, type Delivery, letterOf, reportLetter } from "./deliver.ts"
import { memoryQueueStore } from "./memory-store.ts"

export { memoryQueueStore }
export type { MemoryDeadLetter, MemoryQueueStore } from "./memory-store.ts"

/** What `claim` asks for. */
export type QueueClaim = {
	/** Seconds the lease holds. */
	leaseSeconds: number
	/** The most messages to hand out. */
	limit: number
}

/** A leased message. */
export type ClaimedMessage = {
	/** Deliveries so far, counting this one, from 1. */
	attempts: number
	/** The message as it was sent. */
	body: unknown
	/** The message's id. */
	id: string
	/** What proves this lease; a stale one must change nothing. */
	receipt: string
}

/**
 * Where messages wait, with leases. A claim hides a message for its lease and counts an attempt, and
 * an expired lease makes it claimable again, so delivery is at-least-once.
 */
export type QueueStore = QueueTarget & {
	/** Finishes a message. */
	ack(receipt: string): Promise<void>
	/** Leases what is deliverable now, in order. */
	claim(claim: QueueClaim): Promise<readonly ClaimedMessage[]>
	/** Keeps a message from redelivering, as an `onDeadLetter` could not. */
	deadLetter(receipt: string, reason: string): Promise<void>
	/** Holds a lease `seconds` from now. */
	extend(receipt: string, seconds: number): Promise<void>
	/** Makes a message deliverable again after its delay. */
	retry(receipt: string, options: QueueSendOptions): Promise<void>
}

/** Which store call failed. */
export type QueueFailure = {
	/** The message concerned, when there is one. */
	id?: string
	/** The call that failed. */
	operation: "ack" | "claim" | "deadLetter" | "extend" | "retry"
}

/** Options for `serveQueue`. */
export type ServeQueueOptions<Env> = {
	/** The most messages running at once; default 10. */
	concurrency?: number
	/** The environment every handler receives. */
	env: Env
	/** Seconds a lease holds, extended every half lease while its message runs; default 30. */
	leaseSeconds?: number
	/** The delivery after which a retry dead-letters; default 5. */
	maxAttempts?: number
	/** Receives a failed store call; default logs it. If it throws, the error is logged. */
	onError?(error: unknown, failure: QueueFailure): Promise<void> | void
	/** Milliseconds to wait after an empty or failed claim; default 1,000. */
	pollMs?: number
	/** The name a letter carries; default `"default"`. */
	queue?: string
	/** Where messages wait. */
	store: QueueStore
}

/** A running consumer. */
export type QueueHandle = {
	/**
	 * Stops claiming and waits for running messages and their background work. With no `timeoutMs` it
	 * waits as long as they take, so a handler closing its own consumer calls `void close()`. When
	 * `timeoutMs` passes first it resolves and stops extending, and those messages redeliver. A second
	 * call answers the first's promise.
	 */
	close(timeoutMs?: number): Promise<void>
}

type Running<Env> = {
	readonly active: Set<Promise<void>>
	readonly background: Set<Promise<unknown>>
	closing: Promise<void> | undefined
	readonly concurrency: number
	readonly consumer: QueueConsumer<Env>
	readonly leaseSeconds: number
	readonly leases: Set<() => void>
	loop: Promise<void>
	readonly maxAttempts: number
	readonly options: ServeQueueOptions<Env>
	readonly pollMs: number
	readonly queue: string
	wake: (() => void) | undefined
}

/* `setTimeout` fires at once past this */
const MAX_TIMER_MS = 2_147_483_647

const report = async <Env>({ consumer, options }: Running<Env>, error: unknown, failure: QueueFailure) => {
	try {
		if (options.onError === undefined) consumer.logger.error({ err: error, ...failure }, "queue: store call failed")
		else await options.onError(error, failure)
	} catch (reporting) {
		consumer.logger.error({ err: reporting, ...failure }, "queue: onError threw")
	}
}

/** Runs a store call, answering whether it landed. */
const guarded = async <Env>(state: Running<Env>, failure: QueueFailure, call: () => Promise<void>) => {
	try {
		await call()
		return true
	} catch (error) {
		await report(state, error, failure)
		return false
	}
}

/** Keeps a lease alive until the answer is called. */
const holdLease = <Env>(state: Running<Env>, { id, receipt }: ClaimedMessage) => {
	const { leaseSeconds, options } = state
	const every = Math.min(leaseSeconds * 500, MAX_TIMER_MS)
	const timer = setInterval(() => {
		void guarded(state, { id, operation: "extend" }, () => options.store.extend(receipt, leaseSeconds))
	}, every)
	const release = () => {
		clearInterval(timer)
		state.leases.delete(release)
	}
	state.leases.add(release)
	return release
}

const deliveryOf = <Env>(state: Running<Env>, claimed: ClaimedMessage, release: () => void): Delivery => {
	const { consumer, maxAttempts, options, queue } = state
	const { attempts, body, id, receipt } = claimed
	const { env, store } = options
	const delivery: Delivery = {
		ack: async () => {
			release()
			await guarded(state, { id, operation: "ack" }, () => store.ack(receipt))
		},
		attempts,
		body,
		deadLetter: async (reason) => {
			release()
			/* reported only once the store let go, so a letter it kept is reported once, on its redelivery */
			const left = await guarded(state, { id, operation: "deadLetter" }, () => store.deadLetter(receipt, reason))
			if (left) await reportLetter(consumer, letterOf(delivery, reason), env)
		},
		id,
		queue,
		retry: async ({ delaySeconds = 0, reason }) => {
			if (attempts >= maxAttempts) {
				await delivery.deadLetter(reason)
				return
			}
			release()
			await guarded(state, { id, operation: "retry" }, () => store.retry(receipt, { delaySeconds }))
		},
	}
	return delivery
}

const run = async <Env>(state: Running<Env>, claimed: ClaimedMessage) => {
	const release = holdLease(state, claimed)
	const delivery = deliveryOf(state, claimed, release)
	if (claimed.attempts > state.maxAttempts) {
		await delivery.deadLetter("lease lost past maxAttempts")
		return
	}
	const keep = (promise: Promise<unknown>) => {
		state.background.add(promise)
		void promise.finally(() => state.background.delete(promise))
	}
	await deliver(state.consumer, delivery, state.options.env, keep)
	release()
}

/** Waits until woken, or `ms` when given. */
const pause = <Env>(state: Running<Env>, ms?: number) =>
	new Promise<void>((resolve) => {
		const timer = ms === undefined ? undefined : setTimeout(() => state.wake?.(), ms)
		state.wake = () => {
			clearTimeout(timer)
			state.wake = undefined
			resolve()
		}
	})

const claimRoom = async <Env>(state: Running<Env>, limit: number) => {
	const { leaseSeconds, options } = state
	try {
		return await options.store.claim({ leaseSeconds, limit })
	} catch (error) {
		await report(state, error, { operation: "claim" })
		return []
	}
}

const loop = async <Env>(state: Running<Env>) => {
	while (state.closing === undefined) {
		const room = state.concurrency - state.active.size
		if (room === 0) {
			await Promise.race([pause(state), ...state.active])
			continue
		}
		const claimed = await claimRoom(state, room)
		for (const message of claimed) {
			const running = run(state, message).finally(() => {
				state.active.delete(running)
			})
			state.active.add(running)
		}
		if (claimed.length === 0 && state.closing === undefined) await pause(state, state.pollMs)
	}
}

const drain = async <Env>(state: Running<Env>) => {
	await state.loop
	await Promise.allSettled(state.active)
	await Promise.allSettled(state.background)
}

const stop = async <Env>(state: Running<Env>, timeoutMs: number | undefined) => {
	queueMicrotask(() => state.wake?.())
	const drained = drain(state)
	if (timeoutMs === undefined) {
		await drained
		return
	}
	let deadline: ReturnType<typeof setTimeout> | undefined
	const expired = new Promise<void>((resolve) => {
		deadline = setTimeout(resolve, Math.min(timeoutMs, MAX_TIMER_MS))
	})
	await Promise.race([drained, expired])
	clearTimeout(deadline)
	for (const release of state.leases) release()
}

/**
 * Runs `consumer` against `store` until `close`.
 *
 * @example
 * const running = serveQueue(consumer, { env, store })
 * process.once("SIGTERM", () => running.close(10_000))
 */
export function serveQueue<Env>(consumer: QueueConsumer<Env>, options: ServeQueueOptions<Env>): QueueHandle {
	const state: Running<Env> = {
		active: new Set(),
		background: new Set(),
		closing: undefined,
		concurrency: options.concurrency ?? 10,
		consumer,
		leaseSeconds: options.leaseSeconds ?? 30,
		leases: new Set(),
		loop: Promise.resolve(),
		maxAttempts: options.maxAttempts ?? 5,
		options,
		pollMs: options.pollMs ?? 1_000,
		queue: options.queue ?? "default",
		wake: undefined,
	}
	state.loop = loop(state)
	return {
		close: (timeoutMs) => {
			state.closing ??= stop(state, timeoutMs)
			return state.closing
		},
	}
}
