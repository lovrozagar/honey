/**
 * The hot-path gate's decision (00-rules "Perf gate", step 2): a scenario regressed only when its
 * median ratio is past the threshold over baseline AND its rise over baseline is outside the 95%
 * confidence band of its own samples. A real slowdown on a quiet runner fails; residual jitter
 * on a noisy one does not, and shows up as `noise` instead of a silent pass.
 */

/* Student's t, two-sided 95%, for 1..30 degrees of freedom; past the table the normal 1.96 */
const T_975 = [
	12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11,
	2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
]

export type Verdict = {
	halfWidth: number
	/** baseline × (1 + threshold); null when the scenario has no baseline */
	limit: number | null
	ratio: number
	status: "noise" | "ok" | "regressed" | "unbaselined"
}

export function median(values: readonly number[]): number {
	const sorted = values.toSorted((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/** Half-width of the 95% confidence interval of the samples' mean. */
export function halfWidth(samples: readonly number[]): number {
	const n = samples.length
	if (n < 2) throw new Error("a confidence band needs at least two samples")
	const mean = samples.reduce((sum, x) => sum + x, 0) / n
	const variance = samples.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (n - 1)
	return ((T_975[n - 2] ?? 1.96) * Math.sqrt(variance)) / Math.sqrt(n)
}

export function judge(samples: readonly number[], baseline: number | undefined, threshold: number): Verdict {
	const ratio = median(samples)
	const band = halfWidth(samples)
	if (baseline === undefined) return { halfWidth: band, limit: null, ratio, status: "unbaselined" }
	const limit = baseline * (1 + threshold)
	if (ratio <= limit) return { halfWidth: band, limit, ratio, status: "ok" }
	return { halfWidth: band, limit, ratio, status: ratio - baseline > band ? "regressed" : "noise" }
}
