/**
 * The adversarial suite's cron cases: a job slower than its schedule, and an instance that lost its
 * claim for a tick. Each is a failing input first and the property that answers it second; the
 * mutation harness reruns this directory with each guard disabled.
 */
import { resolve as resolvePath } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { guardNamed } from "../../structure/mutation-harness.ts"

const REPO = resolvePath(import.meta.dirname, "../../../../..")

const mutant = guardNamed(process.env.HONEY_MUTANT)
if (mutant !== undefined) {
	vi.doMock(resolvePath(REPO, mutant.module), async (importOriginal) => {
		const original = await importOriginal<Record<string, unknown>>()
		return { ...original, ...mutant.disable(original) }
	})
}

/* imported after the mock, so a mutant reaches every module that uses it */
const { serveCron } = (await import(
	resolvePath(REPO, "packages/core/src/cron/serve.ts")
)) as typeof import("../../../src/cron/serve.ts")

const { defineCron } = (await import(
	resolvePath(REPO, "packages/core/src/cron/define.ts")
)) as typeof import("../../../src/cron/define.ts")

const { SILENT } = (await import(
	resolvePath(REPO, "packages/core/src/telemetry/logger.ts")
)) as typeof import("../../../src/telemetry/logger.ts")

const MINUTE = 60_000

const failNoError = (error: unknown) => {
	throw error
}

beforeEach(() => {
	vi.useFakeTimers({ now: Date.parse("2026-11-02T03:00:30Z") })
})

afterEach(() => {
	vi.useRealTimers()
})

describe("v1 adversarial: a job slower than its schedule", () => {
	it("never runs alongside itself", async () => {
		let release = () => {}
		const done = new Promise<void>((resolve) => {
			release = resolve
		})
		let active = 0
		let most = 0
		const job = async () => {
			active++
			most = Math.max(most, active)
			await done
			active--
		}
		const cron = defineCron<{}>({ logger: SILENT, schedules: { "* * * * *": { job } } })
		const running = serveCron(cron, { env: {}, onError: failNoError, singleInstance: true })
		await vi.advanceTimersByTimeAsync(30_000 + 3 * MINUTE)
		release()
		await running.close(0)
		expect(most).toBe(1)
	})
})

describe("v1 adversarial: an instance that lost its claim", () => {
	it("leaves the tick to the instance that won", async () => {
		const job = vi.fn(async () => {})
		const cron = defineCron<{}>({ logger: SILENT, schedules: { "* * * * *": { job } } })
		const running = serveCron(cron, { claim: async () => false, env: {}, onError: failNoError })
		await vi.advanceTimersByTimeAsync(30_000 + MINUTE)
		await running.close(0)
		expect(job).not.toHaveBeenCalled()
	})
})
