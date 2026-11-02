/**
 * One message's run, the rules `./queue/workers` and `./queue/serve` share: what a body must be to
 * reach a handler, who settles a message, how long a retry waits, and what a letter holds. Each
 * runtime supplies a `Delivery` saying what settling means there.
 */
import type { Logger } from "../telemetry/logger.ts"
import {
	QueueBodyError,
	type QueueConsumer,
	QueueDeadLetter,
	type QueueLetter,
	type QueueMessageHandle,
	type QueueSendOptions,
} from "./define.ts"

/** A retry, with why. */
export type DeliveryRetry = QueueSendOptions & {
	/** Why it retries, which becomes a letter's reason if it was the last attempt. */
	reason: string
}

/** One message as a runtime delivered it. */
export type Delivery = {
	/** Finishes the message. */
	ack(): Promise<void> | void
	/** How many times it has been delivered, from 1. */
	readonly attempts: number
	/** The body as it came off the wire. */
	readonly body: unknown
	/** Gives up on the message. */
	deadLetter(reason: string): Promise<void> | void
	/** The message's id. */
	readonly id: string
	/** The queue it came from. */
	readonly queue: string
	/** Delivers it again. */
	retry(options: DeliveryRetry): Promise<void> | void
}

/** Seconds a body past its contract waits by default: it fails the same way until something deploys. */
export const BAD_BODY_DELAY_SECONDS = 60

/* the longest delay Workers takes */
const MAX_DELAY_SECONDS = 43_200

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const envelopeType = (body: unknown): string | undefined => {
	const type = typeof body === "object" && body !== null ? (body as { type?: unknown }).type : undefined
	return typeof type === "string" ? type : undefined
}

const delayOption = (seconds: number | undefined): QueueSendOptions => {
	const valid = seconds !== undefined && Number.isFinite(seconds) && seconds > 0
	return valid ? { delaySeconds: Math.min(Math.ceil(seconds), MAX_DELAY_SECONDS) } : {}
}

const delayFor = <Env>(
	consumer: QueueConsumer<Env>,
	error: unknown,
	fallback: number | undefined,
	log: Logger,
): QueueSendOptions => {
	try {
		if (consumer.retryDelay === undefined) return delayOption(fallback)
		const answer = consumer.retryDelay(error)
		return delayOption(answer ?? fallback)
	} catch (thrown) {
		log.error({ err: thrown }, "queue: retryDelay threw")
		return delayOption(fallback)
	}
}

/** The data a handler receives, or a `QueueBodyError` saying why none can. */
const dataOf = async <Env>(consumer: QueueConsumer<Env>, body: unknown): Promise<unknown> => {
	const type = envelopeType(body)
	if (type === undefined) throw new QueueBodyError("invalid body: no type")
	if (!Object.hasOwn(consumer.schemas, type)) throw new QueueBodyError(`unknown type ${type}`)
	const schema = consumer.schemas[type] as (typeof consumer.schemas)[string]
	try {
		const { data } = body as { data: unknown }
		const result = await schema["~standard"].validate(data)
		if (result.issues === undefined) return result.value
		throw new QueueBodyError(`invalid body: ${result.issues[0]?.message}`)
	} catch (error) {
		throw error instanceof QueueBodyError ? error : new QueueBodyError(`invalid body: ${reasonOf(error)}`)
	}
}

/** The letter for `delivery`, which keeps the body even when it has no readable type. */
export function letterOf(delivery: Delivery, reason: string): QueueLetter {
	const { attempts, body, id, queue } = delivery
	return { attempts, body, id, queue, reason, type: envelopeType(body) ?? "unknown" }
}

/** Logs a letter and reports it. Answers whether the report landed; one that throws is logged, never rethrown. */
export async function reportLetter<Env>(consumer: QueueConsumer<Env>, letter: QueueLetter, env: Env): Promise<boolean> {
	const { body: _body, ...summary } = letter
	consumer.logger.error({ deadLetter: summary }, "queue: message dead-lettered")
	try {
		await consumer.onDeadLetter?.(letter, env)
		return true
	} catch (error) {
		consumer.logger.error({ deadLetter: letter, err: error }, "queue: dead-letter report failed")
		return false
	}
}

/**
 * Runs one message to its settling. It never rejects: every failure settles the message or is
 * logged. `background` receives a promise that cannot reject.
 */
export async function deliver<Env>(
	consumer: QueueConsumer<Env>,
	delivery: Delivery,
	env: Env,
	background: (promise: Promise<unknown>) => void,
): Promise<void> {
	const traceId = crypto.randomUUID()
	const log = consumer.logger.child({
		messageId: delivery.id,
		traceId,
		type: envelopeType(delivery.body) ?? "unknown",
	})
	let settling: Promise<unknown> | undefined
	const settle = (action: () => Promise<void> | void) => {
		if (settling !== undefined) return false
		settling = (async () => action())().catch((error: unknown) => log.error({ err: error }, "queue: settling failed"))
		return true
	}
	const message: QueueMessageHandle = {
		ack: () => void settle(() => delivery.ack()),
		attempts: delivery.attempts,
		id: delivery.id,
		retry: (options) =>
			void settle(() => delivery.retry({ ...delayOption(options?.delaySeconds), reason: "retried by the handler" })),
	}
	try {
		const data = (await dataOf(consumer, delivery.body)) as never
		const handler = consumer.handlers[envelopeType(delivery.body) as string]
		const keep = (promise: Promise<unknown>) =>
			background(promise.catch((error: unknown) => log.error({ err: error }, "queue: background work failed")))
		await handler?.({ background: keep, data, env, log, message, traceId })
		settle(() => delivery.ack())
	} catch (error) {
		const reason = reasonOf(error)
		const bad = error instanceof QueueBodyError
		if (settling !== undefined) log.error({ err: error }, "queue: handler threw after settling")
		else if (error instanceof QueueDeadLetter) settle(() => delivery.deadLetter(reason))
		else {
			const delay = delayFor(consumer, error, bad ? BAD_BODY_DELAY_SECONDS : undefined, log)
			settle(() => delivery.retry({ ...delay, reason }))
		}
	}
	await settling
}
