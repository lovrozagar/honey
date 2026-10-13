import { describe, expect, it } from "vitest"
import { halfWidth, judge, median } from "./significance.ts"

/* five interleaved ratio samples around `center`, spread ±`spread` */
const around = (center: number, spread: number) => [
	center - spread,
	center - spread / 2,
	center,
	center + spread / 2,
	center + spread,
]

describe("median and the 95% half-width", () => {
	it("takes the middle sample, or the mean of the two middle ones", () => {
		expect(median([3, 1, 2])).toBe(2)
		expect(median([4, 1, 3, 2])).toBe(2.5)
	})

	it("uses Student's t for small samples and 1.96 past the table", () => {
		/* n = 5: s = 0.0790569, t(0.975, 4) = 2.776 → 2.776 · s / √5 */
		expect(halfWidth(around(2, 0.1))).toBeCloseTo(0.098149, 5)
		const many = Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? 1.9 : 2.1))
		const s = Math.sqrt((50 * 0.01) / 49)
		expect(halfWidth(many)).toBeCloseTo((1.96 * s) / Math.sqrt(50), 6)
	})

	it("needs at least two samples", () => {
		expect(() => halfWidth([2])).toThrow(/at least two samples/)
	})
})

describe("judge: fail only beyond +10% and outside the sample band", () => {
	it("passes a run inside the threshold", () => {
		expect(judge(around(2.1, 0.02), 2, 0.1)).toMatchObject({ limit: 2.2, ratio: 2.1, status: "ok" })
	})

	it("passes an improvement", () => {
		expect(judge(around(1.6, 0.02), 2, 0.1).status).toBe("ok")
	})

	it("fails a tight run past +10%", () => {
		const verdict = judge(around(2.3, 0.02), 2, 0.1)
		expect(verdict.status).toBe("regressed")
		expect(verdict.ratio).toBeCloseTo(2.3, 10)
		expect(verdict.limit).toBeCloseTo(2.2, 10)
	})

	it("calls a run past +10% noise when the rise is inside the sample band", () => {
		/* rise 0.3 over baseline, but the band is ±0.59: residual jitter, not a regression */
		const verdict = judge(around(2.3, 0.6), 2, 0.1)
		expect(verdict.status).toBe("noise")
		expect(verdict.halfWidth).toBeGreaterThan(0.3)
	})

	it("reports a scenario with no baseline as unbaselined, never failed", () => {
		expect(judge(around(5, 0.1), undefined, 0.1)).toMatchObject({ limit: null, status: "unbaselined" })
	})
})
