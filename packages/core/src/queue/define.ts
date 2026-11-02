/**
 * A typed queue, the same on every runtime: a contract senders import, and a consumer that
 * `./queue/workers` or `./queue/serve` runs. A sender needs only the contract, and any
 * `{ send, sendBatch }` is a target, so a Workers Queue binding and a `QueueStore` both qualify.
 *
 * A handler that returns acks its message, a throw retries it, and `throw deadLetter(reason)` gives
 * up on it. Delivery is at-least-once, so a handler must be safe to run twice.
 */
import { createLogger, type Logger } from "../telemetry/logger.ts"
import type { InferInput, InferOutput, StandardSchemaLike } from "../validation/standard-schema.ts"

/** When a sent message becomes deliverable. */
export type QueueSendOptions = {
	/** Seconds to hold the message back. */
	delaySeconds?: number
}

/** One message of a raw batch. */
export type QueueBatchEntry = QueueSendOptions & {
	/** The message as it goes on the wire. */
	body: unknown
}

/** Anything messages can be sent to: a Workers Queue binding, or a `QueueStore`. */
export type QueueTarget = {
	/** Sends one message. */
	send(body: unknown, options?: QueueSendOptions): Promise<unknown>
	/** Sends several messages. */
	sendBatch(messages: readonly QueueBatchEntry[]): Promise<unknown>
}

/** The message types of a contract, each with its schema. */
export type QueueSchemas = Readonly<Record<string, StandardSchemaLike>>

/** One message for `sendBatch`, with its type and data. */
export type QueueEntry<Schemas extends QueueSchemas> = {
	[Type in keyof Schemas]: QueueSendOptions & {
		/** The data, as the schema accepts it. */
		data: InferInput<Schemas[Type]>
		/** The message type. */
		type: Type
	}
}[keyof Schemas]

/** The types a queue carries and how to send them. */
export type QueueContract<Schemas extends QueueSchemas> = {
	/** The schema of each message type. */
	readonly messages: Schemas
	/** Sends one message to `target`. No schema runs here: the consumer checks every body. */
	send<Type extends keyof Schemas & string>(
		target: QueueTarget,
		type: Type,
		data: InferInput<Schemas[Type]>,
		options?: QueueSendOptions,
	): Promise<void>
	/** Sends several messages to `target`, and nothing for an empty list. Batches are not split. */
	sendBatch(target: QueueTarget, messages: readonly QueueEntry<Schemas>[]): Promise<void>
}

/** How a handler sees its message. */
export type QueueMessageHandle = {
	/** Finishes the message. The first `ack` or `retry` wins. */
	ack(): void
	/** How many times this message has been delivered, from 1. */
	readonly attempts: number
	/** The message's id. */
	readonly id: string
	/** Delivers the message again. The first `ack` or `retry` wins. */
	retry(options?: QueueSendOptions): void
}

/** What a handler receives for one message. */
export type QueueContext<Env, Data> = {
	/** Keeps the runtime alive for `promise` past the message's settling. A rejection is logged. */
	background(promise: Promise<unknown>): void
	/** The data, as the schema produced it. */
	data: Data
	/** The environment the runtime handed over. */
	env: Env
	/** The consumer's logger, bound to this message. */
	log: Logger
	/** The message itself. */
	message: QueueMessageHandle
	/** An id for this delivery, for matching its logs. */
	traceId: string
}

/** One message type's work. */
export type QueueHandler<Env, Data> = (context: QueueContext<Env, Data>) => Promise<void> | void

/** A message leaving the queue unprocessed. */
export type QueueLetter = {
	/** How many times it was delivered. */
	attempts: number
	/** The message as it was sent, even when its type is unknown. */
	body: unknown
	/** The message's id. */
	id: string
	/** The queue it left. */
	queue: string
	/** Why it left. */
	reason: string
	/** Its type, or `"unknown"` for a body with none. */
	type: string
}

