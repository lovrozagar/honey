/**
 * One schedule definition for every runtime: `defineCron` checks it once, and `./cron/workers` or
 * `./cron/serve` runs it. An expression is five fields in UTC, in the subset every runtime reads the
 * same way; see `parseCron` for what is refused.
 */
import { createLogger, type Logger } from "../telemetry/logger.ts"
import { type CronFields, parseCron } from "./expression.ts"

/** What a job receives for one run. */
export type CronJob<Env> = {
	/** The environment the runtime handed over. */
	env: Env
	/** The definition's logger, bound to this job and schedule. */
	log: Logger
	/** The expression that fired. */
	schedule: string
	/** The minute this run belongs to, not the moment it started. */
	scheduledAt: Date
	/** Aborts when `close`'s timeout passes; on Workers it never aborts. */
	signal: AbortSignal
}

/** One job's work. A rejection fails this run and no other job's. */
export type CronHandler<Env> = (job: CronJob<Env>) => Promise<void>

/** What `defineCron` takes. */
export type CronConfig<Env> = {
	/** Where jobs log; default honey's logger. */
	logger?: Logger
	/** The jobs to run, by expression and then by name. */
	schedules: Readonly<Record<string, Readonly<Record<string, CronHandler<Env>>>>>
}

/** One expression, parsed, with its jobs. */
export type CronSchedule<Env> = {
	/** The expression as written, which is what a Workers cron trigger reports. */
	readonly expression: string
	/** The values the expression selects. */
	readonly fields: CronFields
	/** The expression's jobs as `[name, handler]`. */
	readonly jobs: readonly (readonly [string, CronHandler<Env>])[]
}

/** A checked definition, ready for `workersCron` or `serveCron`. */
export type CronDefinition<Env> = {
	/** Where jobs log. */
	readonly logger: Logger
	/** Every expression with its jobs. */
	readonly schedules: readonly CronSchedule<Env>[]
}

const scheduleOf = <Env>(expression: string, jobs: Readonly<Record<string, CronHandler<Env>>>): CronSchedule<Env> => {
	const fields = parseCron(expression)
	const entries = Object.entries(jobs)
	if (entries.length === 0) throw new Error(`cron: "${expression}" has no jobs`)
	for (const [name, handler] of entries) {
		if (typeof handler !== "function") throw new Error(`cron: "${expression}" job "${name}" is not a function`)
	}
	return { expression, fields, jobs: entries }
}

/**
 * Checks a schedule definition, throwing on anything that could never run.
 *
 * @example
 * export const cron = defineCron<Env>({
 *   schedules: { "0 3 * * MON": { digest: async ({ env, log }) => log.info(await sendDigest(env)) } },
 * })
 */
export function defineCron<Env>(config: CronConfig<Env>): CronDefinition<Env> {
	const schedules = Object.entries(config.schedules).map(([expression, jobs]) => scheduleOf(expression, jobs))
	if (schedules.length === 0) throw new Error("cron: a definition needs at least one schedule")
	return { logger: config.logger ?? createLogger(), schedules }
}
