import { describe, expect, it, vi } from "vitest"
import { SILENT } from "../telemetry/logger.ts"
import { defineCron } from "./define.ts"
import { workersCron } from "./workers.ts"

type Env = { readonly name: string }

const ENV: Env = { name: "env" }

const controller = (cron: string, calls: string[] = []) => ({
	cron,
	noRetry: () => {
		calls.push("noRetry")
	},
	scheduledTime: Date.parse("2026-11-02T03:00:00Z"),
})

describe("workersCron: which jobs run", () => {
	it("runs every job of the expression that fired, and no other's", async () => {
		const ran: string[] = []
		const cron = defineCron<Env>({
			logger: SILENT,
			schedules: {
				"*/5 * * * *": {
					one: async () => {
						ran.push("one")
					},
					two: async () => {
						ran.push("two")
					},
				},
				"0 0 * * *": {
					three: async () => {
						ran.push("three")
					},
				},
			},
		})
		await workersCron(cron)(controller("*/5 * * * *"), ENV)
		expect(ran.toSorted()).toEqual(["one", "two"])
	})

	it("hands a job its env, schedule, time, a logger and a signal that never aborts", async () => {
		const job = vi.fn(async () => {})
		const cron = defineCron<Env>({ logger: SILENT, schedules: { "* * * * *": { job } } })
		await workersCron(cron)(controller("* * * * *"), ENV)
		const [seen] = job.mock.calls[0] as unknown as [
			{ env: Env; log: unknown; schedule: string; scheduledAt: Date; signal: AbortSignal },
		]
		expect([
			seen.env,
			seen.schedule,
			seen.scheduledAt.toISOString(),
			seen.signal.aborted,
			seen.log === undefined,
		]).toEqual([ENV, "* * * * *", "2026-11-02T03:00:00.000Z", false, false])
	})
})

describe("workersCron: a failed run", () => {
	it("fails on an expression the definition lacks, with no retry", async () => {
		const calls: string[] = []
		const cron = defineCron<Env>({ logger: SILENT, schedules: { "* * * * *": { job: async () => {} } } })
		await expect(workersCron(cron)(controller("0 0 * * *", calls), ENV)).rejects.toThrow('"0 0 * * *"')
		expect(calls).toEqual(["noRetry"])
	})

	it("calls noRetry before it rethrows the job's error", async () => {
		const calls: string[] = []
		const boom = new Error("boom")
		const cron = defineCron<Env>({
			logger: SILENT,
			schedules: {
				"* * * * *": {
					job: async () => {
						throw boom
					},
				},
			},
		})
		const failed = workersCron(cron)(controller("* * * * *", calls), ENV).catch((error: unknown) => {
			calls.push("rethrown")
			return error
		})
		expect(await failed).toBe(boom)
		expect(calls).toEqual(["noRetry", "rethrown"])
	})
})

describe("workersCron: failing jobs", () => {
	it("treats a job that throws before its first await like any other failure", async () => {
		const cron = defineCron<Env>({
			logger: SILENT,
			schedules: {
				"* * * * *": {
					job: () => {
						throw new Error("sync")
					},
				},
			},
		})
		await expect(workersCron(cron)(controller("* * * * *"), ENV)).rejects.toThrow("sync")
	})

	it("lets the other jobs finish, and reports every failure", async () => {
		const finished: string[] = []
		const cron = defineCron<Env>({
			logger: SILENT,
			schedules: {
				"* * * * *": {
					bad: async () => {
						throw new Error("bad")
					},
					good: async () => {
						await Promise.resolve()
						finished.push("good")
					},
					worse: async () => {
						throw new Error("worse")
					},
				},
			},
		})
		const error = await workersCron(cron)(controller("* * * * *"), ENV).catch((reason: unknown) => reason)
		expect(finished).toEqual(["good"])
		expect((error as AggregateError).errors.map((e: Error) => e.message)).toEqual(["bad", "worse"])
	})
})
