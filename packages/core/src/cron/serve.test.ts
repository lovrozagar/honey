import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SILENT } from "../telemetry/logger.ts"
import { defineCron, type CronHandler, type CronJob } from "./define.ts"
import { type CronHandle, serveCron } from "./serve.ts"

const START = Date.parse("2026-11-02T03:00:30Z")
const MINUTE = 60_000

const failNoError = (error: unknown) => {
	throw error
}

const everyMinute = (job: CronHandler<{}>) => defineCron<{}>({ logger: SILENT, schedules: { "* * * * *": { job } } })

const handles: CronHandle[] = []
const started = (...args: Parameters<typeof serveCron<{}>>) => {
	const handle = serveCron(...args)
	handles.push(handle)
	return handle
}

const runs = (cron = vi.fn(async (_job: CronJob<{}>) => {})) => {
	started(everyMinute(cron), { env: {}, onError: failNoError, singleInstance: true })
	return cron
}

const times = (job: { mock: { calls: unknown[][] } }) =>
	job.mock.calls.map(([seen]) => (seen as CronJob<{}>).scheduledAt.toISOString().slice(11, 16))

/* a job that stays running until the test lets it go */
const held = () => {
	let release = () => {}
	const done = new Promise<void>((resolve) => {
		release = resolve
	})
	return { done, release: () => release() }
}

beforeEach(() => {
	vi.useFakeTimers({ now: START })
})

afterEach(async () => {
	await Promise.all(handles.splice(0).map((handle) => handle.close(0)))
	vi.useRealTimers()
})

describe("serveCron: the clock", () => {
	it("fires at the next minute, not the one it started inside", async () => {
		const job = runs()
		await vi.advanceTimersByTimeAsync(29_000)
		expect(times(job)).toEqual([])
		await vi.advanceTimersByTimeAsync(1_000)
		expect(times(job)).toEqual(["03:01"])
	})

	it("leaves the minute it started inside alone when a timer lands early", async () => {
		const job = runs()
		vi.setSystemTime(Date.now() - 1_000)
		await vi.advanceTimersByTimeAsync(30_000)
		expect(times(job)).toEqual([])
		await vi.advanceTimersByTimeAsync(1_000)
		expect(times(job)).toEqual(["03:01"])
	})

	it("fires each minute it passes through, with that minute as scheduledAt", async () => {
		const job = runs()
		await vi.advanceTimersByTimeAsync(30_000 + 2 * MINUTE)
		expect(times(job)).toEqual(["03:01", "03:02", "03:03"])
	})

	it("keeps no timer longer than a minute, so a jumped clock corrects within one", async () => {
		const job = runs()
		await vi.advanceTimersByTimeAsync(30_000)
		const forward = Date.now() + 10 * MINUTE
		vi.setSystemTime(forward + 30_000)
		await vi.advanceTimersByTimeAsync(MINUTE)
		expect(times(job)).toEqual(["03:01", "03:12"])
	})

	it("never fires a minute twice when the clock steps back over it", async () => {
		const job = runs()
		await vi.advanceTimersByTimeAsync(30_000 + MINUTE)
		vi.setSystemTime(Date.now() - 2 * MINUTE)
		await vi.advanceTimersByTimeAsync(3 * MINUTE)
		const fired = times(job)
		expect([fired.length === new Set(fired).size, fired.includes("03:03")]).toEqual([true, true])
	})
})

describe("serveCron: a clock that moves", () => {
	it("remembers a day of minutes, so what it fired stays bounded", async () => {
		const job = runs()
		await vi.advanceTimersByTimeAsync(30_000 + 1_441 * MINUTE)
		const fired = job.mock.calls.length
		vi.setSystemTime(Date.now() - 1_442 * MINUTE)
		await vi.advanceTimersByTimeAsync(MINUTE)
		expect(job.mock.calls.length).toBe(fired + 1)
	})

	it("loses the ticks a suspended process missed", async () => {
		const job = runs()
		await vi.advanceTimersByTimeAsync(30_000)
		vi.setSystemTime(Date.now() + 5 * MINUTE)
		await vi.advanceTimersByTimeAsync(MINUTE)
		expect(times(job).length).toBeLessThanOrEqual(2)
	})

	it("matches the expression, so a quiet minute runs nothing", async () => {
		const job = vi.fn(async () => {})
		const cron = defineCron<{}>({ logger: SILENT, schedules: { "5 * * * *": { job } } })
		started(cron, { env: {}, onError: failNoError, singleInstance: true })
		await vi.advanceTimersByTimeAsync(3 * MINUTE)
		expect(job).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(2 * MINUTE)
		expect(job).toHaveBeenCalledOnce()
	})
})

