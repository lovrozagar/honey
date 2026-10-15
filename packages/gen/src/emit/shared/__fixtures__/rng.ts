/**
 * Seeded generators for gen's fuzz suites: a copy of core's, since gen never reaches into core
 * (H2). A run uses a fixed seed, so a failure reproduces; `HONEY_FUZZ_SEED` explores other seeds,
 * `HONEY_FUZZ_RUNS` scales every suite's iteration count.
 */

export type Rng = {
	/** uniform in [0, 1) */
	(): number
	int(maxExclusive: number): number
	pick<T>(items: readonly T[]): T
}

function baseSeed(): number {
	return Number(process.env.HONEY_FUZZ_SEED ?? 0x5eed)
}

/** Iterations for a suite: `ci` under CI, `local` elsewhere, either scaled by `HONEY_FUZZ_RUNS`. */
export function runs(local: number, ci: number): number {
	const scale = Math.max(1, Number(process.env.HONEY_FUZZ_RUNS ?? 1))
	return Math.round((process.env.CI === undefined ? local : ci) * scale)
}

/** A mulberry32 stream from the base seed and a per-suite salt. */
export function rng(salt: number): Rng {
	let s = (baseSeed() ^ Math.imul(salt, 0x9e3779b1)) >>> 0
	const next = (() => {
		s = (s + 0x6d2b79f5) >>> 0
		let t = s
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}) as Rng
	next.int = (max) => Math.floor(next() * max)
	next.pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)] as T
	return next
}

/** A label for an assertion message: a failing case prints its seed and input. */
export function caseLabel(salt: number, i: number, input: string): string {
	return `seed=${baseSeed()} salt=${salt} case=${i} input=${JSON.stringify(input)}`
}
