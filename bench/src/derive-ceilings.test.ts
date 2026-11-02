import { describe, expect, it } from "vitest"
import KNOWN_REDS from "../../packages/core/tests/structure/fixtures/known-perf-reds.json" with { type: "json" }
import { type BenchRun, deriveBenches, modelOf, parseBenchLog, poolOf } from "./derive-ceilings.ts"

/* the lines a hot-path benchmark job's log carries, as gh prints them: job, step, timestamp, text */
const LOG = [
	"hot-path benchmark\tCPU\t2026-11-02T17:44:52.5811218Z model name\t: AMD EPYC 9V45 96-Core Processor",
	"hot-path benchmark\tbench\t2026-11-02T17:48:17.6198146Z RATIO finalize 100x10 3.13",
	"hot-path benchmark\tbench\t2026-11-02T17:48:17.6198399Z RATIO finalize 500x50 0.82",
	"hot-path benchmark\tbench\t2026-11-02T17:48:24.5088350Z RATIO streaming stream-1mb 1.71",
	"hot-path benchmark\tbench\t2026-11-02T17:48:24.6Z streaming: record refused: stream-1mb spread 0.546 > 0.5.",
].join("\n")

/** One run of a bench, its scenario at `ratio`, on `model`, its code `key`. */
const run = (id: number, bench: string, scenario: string, ratio: number, model = "EPYC 7763", key = "a"): BenchRun => ({
	keys: { [bench]: key },
	log: { model, ratios: [{ bench, ratio, scenario }], refused: [] },
	run: String(id),
})

const CPU_REASON =
	"its level differs by CPU model (per-model medians: EPYC 7763 0.880); a ratio cancels runner speed, not microarchitecture, so this pooled ceiling covers every model and catches only +107% on the lowest one."

describe("the bench derive's reading of a CI log", () => {
	it("takes the CPU model, every RATIO line and the refused benches", () => {
		expect(parseBenchLog(LOG)).toEqual({
			model: "EPYC 9V45",
			ratios: [
				{ bench: "finalize", ratio: 3.13, scenario: "100x10" },
				{ bench: "finalize", ratio: 0.82, scenario: "500x50" },
				{ bench: "streaming", ratio: 1.71, scenario: "stream-1mb" },
			],
			refused: ["streaming"],
		})
	})

	it("names each CPU model GitHub hands out, and an older log with no model unclassed", () => {
		expect([
			modelOf("INTEL(R) XEON(R) PLATINUM 8573C"),
			modelOf("Intel(R) Xeon(R) 6973P-C"),
			modelOf("AMD EPYC 7763 64-Core Processor"),
			parseBenchLog("RATIO hotpath chain 1.89").model,
		]).toEqual(["Xeon 8573C", "Xeon 6973P-C", "EPYC 7763", "unclassed"])
	})
})

describe("the bench derive's pools and ceilings", () => {
	it("pools the runs of the newest code alone: an edit to the bench or the gate starts a new pool", () => {
		const runs = [1, 2, 3].map((id) => run(id, "finalize", "500x50", 1, "EPYC 7763", id === 1 ? "old" : "new"))
		expect(poolOf(runs, "finalize").map((each) => each.run)).toEqual(["2", "3"])
	})

	it("refuses a bench whose newest code has fewer than six runs, and writes it no ceiling", () => {
		const current = { finalize: { "bun 1.3": { "500x50": { baseline: 1, catches: "+0%", ceiling: 1 } } } }
		const runs = [1, 2, 3, 4, 5].map((id) => run(id, "finalize", "500x50", 1))
		expect(deriveBenches(current, runs)).toEqual({
			benches: {},
			refused: ["finalize: 5 runs on its newest code, fewer than 6"],
			used: [],
		})
	})

	it("rewrites a CPU-model reason from the new pool and keeps reportOnly and any other reason", () => {
		const current = {
			finalize: {
				"bun 1.3": {
					"500x50": {
						baseline: 1,
						catches: "+0%",
						ceiling: 1,
						reason: `bimodal; ${CPU_REASON}`,
						reportOnly: true as const,
					},
				},
			},
		}
		const runs = [1, 1, 1, 1.1, 1.1, 1.1].map((ratio, i) =>
			run(i, "finalize", "500x50", ratio, ratio === 1 ? "EPYC 7763" : "EPYC 9V74"),
		)
		const derived = deriveBenches(current, runs).benches.finalize?.["bun 1.3"]?.["500x50"]
		/* the worst, 1.1, x 1.35 is 1.485, over the log-normal tail's 1.267; on the lowest model's median, 1: +49% */
		expect(derived).toEqual({
			baseline: 1.05,
			catches: "+41%",
			ceiling: 1.485,
			reason:
				"bimodal; its level differs by CPU model (per-model medians: EPYC 7763 1.000, EPYC 9V74 1.100); a ratio cancels runner speed, not microarchitecture, so this pooled ceiling covers every model and catches only +49% on the lowest one.",
			reportOnly: true,
		})
	})

	/* the two bench reds on unchanged code, each over the ceiling its own 24-run pool gave under the old 1.10 floor */
	it.each(
		KNOWN_REDS.filter(({ cell }) => cell.startsWith("bench ")).map(
			({ cell, pool, red, run: id }) => [cell, red, id, pool] as const,
		),
	)("holds %s's red %s (run %s) under the ceiling its pool now gives", (cell, red, _, pool) => {
		const [, bench, scenario] = cell.split(" ") as [string, string, string]
		const current = { [bench]: { "bun 1.3": { [scenario]: { baseline: 1, catches: "+0%", ceiling: 1 } } } }
		const runs = pool.map((ratio, i) => run(i, bench, scenario, ratio))
		const ceiling = deriveBenches(current, runs).benches[bench]?.["bun 1.3"]?.[scenario]?.ceiling ?? 0
		expect(red).toBeLessThan(ceiling)
	})
})