describe("serveCron: a job still running", () => {
	it("skips its tick, and runs again once it has settled", async () => {
		const slow = held()
		const job = vi.fn(() => slow.done)
		started(everyMinute(job), { env: {}, onError: failNoError, singleInstance: true })
		await vi.advanceTimersByTimeAsync(30_000 + 2 * MINUTE)
		expect(job).toHaveBeenCalledOnce()
		slow.release()
		await vi.advanceTimersByTimeAsync(MINUTE)
		expect(job).toHaveBeenCalledTimes(2)
	})

	it("keeps one job's overlap from skipping another", async () => {
		const slow = held()
		const quick = vi.fn(async () => {})
		const cron = defineCron<{}>({ logger: SILENT, schedules: { "* * * * *": { quick, slow: () => slow.done } } })
		started(cron, { env: {}, onError: failNoError, singleInstance: true })
		await vi.advanceTimersByTimeAsync(30_000 + MINUTE)
		expect(quick).toHaveBeenCalledTimes(2)
		slow.release()
	})
})

describe("serveCron: claim", () => {
	it("asks per job per tick, keyed by expression and job, and runs only what it won", async () => {
		const asked: string[] = []
		const won = vi.fn(async () => {})
		const lost = vi.fn(async () => {})
		const cron = defineCron<{}>({ logger: SILENT, schedules: { "* * * * *": { lost, won } } })
		const claim = async (key: string, scheduledAt: Date) => {
			asked.push(`${key} @${scheduledAt.toISOString().slice(11, 16)}`)
			return key.endsWith("won")
		}
		started(cron, { claim, env: {}, onError: failNoError })
		await vi.advanceTimersByTimeAsync(30_000)
		expect(asked.toSorted()).toEqual(["* * * * * lost @03:01", "* * * * * won @03:01"])
		expect([won.mock.calls.length, lost.mock.calls.length]).toEqual([1, 0])
	})

	it("sends a throwing claim to onError and leaves the job unrun", async () => {
		const seen: unknown[] = []
		const job = vi.fn(async () => {})
		const boom = new Error("no store")
		started(everyMinute(job), {
			claim: async () => {
				throw boom
			},
			env: {},
			onError: (error, info) => {
				seen.push(error, info.job, info.schedule, info.scheduledAt.toISOString())
			},
		})
		await vi.advanceTimersByTimeAsync(30_000)
		expect(seen).toEqual([boom, "job", "* * * * *", "2026-11-02T03:01:00.000Z"])
		expect(job).not.toHaveBeenCalled()
	})

	it("refuses both coordination options, and neither", () => {
		const cron = everyMinute(async () => {})
		const base = { env: {}, onError: failNoError }
		const both = { ...base, claim: async () => true, singleInstance: true } as never
		expect(() => serveCron(cron, both)).toThrow("singleInstance")
		expect(() => serveCron(cron, base as never)).toThrow("singleInstance")
	})
})

