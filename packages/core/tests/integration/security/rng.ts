/**
 * Seeded generators for the fuzz suites. CI runs a fixed seed, so a failure reproduces; set
 * `HONEY_FUZZ_SEED` to explore other seeds and `HONEY_FUZZ_RUNS` to scale every suite's iteration
 * count (e.g. `HONEY_FUZZ_RUNS=50 bunx vitest run tests/integration/security`).
 */

export type Rng = {
	/** uniform in [0, 1) */
	(): number
	bool(p?: number): boolean
	int(maxExclusive: number): number
	pick<T>(items: readonly T[]): T
}

const BASE_SEED = Number(process.env.HONEY_FUZZ_SEED ?? 0x5eed)
const SCALE = Math.max(1, Number(process.env.HONEY_FUZZ_RUNS ?? 1))

/** Iterations for a suite: `base` in CI, multiplied by `HONEY_FUZZ_RUNS` locally. */
export function runs(base: number): number {
	return Math.round(base * SCALE)
}

/** A mulberry32 stream derived from the base seed and a per-suite salt. */
export function rng(salt: number): Rng {
	let s = (BASE_SEED ^ Math.imul(salt, 0x9e3779b1)) >>> 0
	const next = (() => {
		s = (s + 0x6d2b79f5) >>> 0
		let t = s
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}) as Rng
	next.int = (max) => Math.floor(next() * max)
	next.pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)] as T
	next.bool = (p = 0.5) => next() < p
	return next
}

/** A string of `0..max` tokens drawn from `alphabet` (a token may be several characters). */
export function stringOf(r: Rng, alphabet: readonly string[], max: number): string {
	let out = ""
	const len = r.int(max + 1)
	for (let i = 0; i < len; i++) out += r.pick(alphabet)
	return out
}

/** A label for an assertion message, so a failing case prints its input and seed. */
export function caseLabel(salt: number, i: number, input: unknown): string {
	return `seed=${BASE_SEED} salt=${salt} case=${i} input=${JSON.stringify(input)}`
}
