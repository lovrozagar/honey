/**
 * The ceiling rule both CI perf baselines share (bit 21; plan 37 moved it here from build-gate.ts so the bench derive
 * reads the same one): blueprint/baselines/build.json's cells and bench.json's scenarios, each derived from CI's own
 * runs by derive-build-ceilings.ts and bench/src/derive-ceilings.ts.
 */

/** The record runs a derive needs: at least 6 (the build derive also needs its Bun jobs on the fast and slow class). */
export const MIN_RECORD_RUNS = 6

/** The per-run false-red chance every derived cell shares, split evenly across them (ceilingRule). */
export const FALSE_RED_BUDGET = 0.02

/** The standard normal's `p` quantile: Acklam's rational fit, relative error under 1.2e-9. */
export function normalQuantile(p: number): number {
	const a = [
		-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239,
	]
	const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
	const c = [
		-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968,
		2.938163982698783,
	]
	const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
	const poly = (k: readonly number[], x: number) => k.reduce((sum, each) => sum * x + each, 0)
	const tail = (q: number) => {
		const t = Math.sqrt(-2 * Math.log(q))
		return poly(c, t) / (poly(d, t) * t + 1)
	}
	if (p < 0.02425) return tail(p)
	if (p > 1 - 0.02425) return -tail(1 - p)
	const q = p - 0.5
	return (poly(a, q * q) * q) / (poly(b, q * q) * q * q + 1)
}

/** The regularized lower incomplete gamma P(s, x): its series below s + 1, its continued fraction above. */
function gammaP(s: number, x: number): number {
	if (x <= 0) return 0
	const scale = Math.exp(-x + s * Math.log(x) - logGamma(s))
	if (x < s + 1) {
		let term = 1 / s
		let sum = term
		for (let k = 1; k < 1000 && Math.abs(term) > Math.abs(sum) * 1e-15; k++) {
			term *= x / (s + k)
			sum += term
		}
		return sum * scale
	}
	let [b, c, d] = [x + 1 - s, 1e300, 1 / (x + 1 - s)]
	let h = d
	for (let i = 1; i < 1000; i++) {
		const an = -i * (i - s)
		b += 2
		d = 1 / (Math.abs(an * d + b) < 1e-300 ? 1e-300 : an * d + b)
		c = Math.abs(b + an / c) < 1e-300 ? 1e-300 : b + an / c
		h *= d * c
		if (Math.abs(d * c - 1) < 1e-15) break
	}
	return 1 - scale * h
}

/** log Γ(s) for s > 0, Lanczos (g = 7, nine terms). */
function logGamma(s: number): number {
	const k = [
		0.9999999999998099, 676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
		12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
	]
	const x = s - 1
	const sum = k.slice(1).reduce((total, each, i) => total + each / (x + i + 1), k[0] as number)
	const t = x + 7.5
	return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(sum)
}

/** Chi-square's `p` quantile at `df` degrees of freedom, by bisection on its CDF P(df / 2, x / 2). */
export function chiSquareQuantile(p: number, df: number): number {
	let [lo, hi] = [0, Math.max(1, df * 10)]
	while (gammaP(df / 2, hi / 2) < p) hi *= 2
	for (let i = 0; i < 200; i++) {
		const mid = (lo + hi) / 2
		if (gammaP(df / 2, mid / 2) < p) lo = mid
		else hi = mid
	}
	return (lo + hi) / 2
}

/**
 * The floor over a cell's worst recorded run (plan 37). A log-normal tail fit cannot predict a CPU-model or
 * runner-class swing, and three judged reds landed on unchanged code over a 1.10 floor: Node 22 surface x workers at
 * 1.105x its pool's worst (41473514566), stream-1mb at 1.13x (40991615047) and finalize 500x50 at 1.25x (41480554092).
 * The largest, plus 0.10, rounded up to 0.05: a cell reds only past 35% over its worst run, which its `catches` says.
 * The same-runner A/B gate is what tightens these again.
 */
export const WORST_MARGIN = 1.35

/**
 * One cell's ceiling among `cells` derived ones (bit 21's rule, both baselines): fit log(ratio), mean m and sample
 * sd s; bound s from above at 90% one-sided, s x sqrt((n - 1) / chi2_0.10,n-1), since a dozen runs leave s itself
 * uncertain; take z = Phi^-1(1 - FALSE_RED_BUDGET / cells). The ceiling is the higher of exp(m + z x that bound) and
 * the worst x WORST_MARGIN, which keeps it above every observed run plus a margin.
 */
export function ceilingRule(ratios: readonly number[], cells: number): number {
	const logs = ratios.map(Math.log)
	const n = logs.length
	const mean = logs.reduce((sum, each) => sum + each, 0) / n
	const sd = Math.sqrt(logs.reduce((sum, each) => sum + (each - mean) ** 2, 0) / (n - 1))
	const upper = sd * Math.sqrt((n - 1) / chiSquareQuantile(0.1, n - 1))
	return Math.max(
		Math.max(...ratios) * WORST_MARGIN,
		Math.exp(mean + normalQuantile(1 - FALSE_RED_BUDGET / cells) * upper),
	)
}