/** What `defineConsumer` takes for a contract. */
export type QueueConsumerConfig<Env, Schemas extends QueueSchemas> = {
	/** One handler per message type. */
	handlers: { [Type in keyof Schemas]: QueueHandler<Env, InferOutput<Schemas[Type]>> }
	/** Where the consumer logs; default honey's logger. */
	logger?: Logger
	/** Reports a letter. A runtime's own dead letters reach it too. */
	onDeadLetter?(letter: QueueLetter, env: Env): Promise<void>
	/**
	 * Seconds to hold a retry back, given what failed: a handler's error, or a `QueueBodyError` for a
	 * body past its contract. By default a handler's error retries at once and a bad body after 60 s.
	 */
	retryDelay?(error: unknown): number | undefined
}

/** A consumer, ready for `workersQueue` or `serveQueue`. */
export type QueueConsumer<Env> = {
	/** Each message type's handler. */
	readonly handlers: Readonly<Record<string, QueueHandler<Env, never>>>
	/** Where the consumer logs. */
	readonly logger: Logger
	/** Reports a letter. */
	readonly onDeadLetter: QueueConsumerConfig<Env, QueueSchemas>["onDeadLetter"]
	/** Seconds to hold a retry back. */
	readonly retryDelay: QueueConsumerConfig<Env, QueueSchemas>["retryDelay"]
	/** Each message type's schema. */
	readonly schemas: QueueSchemas
}

/** What `throw deadLetter(reason)` throws: the handler has given up on its message. */
export class QueueDeadLetter extends Error {}

/** Why a body never reached a handler; `retryDelay` receives it. */
export class QueueBodyError extends Error {}

/**
 * Declares a message's type with no schema, for a queue only your own code sends to. Its data is
 * not checked.
 *
 * @example
 * queueContract({ welcome: queueMessage<{ userId: string }>() })
 */
export function queueMessage<Data>(): StandardSchemaLike & {
	/** The schema's properties, carrying `Data` for inference. */
	readonly "~standard": {
		/** `Data` on both sides. */
		readonly types?: {
			/** What `send` takes. */
			readonly input: Data
			/** What a handler receives. */
			readonly output: Data
		}
	}
} {
	return { "~standard": { validate: (value) => ({ value }), vendor: "honey", version: 1 } }
}

/**
 * Declares what a queue carries, by message type.
 *
 * @example
 * const jobs = queueContract({ welcome: queueMessage<{ userId: string }>() })
 * await jobs.send(env.JOBS, "welcome", { userId })
 */
export function queueContract<Schemas extends QueueSchemas>(messages: Schemas): QueueContract<Schemas> {
	return {
		messages,
		send: async (target, type, data, options) => {
			await target.send({ data, type }, options)
		},
		sendBatch: async (target, entries) => {
			if (entries.length === 0) return
			await target.sendBatch(
				entries.map(({ data, delaySeconds, type }) => ({
					body: { data, type },
					...(delaySeconds === undefined ? {} : { delaySeconds }),
				})),
			)
		},
	}
}

/**
 * Gives up on a message: `throw deadLetter(reason)` from a handler sends it to `onDeadLetter` with
 * no more attempts.
 *
 * @example
 * if (account === null) throw deadLetter("no such account")
 */
export function deadLetter(reason: string): QueueDeadLetter {
	return new QueueDeadLetter(reason)
}

/**
 * Binds handlers to a contract. It is called twice so `Env` can be written while the contract's
 * types are inferred.
 *
 * @example
 * export const consumer = defineConsumer<Env>()(jobs, {
 *   handlers: { welcome: async ({ data, env }) => sendWelcome(env, data.userId) },
 * })
 */
export function defineConsumer<Env>(): <Schemas extends QueueSchemas>(
	contract: QueueContract<Schemas>,
	config: QueueConsumerConfig<Env, Schemas>,
) => QueueConsumer<Env> {
	return (contract, config) => {
		for (const type of Object.keys(contract.messages)) {
			if (typeof config.handlers[type] !== "function") throw new Error(`queue: "${type}" has no handler`)
		}
		return {
			handlers: config.handlers as unknown as QueueConsumer<Env>["handlers"],
			logger: config.logger ?? createLogger(),
			onDeadLetter: config.onDeadLetter,
			retryDelay: config.retryDelay,
			schemas: contract.messages,
		}
	}
}
