import { describe, expect, it } from "vitest"
import {
	type Ceiling,
	ceilingsOf,
	type Clock,
	exitCode,
	measure,
	modeOf,
	PASSES,
	passesOf,
	ratioLine,
	RECORD_LABEL,
	ROUND_FLOOR_MS,
	rowOf,
	type Scenario,
	SPREAD_TOLERANCE,
	unsteady,
} from "./gate.ts"

/* finalize 100x10 on CI's bun 1.3, from blueprint/baselines/bench.json: its CI median and its ceiling */
const own = ceilingsOf("finalize", "bun 1.3")?.["100x10"]
/* seeded ratios, one pass of them: samples tightly around 3.2 (past the CI median, under the ceiling) and 4.2 (over it) */
const around = (ratio: number) => [[-0.01, 0, 0.01, 0, -0.01, 0, 0.01, 0, 0].map((d) => ratio + d)]
const under = rowOf("100x10", around(3.2), own).status
const over = rowOf("100x10", around(4.2), own).status
/* a report row with only what exitCode reads: its status and its pass spread */
const row = (status: string, spread = 0) => ({ ratio: 1, scenario: "s", spread, status })

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
			exitCode("judge", true, [row("ok"), row(over)]),
			exitCode("record", true, [row("ok"), row(over)]),
			exitCode("judge", false, [row("ok"), row(over)]),
			exitCode("judge", true, [row("ok"), row(under)]),
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
		expect([own?.baseline, own?.ceiling]).toEqual([2.505, 4.011])
	})

	it("passes a ratio past the CI median but under the ceiling, and fails one above the ceiling", () => {
		expect([under, over, rowOf("100x10", around(3.2), undefined).status]).toEqual(["ok", "REGRESSED", "unbaselined"])
	})

	it("prints a reportOnly scenario over its ceiling without failing the run, while a blocking one still fails it", () => {
		/* adapter post-1kib, bimodal on CI (bench.json's reason), against finalize 100x10 over its ceiling */
		const postOwn = ceilingsOf("adapter", "node 26.12")?.["post-1kib"]
		const post = rowOf("post-1kib", around(9.2), postOwn).status
		expect([postOwn?.reportOnly, postOwn?.ceiling, post]).toEqual([true, 8.867, "report-only: over"])
		expect([exitCode("judge", true, [row("ok"), row(post)]), exitCode("judge", true, [row(post), row(over)])]).toEqual([
			0, 1,
		])
	})
})

/*
 * bit 21 k-pass: a runner burst as CI meets it, a window of wall time over the run (CI 40913885826: adapter's four
 * scenarios high together, v1 unchanged). The fixture's clock is its own: every timed sample, either side, advances it
 * `step` ms (1 by default) and the round floor's idle advances it too. `burst` covers its first ms: with step 1, PASS of
 * them is one whole pass of A (a k=1 measurement of A, all of it), 2 × PASS one pass of A and one of B. In it v1 costs
 * 1.5× (3 against the 2.2 ceiling); outside it 2, or 2 × slowdown; `drift` adds that much to v1 at each of its calls.
 */
const SAMPLES = 5
const PASS = 2 + 2 * SAMPLES
const CEILING: Ceiling = { baseline: 2, catches: "+10%", ceiling: 2.2 }

type Shape = { drift?: number; slowdown?: number; step?: number; warmup?: number }

function fixture(burst: number, { drift = 0, slowdown = 1, step = 1, warmup }: Shape = {}) {
	let now = 0
	let v1Calls = 0
	const tick = () => {
		const inBurst = now < burst
		now += step
		return inBurst ? 1.5 : 1
	}
	const clock: Clock = {
		now: () => now,
		sleep: async (ms) => {
			now += ms
		},
	}
	const scenarios: Scenario[] = ["A", "B"].map((name) => ({
		name,
		raw: async () => {
			tick()
			return 1
		},
		v1: async () => 2 * slowdown * tick() + drift * v1Calls++,
		warmup,
	}))
	return { clock, scenarios, v1Calls: () => v1Calls }
}

async function rows(passes: number, burst: number, shape: Shape & { floorMs?: number } = {}) {
	const { clock, scenarios } = fixture(burst, shape)
	const { measured } = await measure(scenarios, { clock, floorMs: shape.floorMs, passes, samples: SAMPLES })
	return measured.map((m) => rowOf(m.name, m.passes, CEILING))
}

const statuses = async (passes: number, burst: number, shape: Shape & { floorMs?: number } = {}) =>
	(await rows(passes, burst, shape)).map((r) => r.status)

