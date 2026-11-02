/**
 * A consumer behind a Workers Queue binding. The platform counts attempts and moves a message to its
 * dead-letter queue past `max_retries`, so honey never holds that number: name the dead-letter queue
 * in `deadLetterQueues` and this same consumer reports what lands there. With no dead-letter queue
 * configured, Workers deletes a message past `max_retries`.
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
}

const reasonMoved = "moved to a dead-letter queue"

const reportMoved = async <Env>(
	consumer: QueueConsumer<Env>,
	message: WorkersQueueMessage,
	queue: string,
	env: Env,
) => {
	const letter = letterOf(deliveryOf(consumer, message, queue, env), reasonMoved)
	/* a failed report keeps the letter for one more try: the platform bounds it by this consumer's own max_retries */
	if (await reportLetter(consumer, letter, env)) message.ack()
	else message.retry({ delaySeconds: BAD_BODY_DELAY_SECONDS })
}

const deliveryOf = <Env>(
	consumer: QueueConsumer<Env>,
	message: WorkersQueueMessage,
	queue: string,
	env: Env,
): Delivery => {
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
		retry: ({ delaySeconds }) => {
			if (delaySeconds === undefined) message.retry()
			else message.retry({ delaySeconds })
		},
	}
	return delivery
}

/**
 * The `queue` handler for `consumer`. Export it under that name from the app's entry and honey's
 * Workers build moves it onto the default export. The platform's `max_retries` bounds attempts, and
 * past it a message is deleted unless it moves to a dead-letter queue this consumer also reads.
 *
 * @example
 * export const queue = workersQueue(consumer, { deadLetterQueues: ["jobs-dead"] })
 */
export function workersQueue<Env>(
	consumer: QueueConsumer<Env>,
	options: WorkersQueueOptions = {},
): (batch: WorkersQueueBatch, env: Env, ctx: WorkersQueueContext) => Promise<void> {
	return async ({ messages, queue }, env, ctx) => {
		const dead = options.deadLetterQueues?.includes(queue) === true
		await Promise.all(
			messages.map((message) =>
				dead
					? reportMoved(consumer, message, queue, env)
					: deliver(consumer, deliveryOf(consumer, message, queue, env), env, (promise) => ctx.waitUntil(promise)),
			),
		)
	}
}
