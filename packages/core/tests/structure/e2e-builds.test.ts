/**
 * The e2e build tier's time ceiling (bit 19 j2), per runtime that runs `vite build`: Bun builds in under a third of
 * Node's time, so one shared ceiling would let a Bun regression of 10x through. A seeded slow Bun cell is over
 * Bun's ceiling and still under Node's.
 */
import { describe, expect, it } from "vitest"
import * as builds from "../e2e/builds.ts"

const spec = builds.BUILD_SPECS[0] as builds.BuildSpec
/* a Bun build at 6 s: twice CI's slowest v1 Bun cell (2.8 s), a sixth of Node's ceiling */
const SLOW_BUN_MS = 6_000

describe("the e2e build tier's time ceiling", () => {
	it("holds Bun to its own ceiling: a 6 s Bun build fails it, the same 6 s on Node passes", () => {
		const verdict = (runtime: builds.RuntimeId, ms: number) => builds.overBuildCeiling(spec, runtime, ms)
		expect([verdict("bun", SLOW_BUN_MS), verdict("node", SLOW_BUN_MS), verdict("bun", 2_800)]).toEqual([
			"built in 6000ms, over its 5000ms ceiling on bun",
			null,
			null,
		])
	})

	it("gives every cell the same per-runtime ceilings", () => {
		const ceilings = new Set(builds.BUILD_SPECS.map((each) => JSON.stringify(each.maxBuildMs)))
		expect([...ceilings]).toEqual([JSON.stringify({ bun: 5_000, node: 35_000 })])
	})
})