describe("k passes interleaved across the scenarios, judged on the median of the pass medians (bit 21 k-pass)", () => {
	it("a burst over one pass reds k=1 and leaves PASSES ok, whether it covers one scenario's pass or one of each", async () => {
		expect({
			k1: [await statuses(1, PASS), await statuses(1, 2 * PASS)],
			kPasses: [await statuses(PASSES, PASS), await statuses(PASSES, 2 * PASS)],
		}).toEqual({
			k1: [
				["REGRESSED", "ok"],
				["REGRESSED", "REGRESSED"],
			],
			kPasses: [
				["ok", "ok"],
				["ok", "ok"],
			],
		})
	})

	it("still reds a real 1.15x v1 slowdown on every pass at PASSES, with or without a burst", async () => {
		expect([
			await statuses(PASSES, 0, { slowdown: 1.15 }),
			await statuses(PASSES, 2 * PASS, { slowdown: 1.15 }),
		]).toEqual([
			["REGRESSED", "REGRESSED"],
			["REGRESSED", "REGRESSED"],
		])
	})

	it("a 2 s burst over two 1.2 s rounds reds A without the round floor and leaves both ok with ROUND_FLOOR_MS", async () => {
		/* 50 ms a sample: a pass is 600 ms, a round of A and B 1.2 s, adapter's on CI; the burst covers rounds 1 and 2 */
		expect([
			await statuses(PASSES, 2000, { floorMs: 0, step: 50 }),
			await statuses(PASSES, 2000, { step: 50 }),
		]).toEqual([
			["REGRESSED", "ok"],
			["ok", "ok"],
		])
	})
})

describe("a record run refuses a scenario whose pass medians disagree (bit 21 k-pass)", () => {
	it("refuses a drifting scenario past SPREAD_TOLERANCE, records a steady one, and never judges on spread", async () => {
		/* v1 grows 0.15 a call (A and B share the count): pass spreads 0.7-0.85, as the echo drifted in its bench (0.91-1.46) */
		const drifting = await rows(PASSES, 0, { drift: 0.15 })
		const steady = await rows(PASSES, 0)
		expect({
			judged: exitCode(
				"judge",
				true,
				drifting.map((r) => ({ ...r, status: "ok" })),
			),
			refused: unsteady(drifting),
			runs: [exitCode("record", true, drifting), exitCode("record", true, steady)],
			tolerance: SPREAD_TOLERANCE,
		}).toEqual({
			judged: 0,
			refused: ["A spread 0.847 > 0.5", "B spread 0.699 > 0.5"],
			runs: [1, 0],
			tolerance: 0.5,
		})
	})
})

describe("the passes behind it: their count, warm-up, floor, override and band (bit 21 k-pass)", () => {
	it("takes PASSES passes of SAMPLES samples from every scenario and keeps every v1 and raw cost", async () => {
		const { clock, scenarios } = fixture(0)
		const [a] = (await measure(scenarios, { clock, passes: PASSES, samples: SAMPLES })).measured
		expect([PASSES, a?.passes.length, a?.passes[0]?.length, a?.v1.length, a?.raw.length]).toEqual([
			3,
			3,
			SAMPLES,
			3 * SAMPLES,
			3 * SAMPLES,
		])
	})

	it("runs a scenario's warm-up pairs once before its first pass, and idles every round but the last to the floor", async () => {
		const { clock, scenarios, v1Calls } = fixture(0, { warmup: 4 })
		const three = await measure(scenarios, { clock, passes: 3, samples: SAMPLES })
		const one = await measure(fixture(0).scenarios, { clock: fixture(0).clock, passes: 1, samples: SAMPLES })
		/* each scenario: 4 warm-up v1 calls, then per pass 1 + SAMPLES; a round of A and B is 4 × 6 = 24 ms */
		expect([v1Calls(), three.idleMs, one.idleMs, ROUND_FLOOR_MS]).toEqual([2 * (4 + 3 * 6), 2 * (2600 - 24), 0, 2600])
	})

	it("reads BENCH_PASSES as a positive integer, PASSES when unset, and refuses anything else", () => {
		expect([passesOf({}), passesOf({ BENCH_PASSES: "1" }), passesOf({ BENCH_PASSES: "5" })]).toEqual([PASSES, 1, 5])
		for (const bad of ["0", "-1", "2.5", "three", ""]) {
			expect(() => passesOf({ BENCH_PASSES: bad })).toThrow(`BENCH_PASSES must be a positive integer, got "${bad}"`)
		}
	})

	it("bands and spreads the pass medians when there are several, and one pass's own samples when it is alone", () => {
		/* medians 2, 3, 2: mean 2.33, sd 0.577, t(2) 4.303, so ±1.43, spread (3 - 2) / 2; one pass has spread 0 */
		const passes = [
			[2, 2],
			[3, 3],
			[2, 2],
		]
		expect([rowOf("x", passes, CEILING), rowOf("x", [[2, 3, 2]], CEILING)]).toEqual([
			{ band: "±1.43", baseline: 2, ceiling: 2.2, ratio: 2, scenario: "x", spread: 0.5, status: "ok" },
			{ band: "±1.43", baseline: 2, ceiling: 2.2, ratio: 2, scenario: "x", spread: 0, status: "ok" },
		])
	})
})
