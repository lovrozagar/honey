import { describe, expect, it, vi } from "vitest"
import { SILENT } from "../telemetry/logger.ts"
import {
	deadLetter,
	defineConsumer,
	type QueueBodyError,
	type QueueConsumerConfig,
	type QueueContext,
	queueContract,
	queueMessage,
} from "./define.ts"
import { deliver, type Delivery, letterOf, reportLetter } from "./deliver.ts"

type Env = { readonly name: string }

const ENV: Env = { name: "env" }

const FAILS = {
	"~standard": { validate: () => ({ issues: [{ message: "too short" }] }), vendor: "test", version: 1 },
} as const

const TRIMS = {
	"~standard": {
		types: undefined as unknown as { input: string; output: string },
		validate: (value: unknown) => ({ value: (value as string).trim() }),
		vendor: "test",
		version: 1,
	},
} as const

const THROWS = {
	"~standard": {
		validate: () => {
			throw new Error("schema blew up")
		},
		vendor: "test",
		version: 1,
	},
} as const

const contract = queueContract({ bad: FAILS, boom: THROWS, job: queueMessage<number>(), trim: TRIMS })

type Handler = (ctx: QueueContext<Env, never>) => Promise<void> | void

const recording = (body: unknown = { data: 1, type: "job" }) => {
	const calls: unknown[][] = []
	const delivery: Delivery = {
		ack: () => void calls.push(["ack"]),
		attempts: 2,
		body,
		deadLetter: (reason) => void calls.push(["deadLetter", reason]),
		id: "m1",
		queue: "q",
		retry: (options) => void calls.push(["retry", options]),
	}
	return { calls, delivery }
}

const consumerOf = (job: Handler, config: Partial<QueueConsumerConfig<Env, never>> = {}) =>
	defineConsumer<Env>()(
		contract as never,
		{
			handlers: { bad: job, boom: job, job, trim: job } as never,
			logger: SILENT,
			...config,
		} as never,
	)

const run = async (job: Handler, body?: unknown, config?: Partial<QueueConsumerConfig<Env, never>>) => {
	const { calls, delivery } = recording(body)
	await deliver(consumerOf(job, config), delivery, ENV, () => {})
	return calls
}

describe("deliver: settling", () => {
	it("acks a handler that returns", async () => {
		expect(await run(async () => {})).toEqual([["ack"]])
	})

	it("retries a handler that throws, at once by default", async () => {
		const calls = await run(async () => {
			throw new Error("down")
		})
		expect(calls).toEqual([["retry", { reason: "down" }]])
	})

	it("treats a throw before the first await the same way", async () => {
		const calls = await run(() => {
			throw new Error("sync")
		})
		expect(calls).toEqual([["retry", { reason: "sync" }]])
	})

	it("reads a thrown value that is no error", async () => {
		const calls = await run(() => {
			// oxlint-disable-next-line no-throw-literal
			throw "text"
		})
		expect(calls).toEqual([["retry", { reason: "text" }]])
	})

	it("dead-letters on throw deadLetter(reason)", async () => {
		const calls = await run(async () => {
			throw deadLetter("no account")
		})
		expect(calls).toEqual([["deadLetter", "no account"]])
	})

	it("lets the first settle win over everything after it", async () => {
		const calls = await run(async ({ message }) => {
			message.ack()
			message.retry({ delaySeconds: 5 })
			message.ack()
		})
		expect(calls).toEqual([["ack"]])
	})
})

describe("deliver: settling by hand", () => {
	it("takes a handler's own retry with its delay, and adds no ack", async () => {
		const calls = await run(async ({ message }) => {
			message.retry({ delaySeconds: 5 })
		})
		expect(calls).toEqual([["retry", { delaySeconds: 5, reason: "retried by the handler" }]])
	})

	it("logs a throw after settling and changes nothing", async () => {
		const error = vi.fn()
		const logger = { ...SILENT, child: () => ({ ...SILENT, error }) }
		const calls = await run(
			async ({ message }) => {
				message.ack()
				throw new Error("late")
			},
			undefined,
			{ logger },
		)
		expect([calls, error.mock.calls.length]).toEqual([[["ack"]], 1])
	})
})

