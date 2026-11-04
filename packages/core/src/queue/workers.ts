/**
 * A consumer behind a Workers Queue binding. The platform counts attempts and moves a message to its
 * dead-letter queue past `max_retries`. Workers does not hand that number to the consumer: name it as
 * `maxRetries` and the last failed delivery is reported before it moves, or name the dead-letter queue
 * in `deadLetterQueues` and this same consumer reports what lands there, consuming it. With no
 * dead-letter queue configured, Workers deletes a message past `max_retries`.
 */
import type { QueueConsumer } from "./define.ts"
import { BAD_BODY_DELAY_SECONDS, deliver, type Delivery, letterOf, reportLetter } from "./deliver.ts"

/** The part of a Workers `Message` a run reads. */
export type WorkersQueueMessage = {
	/** Finishes the message. */
	ack(): void
	/** How many times it has been delivered, from 1. */
	readonly attempts: number
	/** The message as it was sent. */
	readonly body: unknown
	/** The message's id. */
	readonly id: string
	/** Delivers the message again. */
	retry(options?: {
		/** Seconds to hold it back. */
		delaySeconds?: number
	}): void
}

/** The part of a Workers `MessageBatch` a run reads. */
export type WorkersQueueBatch = {
	/** The batch's messages. */
	readonly messages: readonly WorkersQueueMessage[]
	/** The queue it came from. */
	readonly queue: string
}

/** The part of a Workers `ExecutionContext` a run reads. */
export type WorkersQueueContext = {
	/** Keeps the Worker alive for `promise`. */
	waitUntil(promise: Promise<unknown>): void
}

/** Options for `workersQueue`. */
export type WorkersQueueOptions = {
	/** The queues this consumer reads as dead-letter queues: their messages are reported, never handled. */
	deadLetterQueues?: readonly string[]
	/**
	 * The consumer's `max_retries` from its Workers config. Workers does not hand it to the consumer, so name it here
	 * and keep it equal to the config: a test that reads both holds them equal. A failed delivery on the attempt past
	 * it, the last, is reported to `onDeadLetter` with `kept: true` and then retried, so the platform moves it to the
	 * consumer's `dead_letter_queue`, where it stays for a redrive. With none configured, Workers deletes it instead.
	 */
	maxRetries?: number
}

const reasonMoved = "moved to a dead-letter queue"

/** One batch's run: whose consumer, which queue, and the consumer's `max_retries` when named. */
type Run<Env> = {
	readonly consumer: QueueConsumer<Env>
	readonly env: Env
	readonly maxRetries: number | undefined
	readonly queue: string
}

const reportMoved = async <Env>(run: Run<Env>, message: WorkersQueueMessage) => {
	const { consumer, env } = run
	const letter = letterOf(deliveryOf(run, message), reasonMoved)
	/* a failed report keeps the letter for one more try: the platform bounds it by this consumer's own max_retries */
	if (await reportLetter(consumer, letter, env)) message.ack()
	else message.retry({ delaySeconds: BAD_BODY_DELAY_SECONDS })
}

const deliveryOf = <Env>({ consumer, env, maxRetries, queue }: Run<Env>, message: WorkersQueueMessage): Delivery => {
	const delivery: Delivery = {
		ack: () => message.ack(),
		attempts: message.attempts,
		body: message.body,
		deadLetter: async (reason) => {
			await reportLetter(consumer, letterOf(delivery, reason), env)
			message.ack()
		},
		id: message.id,
		queue,
		retry: async ({ delaySeconds, reason }) => {
			/* the last delivery: report it while it still exists, then the retry moves it to the dead-letter queue */
			if (maxRetries !== undefined && message.attempts > maxRetries) {
				await reportLetter(consumer, letterOf(delivery, reason, true), env)
			}
			if (delaySeconds === undefined) message.retry()
			else message.retry({ delaySeconds })
		},
	}
	return delivery
}

/**
 * The `queue` handler for `consumer`. Export it under that name from the app's entry and honey's
 * Workers build moves it onto the default export. The platform's `max_retries` bounds attempts, and
 * past it a message is deleted unless the consumer has a dead-letter queue. Throws `TypeError` for a
 * `maxRetries` that is not a whole number from 0.
 *
 * @example
 * export const queue = workersQueue(consumer, { maxRetries: 5 })
 */
export function workersQueue<Env>(
	consumer: QueueConsumer<Env>,
	options: WorkersQueueOptions = {},
): (batch: WorkersQueueBatch, env: Env, ctx: WorkersQueueContext) => Promise<void> {
	const { maxRetries } = options
	if (maxRetries !== undefined && !(Number.isInteger(maxRetries) && maxRetries >= 0)) {
		throw new TypeError(
			`workersQueue: maxRetries must be the consumer's max_retries, a whole number from 0; got ${maxRetries}`,
		)
	}
	return async ({ messages, queue }, env, ctx) => {
		const dead = options.deadLetterQueues?.includes(queue) === true
		const run: Run<Env> = { consumer, env, maxRetries, queue }
		const background = (promise: Promise<unknown>) => ctx.waitUntil(promise)
		await Promise.all(
			messages.map((message) =>
				dead ? reportMoved(run, message) : deliver(consumer, deliveryOf(run, message), env, background),
			),
		)
	}
}
