/**
 * A Worker app whose entry exports a cron handler beside its app. `/ran` reads what the job recorded,
 * so a run shows only if the handler reached workerd through the built entry's default export.
 */
import { defineCron } from "../../../src/cron/define.ts"
import { workersCron } from "../../../src/cron/workers.ts"
import { honey } from "../../../src/routing/app.ts"

const ran: string[] = []

export const app = honey<{}>()
	.get("/ran")
	.handler((ctx) => ctx.res.text("ok", ran.join(",")))

export const scheduled = workersCron(
	defineCron<{}>({
		schedules: {
			"*/5 * * * *": {
				record: async ({ schedule }) => {
					ran.push(schedule)
				},
			},
		},
	}),
)
