/**
 * When a build-gate cell's honey-free reference is timed (tests/e2e/build-window.ts, bit 21 bref), driven by a fake
 * clock on the two CI jobs that redded unchanged code at 5f2942e: a runner that slowed after the reference was taken
 * (40965667478) and a reference that read fast once (40969532154). Each cell times its reference around its own
 * builds, so both cancel; a slower honey still reds.
 */
import { describe, expect, it } from "vitest"
import * as gate from "../e2e/build-gate.ts"
import { cellMeter } from "../e2e/build-window.ts"
import { REFERENCE_WORK } from "../e2e/reference/vite.config.ts"

/* node 22's ceilings at 5f2942e (blueprint/baselines/build.json), the ones both jobs were judged against */
const CEILINGS: Record<string, [baseline: number, ceiling: number]> = {
	"compose×bun": [25.52, 28.97],
	"compose×cloudflare": [25.66, 28.74],
	"defaults×bun": [25.27, 29.05],
	"defaults×cloudflare": [25.2, 28.41],
	"gateway×bun": [26.23, 29.44],
	"gateway×cloudflare": [25.84, 29.02],
	"kitchen×bun": [26.62, 30.84],
	"kitchen×cloudflare": [26.46, 29.82],
	"mcp×bun": [14.2, 16.35],
	"mcp×cloudflare": [14.22, 16.7],
	"surface×bun": [27.31, 31.47],
	"surface×cloudflare": [26.95, 30.6],
}
const APPS = ["compose", "defaults", "gateway", "kitchen", "mcp", "surface"] as const

/* a build's own noise, cycled call by call: ±0.8%, about the app builds' median spread on CI */
const JITTER = [1, 1.008, 0.994, 1.004, 0.997]

/**
 * A fake runner on a clock: every build takes its nominal ms x the runner's speed at the moment it starts x the
 * jitter, and moves the clock on by that. `referenceSpeed` scales the reference build alone.
 */
function fakeRunner(runner: {
	referenceMs: number
	referenceSpeed?: (now: number) => number
	speed?: (now: number) => number
}) {
	let now = 0
	let calls = 0
	const order: string[] = []
	const take = (ms: number, factor: number) => {
		const took = ms * factor * (runner.speed?.(now) ?? 1) * (JITTER[calls++ % JITTER.length] as number)
		now += took
		return took
	}
	return {
		build: (ms: number) => async () => {
			order.push("B")
			return { code: 0, ms: take(ms, 1), output: "" }
		},
		order,
		reference: async () => {
			order.push("R")
			return take(runner.referenceMs, runner.referenceSpeed?.(now) ?? 1)
		},
	}
}

/** One job's cells built in turn on `runner`, each judged on Actions against CEILINGS: the cells that fail. */
async function redCells(runner: ReturnType<typeof fakeRunner>, target: string, ms: Record<string, number>) {
	const meter = cellMeter(runner.reference)
	const red: string[] = []
	for (const app of APPS) {
		const cell = `${app}×${target}`
		const window = await meter(target, runner.build(ms[app] as number))
		if ("failed" in window) throw new Error(`${cell} failed`)
		const [baseline, ceiling] = CEILINGS[cell] as [number, number]
		const verdict = gate.judgeBuild({
			builds: window.builds,
			ceiling: { baseline, byClass: {}, catches: "", ceiling },
			mode: "judge",
			referenceMs: gate.median(window.references),
			runtime: "node",
		})
		if (verdict.status !== "ok") red.push(`${cell} ${verdict.ratio}`)
	}
	return red
}

/*
 * 40965667478's build (node) ×cloudflare cells: each build's median there, surface×cloudflare's at its other runs'
 * ~6,500 ms (6,501, 6,479, 6,587), and the reference at those runs' 230 ms
 */
const SLOWED = { compose: 6_041, defaults: 6_015, gateway: 6_148, kitchen: 6_364, mcp: 3_454, surface: 6_500 }
/* the runner turns 14% slower when surface×cloudflare starts on today's order: 7,446 / 6,500 = 1.146 in that job */
const SLOW_AT = 6 * 230 + 3 * (6_041 + 6_015 + 6_148 + 6_364 + 3_454)

/* 40969532154's build (node) ×bun cells, and the reference at the other runs' low end, 164 ms (that job read 149) */
const FAST_REF = { compose: 4_072, defaults: 3_869, gateway: 3_917, kitchen: 4_237, mcp: 2_461, surface: 4_564 }

/*
 * The reference's spread within a cell window against the app builds' at each REFERENCE_WORK size, on this machine
 * under the heavy lock (bit 21 bref): the median over 36 windows a runtime (every cell, twice) of each window's
 * (max-min)/median in %, the reference's over its 4 three-sample subsets so both count three samples
 */
type Spread = { bun: number; node: number }
const BUILDS_SPREAD: Spread = { bun: 3.2, node: 3.3 }
const REFERENCE_SPREAD: Record<number, Spread> = {
	0: { bun: 6.1, node: 7.4 },
	5_000: { bun: 5, node: 4.9 },
	7_500: { bun: 3.8, node: 3.4 },
	10_000: { bun: 3.3, node: 2.9 },
	15_000: { bun: 1.9, node: 2.1 },
}

describe("the e2e build gate's reference window", () => {
	it("times a cell as ref, build, ref, build, ref, build, ref, after one untimed reference warm-up a target", async () => {
		const runner = fakeRunner({ referenceMs: 100 })
		const meter = cellMeter(runner.reference)
		await meter("node", runner.build(1_000))
		await meter("node", runner.build(1_000))
		/* the first cell: warm-up, then RBRBRBR; the second: RBRBRBR */
		expect(runner.order.join("")).toBe("RRBRBRBRRBRBRBR")
	})

	it("passes a runner slowing 14% partway through the job (CI 40965667478, surface×cloudflare red at 31.87)", async () => {
		const runner = fakeRunner({ referenceMs: 230, speed: (now) => (now >= SLOW_AT ? 1.14 : 1) })
		expect(await redCells(runner, "cloudflare", SLOWED)).toEqual([])
	})

	it("passes a reference that reads 10% fast once (CI 40969532154, mcp×bun red at 16.54)", async () => {
		const runner = fakeRunner({ referenceMs: 164, referenceSpeed: (now) => (now < 1_200 ? 0.9 : 1) })
		expect(await redCells(runner, "bun", FAST_REF)).toEqual([])
	})

	it("sizes the reference's work at the smallest size measured spreading no wider than the builds on either runtime", () => {
		const fits = ([size]: [string, Spread]) => {
			const spread = REFERENCE_SPREAD[Number(size)] as Spread
			return spread.node <= BUILDS_SPREAD.node && spread.bun <= BUILDS_SPREAD.bun
		}
		expect(REFERENCE_WORK).toBe(Number(Object.entries(REFERENCE_SPREAD).find(fits)?.[0]))
	})

	it("reds app builds 1.2x slower in every sample, the reference unchanged: every cell", async () => {
		const at = (factor: number) =>
			Object.fromEntries(APPS.map((app) => [app, (CEILINGS[`${app}×bun`] as [number, number])[0] * 164 * factor]))
		const [steady, slower] = [
			await redCells(fakeRunner({ referenceMs: 164 }), "bun", at(1)),
			await redCells(fakeRunner({ referenceMs: 164 }), "bun", at(1.2)),
		]
		expect([steady, slower.map((each) => each.split(" ")[0])]).toEqual([[], APPS.map((app) => `${app}×bun`)])
	})
})
