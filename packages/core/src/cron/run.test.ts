import { describe, expect, it, vi } from "vitest"
import { SILENT } from "../telemetry/logger.ts"
import { defineCron } from "./define.ts"
import { runJob } from "./run.ts"

const run = { env: {}, job: "job", schedule: "* * * * *", scheduledAt: new Date(0) }

describe("runJob", () => {
	it("binds the logger to the job and its schedule", async () => {
		const child = vi.fn(() => SILENT)
		const cron = defineCron<{}>({
			logger: { ...SILENT, child },
			schedules: { "* * * * *": { job: async () => {} } },
		})
		await runJob({ ...run, cron, handler: async () => {}, signal: new AbortController().signal })
		expect(child.mock.calls).toEqual([[{ job: "job", schedule: "* * * * *" }]])
	})

	it("rejects for a handler that throws before its first await", async () => {
		const cron = defineCron<{}>({ logger: SILENT, schedules: { "* * * * *": { job: async () => {} } } })
		const handler = () => {
			throw new Error("sync")
		}
		await expect(runJob({ ...run, cron, handler, signal: new AbortController().signal })).rejects.toThrow("sync")
	})
})
