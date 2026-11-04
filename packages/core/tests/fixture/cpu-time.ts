/**
 * What one call costs this thread's CPU, for a test that holds a cost ratio between two input sizes. A wall clock
 * also counts the time a loaded runner keeps the thread off the CPU: at load 78 on 16 cores a linear parse once
 * measured 12x for 4x the input (plan 39), past the 10 that tells it from the cubic mutant. `process.threadCpuUsage`
 * counts only the thread's own work, so the ratio is the code's and not the runner's.
 */

/** Calls between two readings of the clock: a reading is a syscall, which would flatten a cheap call's cost. */
const BATCH = 16
/** CPU time each window spends, long enough that a reading's resolution is lost in it. */
const WINDOW_MS = 30
/** The wall time a window may take, so a call that mostly waits still ends its window. */
const WINDOW_WALL_MS = 1000

/** This thread's CPU time so far, in ms: what a one-shot cost reads before and after the work. */
export function threadCpuMs(): number {
	const { system, user } = process.threadCpuUsage()
	return (user + system) / 1000
}

/** The cheapest per-call CPU time over five windows of repeated `run()` calls, in ms. */
export function cheapestCallCpuMs(run: () => void): number {
	let cheapest = Number.POSITIVE_INFINITY
	for (let window = 0; window < 5; window++) {
		const start = threadCpuMs()
		const wallStart = performance.now()
		let calls = 0
		let spent = 0
		do {
			for (let i = 0; i < BATCH; i++) run()
			calls += BATCH
			spent = threadCpuMs() - start
		} while (spent < WINDOW_MS && performance.now() - wallStart < WINDOW_WALL_MS)
		cheapest = Math.min(cheapest, spent / calls)
	}
	return cheapest
}
