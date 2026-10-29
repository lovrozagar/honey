/**
 * The e2e build gate's judge on one cell's builds (tests/e2e/build-gate.ts, bit 21 cfb), from CI run 40877110861's
 * own numbers: the median of BUILD_SAMPLES builds against one spiked build, the report-only interim a re-record runs
 * under, and the ratio judged on GitHub Actions only. e2e-builds.test.ts holds the gate's ratio, hang guard, record
 * lines and derives.
 */
import { describe, expect, it } from "vitest"
import * as gate from "../e2e/build-gate.ts"
import { BUILD_SPECS } from "../e2e/builds.ts"

const KEY = "bun 1.3"
/*
 * CI run 40877110861's build (bun) job, the one false red of k=1: the cloudflare reference 139 ms; defaults×cloudflare
 * built once in 2,949 ms (ratio 21.21) where compose×cloudflare took 2,472 and gateway×cloudflare 2,501, siblings that
 * track it within a few %. Its normal build there is its CI median 17.84 x 139 = 2,480 ms; blueprint/baselines/build.json
 * held it to 20.98. Honey generate is ~90% of a build (this machine's surface: 1,286 of 1,421 ms).
 */
const RED_JOB = {
	ceiling: { baseline: 17.84, byClass: {}, catches: "+18%", ceiling: 20.98 },
	normal: 2_480,
	ref: 139,
	spike: 2_949,
}
const onRedJob = (builds: number[]) =>
	gate.judgeBuild({ builds, ceiling: RED_JOB.ceiling, mode: "judge", referenceMs: RED_JOB.ref, runtime: "bun" })

describe("the e2e build gate's median of three builds", () => {
	it("passes one spiked build of three: CI 40877110861's 2,949 ms beside two normal ones", () => {
		expect(onRedJob([RED_JOB.spike, RED_JOB.normal, RED_JOB.normal - 10])).toEqual({
			failures: [],
			hung: false,
			ratio: 17.84,
			status: "ok",
		})
	})

	it("reds two spiked builds of three: a slowdown that holds is no outlier", () => {
		/* 2,949 / 139 = 21.22 here; CI printed 21.21 from the unrounded ms */
		expect(onRedJob([RED_JOB.spike, RED_JOB.normal, RED_JOB.spike + 11]).failures).toEqual([
			"build ratio 21.22 over its 20.98 ceiling (CI median 17.84)",
		])
	})

	it("reds honey generate made 1.5x slower in all three builds", () => {
		const slower = RED_JOB.normal * 0.9 * 1.5 + RED_JOB.normal * 0.1
		expect(onRedJob([slower, slower + 15, slower - 15])).toMatchObject({ ratio: 25.87, status: "REGRESSED" })
	})

	it("holds every build to the hang guard: one runaway build of three reds, whatever the median", () => {
		expect(onRedJob([8_001, RED_JOB.normal, RED_JOB.normal]).failures).toEqual([
			"built in 8001ms, over the 8000ms hang guard on bun",
		])
	})

	it("builds each cell BUILD_SAMPLES = 3 times", () => {
		expect(gate.BUILD_SAMPLES).toBe(3)
	})
})

describe("the e2e build gate's report-only interim", () => {
	it("refuses a baseline whose ceilings are emptied for a re-record, as it refuses no baseline", () => {
		const reportOnly = { builds: {}, note: "report-only from <sha> for the k=3 re-record", runs: [] }
		const cells = BUILD_SPECS.map((spec) => spec.id)
		expect(gate.missingCeilings(reportOnly, ["bun 1.3", "node 22"], cells)).toEqual(
			gate.missingCeilings(undefined, ["bun 1.3", "node 22"], cells),
		)
		expect(gate.missingCeilings(reportOnly, ["bun 1.3"], cells)).toHaveLength(cells.length)
	})

	it("judges no cell against an emptied baseline: each reads unbaselined, never failing", () => {
		const emptied: gate.BuildBaseline = { builds: {}, note: "", runs: [] }
		const ceiling = emptied.builds[KEY]?.["defaults×cloudflare"]
		const builds = [RED_JOB.spike, RED_JOB.spike, RED_JOB.spike]
		expect([
			gate.recordedCells(emptied),
			gate.judgeBuild({ builds, ceiling, mode: "judge", referenceMs: RED_JOB.ref, runtime: "bun" }).status,
		]).toEqual([0, "unbaselined"])
	})
})

/* the ratio's ceilings are CI's, so only an Actions runner judges it; the hang guard judges anywhere */
const ON_ACTIONS = { GITHUB_ACTIONS: "true" }
const OFF_ACTIONS = { CI: "true", HOME: "/home/dev" } /* a bare CI=true, as other local tools export, is not Actions */
const overCeiling = [RED_JOB.spike, RED_JOB.spike, RED_JOB.spike] /* 21.22 over its 20.98 */
const inEnv = (env: Record<string, string>, builds: number[]) =>
	gate.judgeBuild({
		builds,
		ceiling: RED_JOB.ceiling,
		mode: gate.modeOf(env),
		referenceMs: RED_JOB.ref,
		runtime: "bun",
	})

describe("the e2e build gate's ratio judges on GitHub Actions only", () => {
	it("never reds on the ratio off Actions, even over its ceiling: it reads report-only", () => {
		expect(inEnv(OFF_ACTIONS, overCeiling)).toEqual({ failures: [], hung: false, ratio: 21.22, status: "report-only" })
	})

	it("reds over the ceiling on an Actions runner (GITHUB_ACTIONS=true)", () => {
		expect(inEnv(ON_ACTIONS, overCeiling).failures).toEqual([
			"build ratio 21.22 over its 20.98 ceiling (CI median 17.84)",
		])
	})

	it("holds the hang guard in both", () => {
		const runaway = [8_001, RED_JOB.normal, RED_JOB.normal]
		expect([inEnv(OFF_ACTIONS, runaway).failures, inEnv(ON_ACTIONS, runaway).failures]).toEqual([
			["built in 8001ms, over the 8000ms hang guard on bun"],
			["built in 8001ms, over the 8000ms hang guard on bun"],
		])
	})

	it("reads the mode from the explicit signals alone: record wins, then Actions, else local", () => {
		const modes = [
			{},
			OFF_ACTIONS,
			{ GITHUB_ACTIONS: "false" },
			ON_ACTIONS,
			{ ...ON_ACTIONS, BUILD_MODE: "record" },
			{ BUILD_MODE: "record" },
		]
		expect(modes.map((env) => gate.modeOf(env))).toEqual(["local", "local", "local", "judge", "record", "record"])
	})
})
