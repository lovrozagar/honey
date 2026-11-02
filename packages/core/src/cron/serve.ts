/**
 * A definition in a long-running process, on one timer for Node and Bun. The timer sleeps to the next
 * minute, a minute at most, and then reads the clock, so it never searches for the next tick, never
 * overflows `setTimeout`, and corrects itself after a suspend or a clock step. Ticks missed while the
 * process was down or asleep are lost.
 *
 * Several instances each run every job unless `claim` lets one win. The timer is not unref'd, so a
 * process that only runs cron stays alive until `close`.
 */
import type { CronDefinition, CronHandler, CronSchedule } from "./define.ts"
import { cronFires } from "./expression.ts"
import { runJob } from "./run.ts"

/** Which job a failure came from. */
export type CronFailure = {
	/** The job's name. */
	job: string
	/** The expression that fired. */
	schedule: string
	/** The minute the run belonged to. */
	scheduledAt: Date
}

/** What every `serveCron` takes, however it coordinates instances. */
type ServeCronBase<Env> = {
	/** The environment every job receives. */
	env: Env
	/** Receives a failed job or claim. If it throws too, the error is logged. */
	onError(error: unknown, failure: CronFailure): Promise<void> | void
}

/** How jobs run in this process: as the only instance, or after winning a claim for each tick. */
export type ServeCronOptions<Env> = ServeCronBase<Env> &
	(
		| {
				/** Never set with `singleInstance`. */
				claim?: never
				/** This is the only instance, so every job runs here. */
				singleInstance: true
		  }
		| {
				/**
				 * Whether this instance runs a tick, asked per job per tick and never released. `key` is
				 * `<expression> <job>`, so a shared store records it with `scheduledAt` once.
				 */
				claim(key: string, scheduledAt: Date): Promise<boolean>
				/** Never set with `claim`. */
				singleInstance?: never
		  }
	)

/** A running schedule. */
export type CronHandle = {
	/**
	 * Stops the timer and waits for running jobs. With no `timeoutMs` it waits as long as they take,
	 * so a job closing its own schedule calls `void close()`. When `timeoutMs` passes first it aborts
	 * their signal and resolves without them. A second call answers the first's promise.
	 */
	close(timeoutMs?: number): Promise<void>
}

const MINUTE_MS = 60_000

/* a day of minutes, so a clock stepped back by up to a day never fires a minute twice */
const REMEMBERED_MINUTES = 1_440

/* `setTimeout` fires at once past this */
const MAX_TIMER_MS = 2_147_483_647

/** Everything one `serveCron` keeps, so nothing lives at module scope. */
type Running<Env> = {
	readonly aborting: AbortController
	closing: Promise<void> | undefined
	readonly cron: CronDefinition<Env>
	readonly fired: Set<number>
	readonly jobs: Map<string, Promise<void>>
	readonly options: ServeCronOptions<Env>
	timer: ReturnType<typeof setTimeout> | undefined
}

/** One job at one tick. */
type Attempt<Env> = CronFailure & { readonly handler: CronHandler<Env>; readonly key: string }

const untilNextMinute = (now: number) => MINUTE_MS - (now % MINUTE_MS)

const report = async <Env>({ cron, options }: Running<Env>, error: unknown, failure: CronFailure) => {
	try {
		await options.onError(error, failure)
	} catch (reporting) {
		cron.logger.error({ err: reporting, job: failure.job }, "cron: onError threw")
	}
}

const attempt = async <Env>(state: Running<Env>, { handler, key, ...failure }: Attempt<Env>) => {
	const { aborting, cron, options } = state
	try {
		if (options.claim !== undefined && !(await options.claim(key, failure.scheduledAt))) return
		/* read after the claim: close may have begun while it was out */
		if (state.closing !== undefined) return
		await runJob({ ...failure, cron, env: options.env, handler, signal: aborting.signal })
	} catch (error) {
		await report(state, error, failure)
	}
}

const start = <Env>(state: Running<Env>, { expression, jobs }: CronSchedule<Env>, scheduledAt: Date) => {
	for (const [job, handler] of jobs) {
		const key = `${expression} ${job}`
		if (state.jobs.has(key)) continue
		const run = attempt(state, { handler, job, key, schedule: expression, scheduledAt })
		state.jobs.set(
			key,
			run.finally(() => state.jobs.delete(key)),
		)
	}
}

const tick = <Env>(state: Running<Env>) => {
	const now = Date.now()
	const minute = Math.floor(now / MINUTE_MS)
	if (!state.fired.has(minute)) {
		state.fired.add(minute)
		if (state.fired.size > REMEMBERED_MINUTES) state.fired.delete(state.fired.values().next().value as number)
		const scheduledAt = new Date(minute * MINUTE_MS)
		for (const schedule of state.cron.schedules) {
			if (cronFires(schedule.fields, scheduledAt)) start(state, schedule, scheduledAt)
		}
	}
	/* a job may close from inside this tick, and its stop must stand */
	if (state.closing === undefined) state.timer = setTimeout(tick, untilNextMinute(now), state)
}

const stop = async <Env>(state: Running<Env>, timeoutMs: number | undefined) => {
	clearTimeout(state.timer)
	const settled = Promise.allSettled(state.jobs.values())
	if (timeoutMs === undefined) {
		await settled
		return
	}
	let deadline: ReturnType<typeof setTimeout> | undefined
	const expired = new Promise<void>((resolve) => {
		const expire = () => {
			state.aborting.abort()
			resolve()
		}
		deadline = setTimeout(expire, Math.min(timeoutMs, MAX_TIMER_MS))
	})
	await Promise.race([settled, expired])
	clearTimeout(deadline)
}

/**
 * Runs `cron` on a timer, which keeps the process alive until `close`. The minute it starts in does
 * not fire, ticks missed while the process was down or asleep are lost, and a job still running at
 * its next tick skips that tick. Throws a `TypeError` unless exactly one of `singleInstance: true`
 * and `claim` is set.
 *
 * @example
 * const running = serveCron(cron, { env, onError: report, singleInstance: true })
 * process.once("SIGTERM", () => running.close(10_000))
 */
export function serveCron<Env>(cron: CronDefinition<Env>, options: ServeCronOptions<Env>): CronHandle {
	if ((options.singleInstance === true) === (options.claim !== undefined)) {
		throw new TypeError("serveCron: pass exactly one of singleInstance: true or claim")
	}
	const now = Date.now()
	const state: Running<Env> = {
		aborting: new AbortController(),
		closing: undefined,
		cron,
		fired: new Set([Math.floor(now / MINUTE_MS)]),
		jobs: new Map(),
		options,
		timer: undefined,
	}
	state.timer = setTimeout(tick, untilNextMinute(now), state)
	return {
		close: (timeoutMs) => {
			state.closing ??= stop(state, timeoutMs)
			return state.closing
		},
	}
}
