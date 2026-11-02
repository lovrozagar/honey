/** What a contract lets a sender write and what a handler reads, at compile time. */
import { expectTypeOf, test } from "vitest"
import { defineConsumer, queueContract, queueMessage, type QueueTarget } from "../../src/queue/define.ts"

declare const target: QueueTarget

const transforms = {
	"~standard": {
		types: undefined as unknown as { input: string; output: number },
		validate: (value: unknown) => ({ value: Number(value) }),
		vendor: "test",
		version: 1,
	},
} as const

const jobs = queueContract({ count: transforms, welcome: queueMessage<{ userId: string }>() })

test("send takes a type's input, and refuses anything else", async () => {
	await jobs.send(target, "welcome", { userId: "u" })
	await jobs.send(target, "count", "12")
	// @ts-expect-error an unknown type
	await jobs.send(target, "gone", {})
	// @ts-expect-error the wrong field
	await jobs.send(target, "welcome", { id: "u" })
	// @ts-expect-error a schema's output, not its input
	await jobs.send(target, "count", 12)
	expectTypeOf(jobs.send).returns.toEqualTypeOf<Promise<void>>()
})

test("sendBatch ties each message's data to its type", async () => {
	await jobs.sendBatch(target, [{ data: "12", type: "count" }])
	// @ts-expect-error welcome's data under count
	await jobs.sendBatch(target, [{ data: { userId: "u" }, type: "count" }])
	expectTypeOf(jobs.sendBatch).returns.toEqualTypeOf<Promise<void>>()
})

test("a handler reads the schema's output, and env is what was written", () => {
	defineConsumer<{ readonly DB: string }>()(jobs, {
		handlers: {
			count: ({ data, env }) => {
				expectTypeOf(data).toEqualTypeOf<number>()
				expectTypeOf(env.DB).toEqualTypeOf<string>()
			},
			welcome: ({ data }) => {
				expectTypeOf(data).toEqualTypeOf<{ userId: string }>()
			},
		},
	})
})

test("every type needs a handler", () => {
	// @ts-expect-error welcome has no handler
	defineConsumer<{}>()(jobs, { handlers: { count: () => {} } })
	expectTypeOf(defineConsumer<{}>()).toBeFunction()
})