describe("deliver: a body past its contract", () => {
	const never = vi.fn(async () => {})

	it.each([
		["no object", "text", "invalid body: no type"],
		["null", null, "invalid body: no type"],
		["no type", { data: 1 }, "invalid body: no type"],
		["a type that is no string", { data: 1, type: 3 }, "invalid body: no type"],
		["an unknown type", { data: 1, type: "gone" }, "unknown type gone"],
		["a prototype key", { data: 1, type: "__proto__" }, "unknown type __proto__"],
		["another prototype key", { data: 1, type: "constructor" }, "unknown type constructor"],
		["a schema failure", { data: 1, type: "bad" }, "invalid body: too short"],
		["a schema that throws", { data: 1, type: "boom" }, "invalid body: schema blew up"],
	])("%s retries after 60 s, and never reaches a handler", async (_label, body, reason) => {
		expect(await run(never, body)).toEqual([["retry", { delaySeconds: 60, reason }]])
		expect(never).not.toHaveBeenCalled()
	})

	it("hands retryDelay the reason, whose answer replaces the 60 s", async () => {
		const seen: string[] = []
		const retryDelay = (error: unknown) => {
			seen.push((error as QueueBodyError).message)
			return 5
		}
		const calls = await run(never, { type: "gone" }, { retryDelay })
		expect([seen, calls]).toEqual([
			[["unknown type gone"][0]],
			[["retry", { delaySeconds: 5, reason: "unknown type gone" }]],
		])
	})

	it("gives a handler the schema's output, not the sent value", async () => {
		const seen: unknown[] = []
		await run(({ data }) => void seen.push(data), { data: "  x ", type: "trim" })
		expect(seen).toEqual(["x"])
	})
})

describe("deliver: retryDelay", () => {
	const failing = async () => {
		throw new Error("down")
	}
	const delayed = async (retryDelay: (error: unknown) => number | undefined) =>
		(await run(failing, undefined, { retryDelay }))[0]?.[1]

	it.each([
		[12, { delaySeconds: 12, reason: "down" }],
		[1.2, { delaySeconds: 2, reason: "down" }],
		[99_999, { delaySeconds: 43_200, reason: "down" }],
		[0, { reason: "down" }],
		[-1, { reason: "down" }],
		[Number.NaN, { reason: "down" }],
		[Number.POSITIVE_INFINITY, { reason: "down" }],
		[undefined, { reason: "down" }],
	])("%s", async (answer, expected) => {
		expect(await delayed(() => answer)).toEqual(expected)
	})

	it("logs a retryDelay that throws and uses the default", async () => {
		const error = vi.fn()
		const logger = { ...SILENT, child: () => ({ ...SILENT, error }) }
		const retryDelay = () => {
			throw new Error("bug")
		}
		const calls = await run(failing, undefined, { logger, retryDelay })
		expect([calls, error.mock.calls.length]).toEqual([[["retry", { reason: "down" }]], 1])
	})
})

describe("deliver: what a handler receives", () => {
	it("hands over the message, env, a trace id and a logger", async () => {
		const seen: unknown[] = []
		await run(({ env, log, message, traceId }) => {
			seen.push(env, message.id, message.attempts, traceId.length > 0, log === undefined)
		})
		expect(seen).toEqual([ENV, "m1", 2, true, false])
	})

	it("hands background work to the runtime, logging its rejection", async () => {
		const error = vi.fn()
		const logger = { ...SILENT, child: () => ({ ...SILENT, error }) }
		const held: Promise<unknown>[] = []
		const { delivery } = recording()
		const job: Handler = ({ background }) => background(Promise.reject(new Error("bg")))
		await deliver(consumerOf(job, { logger }), delivery, ENV, (promise) => void held.push(promise))
		await Promise.all(held)
		expect([held.length, error.mock.calls.length]).toEqual([1, 1])
	})

	it("logs a settle that fails instead of failing the batch", async () => {
		const error = vi.fn()
		const logger = { ...SILENT, child: () => ({ ...SILENT, error }) }
		const { delivery } = recording()
		const broken = {
			...delivery,
			ack: () => {
				throw new Error("gone")
			},
		}
		await deliver(
			consumerOf(async () => {}, { logger }),
			broken,
			ENV,
			() => {},
		)
		expect(error).toHaveBeenCalledOnce()
	})
})

describe("letters", () => {
	it("carries the body and its type, or unknown", () => {
		const { delivery } = recording({ data: 1, type: "job" })
		expect(letterOf(delivery, "why")).toEqual({
			attempts: 2,
			body: { data: 1, type: "job" },
			id: "m1",
			kept: false,
			queue: "q",
			reason: "why",
			type: "job",
		})
		expect([letterOf(recording("text").delivery, "why").type, letterOf(delivery, "why", true).kept]).toEqual([
			"unknown",
			true,
		])
	})

	it("answers whether the report landed, and logs one that did not", async () => {
		const error = vi.fn()
		const logger = { ...SILENT, error }
		const letter = letterOf(recording().delivery, "why")
		const onDeadLetter = async () => {
			throw new Error("reporter down")
		}
		const quiet = consumerOf(async () => {}, { logger })
		const failing = consumerOf(async () => {}, { logger, onDeadLetter })
		expect([await reportLetter(quiet, letter, ENV), await reportLetter(failing, letter, ENV)]).toEqual([true, false])
		expect(error).toHaveBeenCalledTimes(3)
	})

	it("reports through onDeadLetter with the env", async () => {
		const onDeadLetter = vi.fn(async () => {})
		const letter = letterOf(recording().delivery, "why")
		await reportLetter(
			consumerOf(async () => {}, { onDeadLetter }),
			letter,
			ENV,
		)
		expect(onDeadLetter.mock.calls).toEqual([[letter, ENV]])
	})
})
