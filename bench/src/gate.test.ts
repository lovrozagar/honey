import { describe, expect, it } from "vitest"
import { ceilingsOf, exitCode, modeOf, ratioLine, RECORD_LABEL, rowOf } from "./gate.ts"

/* finalize 100x10 on CI's bun 1.3, from blueprint/baselines/bench.json: its CI median and its ceiling */
const own = ceilingsOf("finalize", "bun 1.3")?.["100x10"]
/* seeded ratios: samples tightly around 3.2 (past the CI median, under the ceiling) and around 4.2 (over it) */
const around = (ratio: number) => [-0.01, 0, 0.01, 0, -0.01, 0, 0.01, 0, 0].map((d) => ratio + d)
const under = rowOf("100x10", around(3.2), own).status
const over = rowOf("100x10", around(4.2), own).status

describe("the gate's two modes", () => {
	it("judges by default and records only under BENCH_MODE=record", () => {
		expect([modeOf({}), modeOf({ BENCH_MODE: "judge" }), modeOf({ BENCH_MODE: "record" })]).toEqual([
			"judge",
			"judge",
			"record",
		])
	})

	it("fails a judged run on a regressed scenario, never a recorded one, and never an unbaselined one", () => {
		expect([
			over,
			exitCode("judge", true, ["ok", over]),
			exitCode("record", true, ["ok", over]),
			exitCode("judge", false, ["ok", over]),
			exitCode("judge", true, ["ok", under]),
		]).toEqual(["REGRESSED", 1, 0, 0, 0])
	})

	it("prints one parseable ratio line per scenario, and names record mode as not a gate", () => {
		expect([ratioLine("finalize", "100x10", 2.05), RECORD_LABEL]).toEqual([
			"RATIO finalize 100x10 2.05",
			"record mode, not gating",
		])
	})
})

describe("the judge reads its ceilings from bench.json (bit 20 e3)", () => {
	it("holds finalize 100x10's CI median and ceiling for bun 1.3", () => {
		expect([own?.baseline, own?.ceiling]).toEqual([2.785, 3.773])
	})

	it("passes a ratio past the CI median but under the ceiling, and fails one above the ceiling", () => {
		expect([under, over, rowOf("100x10", around(3.2), undefined).status]).toEqual(["ok", "REGRESSED", "unbaselined"])
	})

	it("prints a reportOnly scenario over its ceiling without failing the run, while a blocking one still fails it", () => {
		/* adapter post-1kib, bimodal on CI (bench.json's reason), against finalize 100x10 over its ceiling */
		const postOwn = ceilingsOf("adapter", "node 26.12")?.["post-1kib"]
		const post = rowOf("post-1kib", around(6.2), postOwn).status
		expect([postOwn?.reportOnly, postOwn?.ceiling, post]).toEqual([true, 5.17, "report-only: over"])
		expect([exitCode("judge", true, ["ok", post]), exitCode("judge", true, [post, over])]).toEqual([0, 1])
	})
})
