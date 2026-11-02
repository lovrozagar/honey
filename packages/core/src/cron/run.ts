/** One job's run, the part `./cron/workers` and `./cron/serve` share. */
import type { CronDefinition, CronHandler } from "./define.ts"

/** The run to make. */
export type CronRun<Env> = {
	/** The definition the job belongs to. */
	readonly cron: CronDefinition<Env>
	/** The environment the runtime handed over. */
	readonly env: Env
	/** The job's work. */
	readonly handler: CronHandler<Env>
	/** The job's name. */
	readonly job: string
	/** The expression that fired. */
	readonly schedule: string
	/** The minute this run belongs to. */
	readonly scheduledAt: Date
	/** Aborts when the runtime stops waiting. */
	readonly signal: AbortSignal
}

/** Runs one job. A throw before its first await rejects like any other failure. */
export async function runJob<Env>(run: CronRun<Env>): Promise<void> {
	const { cron, env, handler, job, schedule, scheduledAt, signal } = run
	await handler({ env, log: cron.logger.child({ job, schedule }), schedule, scheduledAt, signal })
}
