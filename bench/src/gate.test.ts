import { describe, expect, it } from "vitest"
import { exitCode, modeOf, ratioLine, RECORD_LABEL } from "./gate.ts"
import { judge } from "./significance.ts"

/* a seeded over-tolerance ratio: samples tightly around 2.5 against a 2.0 baseline at +10% */
const over = judge([2.49, 2.5, 2.51, 2.5, 2.49, 2.5, 2.51, 2.5, 2.5], 2, 0.1).status
const status = over === "regressed" ? "REGRESSED" : over

describe("the gate's two modes (bit 20 e2)", () => {
	it("judges by default and records only under BENCH_MODE=record", () => {
		expect([modeOf({}), modeOf({ BENCH_MODE: "judge" }), modeOf({ BENCH_MODE: "record" })]).toEqual([
			"judge",
			"judge",
			"record",
		])
	})

	it("fails a judged run on a regressed scenario, never a recorded one, and never an unbaselined one", () => {
		expect([
			status,
			exitCode("judge", true, ["ok", status]),
			exitCode("record", true, ["ok", status]),
			exitCode("judge", false, ["ok", status]),
			exitCode("judge", true, ["ok", "noise"]),
		]).toEqual(["REGRESSED", 1, 0, 0, 0])
	})

	it("prints one parseable ratio line per scenario, and names record mode as not a gate", () => {
		expect([ratioLine("finalize", "100x10", 2.05), RECORD_LABEL]).toEqual([
			"RATIO finalize 100x10 2.05",
			"record mode, gating at e3",
		])
	})
})
