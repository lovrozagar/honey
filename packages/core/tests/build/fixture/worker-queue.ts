/**
 * A Worker app whose entry exports a queue handler beside its app. `/send` sends two jobs and a body
 * of a type the contract lacks, and `/ran` reads what the consumer saw, so each line shows only if a
 * real batch reached the handler through the built entry. `retryDelay` answers 0, so the bad body
 * goes straight to the dead-letter queue, past `max_retries: 0`.
 */
import { defineConsumer, queueContract, queueMessage, type QueueTarget } from "../../../src/queue/define.ts"
import { workersQueue } from "../../../src/queue/workers.ts"
import { honey } from "../../../src/routing/app.ts"

type Env = { readonly JOBS: QueueTarget }

const ran: string[] = []

const jobs = queueContract({ job: queueMessage<number>() })

const consumer = defineConsumer<Env>()(jobs, {
	handlers: {
		job: ({ data }) => {
			ran.push(`job ${data}`)
		},
	},
	onDeadLetter: async ({ body, queue, type }) => {
		ran.push(`letter ${queue} ${type} ${JSON.stringify(body)}`)
	},
	retryDelay: () => 0,
})

export const app = honey<Env>()
	.get("/send")
	.handler(async (ctx) => {
		await jobs.sendBatch(ctx.env.JOBS, [
			{ data: 1, type: "job" },
			{ data: 2, type: "job" },
		])
		await ctx.env.JOBS.send({ data: 3, type: "gone" })
		return ctx.res.text("ok", "sent")
	})
	.get("/ran")
	.handler((ctx) => ctx.res.text("ok", JSON.stringify(ran)))

export const queue = workersQueue(consumer, { deadLetterQueues: ["fixture-dead"] })
