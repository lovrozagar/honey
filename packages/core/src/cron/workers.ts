/**
 * A definition behind a Workers cron trigger. Workers reports the expression that fired, so an
 * expression here must match the trigger's text exactly. Every job of the expression runs, and a
 * failed run calls `noRetry()` before it rethrows, since a job that already ran must not run again.
 */
import type { CronDefinition } from "./define.ts"
import { runJob } from "./run.ts"

/** The part of a Workers `ScheduledController` a run reads. */
export type WorkersScheduledController = {
	/** The expression that fired. */
	readonly cron: string
	/** Stops the platform retrying this run. */
	noRetry(): void
	/** The time this run was scheduled for, in epoch milliseconds. */
	readonly scheduledTime: number
}

const rethrow = (controller: WorkersScheduledController, failures: readonly unknown[]): never => {
	controller.noRetry()
	throw failures.length === 1 ? failures[0] : new AggregateError(failures, "cron: several jobs failed")
}

/**
 * The `scheduled` handler for `cron`. Export it from the app's entry and honey's Workers build moves
 * it onto the default export.
 *
 * @example
 * export const scheduled = workersCron(cron)
 */
export function workersCron<Env>(
	cron: CronDefinition<Env>,
): (controller: WorkersScheduledController, env: Env) => Promise<void> {
	return async (controller, env) => {
		const schedule = cron.schedules.find(({ expression }) => expression === controller.cron)
		if (schedule === undefined) return rethrow(controller, [new Error(`cron: no schedule for "${controller.cron}"`)])
		const scheduledAt = new Date(controller.scheduledTime)
		const { signal } = new AbortController()
		const results = await Promise.allSettled(
			schedule.jobs.map(([job, handler]) =>
				runJob({ cron, env, handler, job, schedule: schedule.expression, scheduledAt, signal }),
			),
		)
		const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []))
		if (failures.length > 0) rethrow(controller, failures)
	}
}