describe("serveCron: failures", () => {
	it("hands a job's failure to onError and keeps ticking", async () => {
		const seen: unknown[] = []
		const job = vi.fn(async () => {
			throw new Error("boom")
		})
		started(everyMinute(job), {
			env: {},
			onError: (error) => void seen.push((error as Error).message),
			singleInstance: true,
		})
		await vi.advanceTimersByTimeAsync(30_000 + MINUTE)
		expect(seen).toEqual(["boom", "boom"])
	})

	it("logs a throwing onError and leaves no unhandled rejection", async () => {
		const logged: unknown[] = []
		const logger = { ...SILENT, error: (first: unknown) => void logged.push(first) }
		const cron = defineCron<{}>({
			logger,
			schedules: {
				"* * * * *": {
					job: async () => {
						throw new Error("boom")
					},
				},
			},
		})
		const rejections: unknown[] = []
		const onRejection = (reason: unknown) => void rejections.push(reason)
		process.on("unhandledRejection", onRejection)
		started(cron, {
			env: {},
			onError: () => {
				throw new Error("reporter down")
			},
			singleInstance: true,
		})
		await vi.advanceTimersByTimeAsync(30_000)
		await vi.advanceTimersByTimeAsync(0)
		process.off("unhandledRejection", onRejection)
		expect([logged.length, rejections]).toEqual([1, []])
	})
})

describe("serveCron: close", () => {
	it("stops the timer", async () => {
		const job = vi.fn(async () => {})
		const handle = started(everyMinute(job), { env: {}, onError: failNoError, singleInstance: true })
		await handle.close()
		await vi.advanceTimersByTimeAsync(3 * MINUTE)
		expect(job).not.toHaveBeenCalled()
	})

	it("waits for a running job, and leaves its signal alone when no timeout passes", async () => {
		const slow = held()
		let signal: AbortSignal | undefined
		const handle = started(
			everyMinute((job) => {
				signal = job.signal
				return slow.done
			}),
			{ env: {}, onError: failNoError, singleInstance: true },
		)
		await vi.advanceTimersByTimeAsync(30_000)
		let closed = false
		const closing = handle.close().then(() => {
			closed = true
		})
		await vi.advanceTimersByTimeAsync(10 * MINUTE)
		expect([closed, signal?.aborted]).toEqual([false, false])
		slow.release()
		await closing
		expect(closed).toBe(true)
	})

	it("aborts the signal when the timeout passes and resolves without the job", async () => {
		const slow = held()
		let signal: AbortSignal | undefined
		const handle = started(
			everyMinute((job) => {
				signal = job.signal
				return slow.done
			}),
			{ env: {}, onError: failNoError, singleInstance: true },
		)
		await vi.advanceTimersByTimeAsync(30_000)
		const closing = handle.close(1_000)
		await vi.advanceTimersByTimeAsync(999)
		expect(signal?.aborted).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		await closing
		expect(signal?.aborted).toBe(true)
		slow.release()
	})
})

describe("serveCron: close, at the edges", () => {
	it("treats a timeout past the timer's range as a long wait, not an instant abort", async () => {
		const slow = held()
		let signal: AbortSignal | undefined
		const handle = started(
			everyMinute((job) => {
				signal = job.signal
				return slow.done
			}),
			{ env: {}, onError: failNoError, singleInstance: true },
		)
		await vi.advanceTimersByTimeAsync(30_000)
		const closing = handle.close(2 ** 40)
		await vi.advanceTimersByTimeAsync(MINUTE)
		expect(signal?.aborted).toBe(false)
		slow.release()
		await closing
	})

	it("stays stopped when a job closes it during its own tick", async () => {
		const job = vi.fn(async () => {
			void handle.close()
		})
		const handle = started(everyMinute(job), { env: {}, onError: failNoError, singleInstance: true })
		await vi.advanceTimersByTimeAsync(30_000 + 3 * MINUTE)
		expect([job.mock.calls.length, vi.getTimerCount()]).toEqual([1, 0])
	})

	it("answers the same close twice", async () => {
		const handle = started(
			everyMinute(async () => {}),
			{ env: {}, onError: failNoError, singleInstance: true },
		)
		const first = handle.close()
		expect(handle.close()).toBe(first)
		await first
	})

	it("starts no job a claim won after close began", async () => {
		const gate = held()
		const job = vi.fn(async () => {})
		const handle = started(everyMinute(job), {
			claim: async () => {
				await gate.done
				return true
			},
			env: {},
			onError: failNoError,
		})
		await vi.advanceTimersByTimeAsync(30_000)
		const closing = handle.close()
		gate.release()
		await closing
		expect(job).not.toHaveBeenCalled()
	})
})
