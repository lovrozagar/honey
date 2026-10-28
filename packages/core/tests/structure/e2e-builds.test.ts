/**
 * The e2e build tier's time gate (tests/e2e/build-gate.ts, bit 21 cfb), judged as a pure function on injected timings:
 * a cell's build time over a honey-free reference build's, against a ceiling CI records, and an absolute hang guard.
 * Each regression below reds the ratio on CI's fast runner class and on its slow one, which an absolute ceiling
 * cannot both do; the hang guard reds a runaway build in every mode. The ceilings themselves are pending CI's record
 * runs, and are owed before bit 21 closes.
 */
import { describe, expect, it } from "vitest"
import * as gate from "../e2e/build-gate.ts"
import { BUILD_SPECS } from "../e2e/builds.ts"
import { COMPLETE } from "./check-tree.ts"

/*
 * surface×cloudflare on bun 1.3.11 on this machine, under the heavy lock (bit 21 cfb, cfb-cause.md): its honey
 * generate child 1286 ms and its bundle 135 ms (medians of 9), the honey-free reference 96 ms (median of 30)
 */
const LOCAL = { bundle: 135, generate: 1286, reference: 96 }
/* CI's runner classes over this machine: 2.7 s and 5.5 s against 1.42 s here (cfb-cause.md) */
const PROFILES = { fast: 1.9, slow: 3.9 } as const
/* the build's own spread here, slowest over median (1.16, its cold first build): record runs carry that noise */
const SPREADS = [1, 1.02, 1.16] as const

const KEY = "bun 1.3"
const CELL = "surface×cloudflare"

/** One record-mode job on a runner `factor` times this machine, its app build `spread` over its median. */
function recordJob(
	run: number,
	factor: number,
	spread: number,
): { job: string; ratios: gate.RatioRecord[]; run: string } {
	const ms = (LOCAL.generate + LOCAL.bundle) * spread * factor
	const referenceMs = LOCAL.reference * factor
	const ratio = Number((ms / referenceMs).toFixed(2))
	return { job: "build (bun)", ratios: [{ cell: CELL, key: KEY, ms, ratio, referenceMs }], run: String(run) }
}

/* six record runs, three per runner class, each with the measured spread: what a calibration dispatch yields */
const RECORDED = gate.deriveCeilings([
	...SPREADS.map((spread, i) => recordJob(i, PROFILES.fast, spread)),
	...SPREADS.map((spread, i) => recordJob(i + 3, PROFILES.slow, spread)),
])
const CEILING = RECORDED[KEY]?.[CELL]

/** What the hang guard says of a build of `ms` on `runtime` in `mode`, no ceiling recorded. */
const at = (runtime: "bun" | "node", ms: number, mode: "judge" | "record") =>
	gate.judgeBuild({ ceiling: undefined, mode, ms, referenceMs: 100, runtime }).failures

/** The class of a job whose one surface build on `key` took `ms`. */
const job = (ms: number, key = KEY) => gate.jobClass([{ cell: CELL, key, ms, ratio: 15, referenceMs: 100 }])

/** The verdict on a bun build of `ms` here, against a reference of `referenceMs` here, on a runner `factor` slower. */
const judge = (ms: number, referenceMs: number, factor: number, mode: "judge" | "record" = "judge") =>
	gate.judgeBuild({ ceiling: CEILING, mode, ms: ms * factor, referenceMs: referenceMs * factor, runtime: "bun" })

describe("the e2e build gate's ratio", () => {
	it("derives one ceiling from both runner classes: the worst ratio x 1.10, each class's median beside it", () => {
		/* the fast runner's cold 1.16x build (3132 ms) reads as the middle class: a job is classed by its own builds' ms */
		const byClass = { fast: 14.95, middle: 17.17, slow: 15.1 }
		expect(CEILING).toEqual({ baseline: 15.1, byClass, catches: "+25%", ceiling: 18.89 })
	})

	it("passes the unchanged build on either runner class, the 1.16x cold build included", () => {
		const statuses = Object.values(PROFILES).flatMap((factor) =>
			SPREADS.map((spread) => judge((LOCAL.generate + LOCAL.bundle) * spread, LOCAL.reference, factor).status),
		)
		expect(statuses).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"])
	})

	it("reds honey generate made 1.5x slower, on the fast runner class and on the slow one", () => {
		const slower = LOCAL.generate * 1.5 + LOCAL.bundle
		const regressed = "build ratio 21.5 over its 18.89 ceiling (CI median 15.1)"
		/* on the slow class the same build also crosses the hang guard: both checks report, the ratio's independently */
		expect(Object.values(PROFILES).map((factor) => judge(slower, LOCAL.reference, factor))).toEqual([
			{ failures: [regressed], hung: false, ratio: 21.5, status: "REGRESSED" },
			{
				failures: ["built in 8050ms, over the 8000ms hang guard on bun", regressed],
				hung: true,
				ratio: 21.5,
				status: "REGRESSED",
			},
		])
	})

	it("reds a regression slowing every honey app alike, which an app-over-sibling-app ratio passes", () => {
		/* CI's cf-workers prod job on a fast runner, run 40734198419: surface built in 2.7 s, defaults in 2.4 s */
		const sibling = { defaults: 2_400, surface: 2_700 }
		const added = (LOCAL.generate / 2) * PROFILES.fast /* +50% of generation's time, in every app's build alike */
		const local = (ms: number) => ms / PROFILES.fast
		const verdict = judge(local(sibling.surface + added), LOCAL.reference, PROFILES.fast)
		expect({
			honeyFree: verdict.status,
			siblingAfter: Number(((sibling.surface + added) / (sibling.defaults + added)).toFixed(2)),
			siblingBefore: Number((sibling.surface / sibling.defaults).toFixed(2)),
		}).toEqual({ honeyFree: "REGRESSED", siblingAfter: 1.08, siblingBefore: 1.13 })
	})

	it("never judges in record mode or with no recorded ceiling: report-only until CI records one", () => {
		const slower = LOCAL.generate * 1.5 + LOCAL.bundle
		const unbaselined = gate.judgeBuild({
			ceiling: undefined,
			mode: "judge",
			ms: slower,
			referenceMs: LOCAL.reference,
			runtime: "bun",
		})
		expect([judge(slower, LOCAL.reference, 1, "record"), unbaselined]).toEqual([
			{ failures: [], hung: false, ratio: 21.5, status: "recorded" },
			{ failures: [], hung: false, ratio: 21.5, status: "unbaselined" },
		])
	})
})

describe("the e2e build gate's hang guard", () => {
	it("reds a build over its runtime's guard in judge and record mode alike, and holds Bun to its own", () => {
		expect([
			at("bun", 8_001, "judge"),
			at("bun", 8_001, "record"),
			at("node", 8_001, "judge"),
			at("bun", 8_000, "judge"),
		]).toEqual([
			["built in 8001ms, over the 8000ms hang guard on bun"],
			["built in 8001ms, over the 8000ms hang guard on bun"],
			[],
			[],
		])
	})

	it("is each runtime's worst local median x the slow class's 3.9 x its spread, above CI's slowest cell", () => {
		/* Bun 1.44 s x 3.9 x 1.33 = 7.5 s; Node 2.47 s x 3.9 x 1.28 = 12.3 s; CI's slowest: Bun 5.5 s, Node 8.2 s */
		const derived = { bun: Math.ceil(1.44 * 3.9 * 1.33) * 1_000, node: Math.ceil(2.47 * 3.9 * 1.28) * 1_000 }
		expect([gate.HANG_GUARD_MS, gate.HANG_GUARD_MS.bun > 5_500, gate.HANG_GUARD_MS.node > 8_200]).toEqual([
			derived,
			true,
			true,
		])
	})
})

describe("the e2e build gate's record lines", () => {
	it("keys a ceiling by Bun's minor and Node's major", () => {
		expect([
			gate.runtimeKey("bun", "1.3.11"),
			gate.runtimeKey("node", "v22.23.3"),
			gate.runtimeKey("node", "v26.12.1"),
		]).toEqual(["bun 1.3", "node 22", "node 26"])
	})

	it("parses its RATIO lines back out of a CI log, the job and timestamp columns before them", () => {
		const log = [
			`e2e (cf-workers prod)\tRun bun run test:e2e:cf:prod\t2026-10-28T19:30:45.9Z ${gate.ratioLine(KEY, CELL, 15.04, 5_512.4, 366.6)}`,
			gate.referenceLine(KEY, "cloudflare", [366.6, 360, 371]),
			"RATIO hotpath body 1.2",
		].join("\n")
		expect([gate.parseRatios(log), log.split("\n")[1]]).toEqual([
			[{ cell: CELL, key: KEY, ms: 5_512, ratio: 15.04, referenceMs: 367 }],
			"REFERENCE build bun@1.3 cloudflare 367 367,360,371",
		])
	})

	it("classes a job by its own surface builds on bun, and a Node-only job as unclassified", () => {
		expect([job(2_900), job(3_500), job(4_000), job(5_500, "node 22")]).toEqual([
			"fast",
			"middle",
			"slow",
			"unclassified",
		])
	})

	it("refuses a derive from fewer than 6 runs, or from runs that miss a runner class", () => {
		const fastOnly = [0, 1, 2, 3, 4, 5].map((run) => recordJob(run, PROFILES.fast, 1))
		const refusal = "a derive needs 6+ record runs whose Bun jobs span the fast and slow runner classes; got"
		expect(() => gate.deriveCeilings(fastOnly.slice(0, 5))).toThrow(`${refusal} 5 runs, classes fast`)
		expect(() => gate.deriveCeilings(fastOnly)).toThrow(`${refusal} 6 runs, classes fast`)
	})
})

describe("the e2e build gate's ceilings", () => {
	const keys = ["bun 1.3", "node 22"] /* the build job's runtimes: BUN_VERSION's minor, setup-node's "22" */
	const cells = BUILD_SPECS.map((spec) => spec.id)

	it("names every cell a baseline lacks, so a pending one cannot pass for recorded", () => {
		const one = { builds: { [KEY]: { [CELL]: CEILING as gate.BuildCeiling } }, note: "", runs: [] }
		expect([
			gate.missingCeilings(undefined, [KEY], [CELL]),
			gate.missingCeilings(one, [KEY], [CELL, "mcp×bun"]),
		]).toEqual([[`${KEY} ${CELL}`], [`${KEY} mcp×bun`]])
	})

	it(`are recorded from CI for every cell before bit 21 closes (COMPLETE is ${COMPLETE})`, () => {
		const owed = COMPLETE >= 21 ? gate.missingCeilings(gate.readBaseline(), keys, cells) : []
		expect(owed).toEqual([])
	})
})

/*
 * Record runs across two code versions (the by-commit derive): six runs at an older commit, six at the newest, each
 * a Bun job (classed by its surface build) and a Node job. surface×cloudflare and surface×node carry the same ratios'
 * spread on both; mcp×cloudflare moved from ~3.4 to ~4.65 (a changed app), so its groups' ranges do not overlap.
 */
type Version = { commit: string; created: string }
/** Six runs at one commit: each run's Bun-job runner class and each cell's ratio, run by run. */
type CommitRuns = {
	classes: readonly ("fast" | "slow")[]
	mcp: readonly number[]
	node: readonly number[]
	surface: readonly number[]
}

const OLD: Version = { commit: "7731b1f", created: "2026-10-29T08:00:00Z" }
const NEW: Version = { commit: "b2946ee", created: "2026-10-29T12:00:00Z" }
const RUNS: Record<"new" | "old", CommitRuns> = {
	new: {
		classes: ["fast", "slow", "fast", "slow", "slow", "slow"],
		mcp: [4.6, 4.7, 4.5, 4.8, 4.6, 4.7],
		node: [27.1, 27.4, 26.9, 27.3, 27.2, 27.0],
		surface: [15.1, 15.2, 14.95, 15.0, 15.25, 15.05],
	},
	old: {
		classes: ["fast", "slow", "fast", "slow", "slow", "slow"],
		mcp: [3.4, 3.3, 3.5, 3.4, 3.3, 3.4],
		node: [27.0, 27.3, 27.2, 26.8, 27.4, 27.1],
		surface: [15.0, 14.9, 15.2, 15.3, 15.1, 15.0],
	},
}

/** One run's two jobs at `version`: its Bun job on a `runner`-class machine, and its Node job. */
function commitRun(
	version: Version,
	run: string,
	runner: "fast" | "slow",
	ratios: { mcp: number; node: number; surface: number },
) {
	const surfaceMs = runner === "fast" ? 2_700 : 4_600
	const bun = (cell: string, ratio: number) => ({
		cell,
		key: KEY,
		ms: surfaceMs,
		ratio,
		referenceMs: surfaceMs / ratio,
	})
	const node = { cell: "surface×node", key: "node 22", ms: 2_100, ratio: ratios.node, referenceMs: 77 }
	return [
		{ ...version, job: "build (bun)", ratios: [bun(CELL, ratios.surface), bun("mcp×cloudflare", ratios.mcp)], run },
		{ ...version, job: "build (node)", ratios: [node], run },
	]
}

/** Every job of six runs at `version` numbered from `from`, the Bun jobs on `classes`' runner classes. */
const commitRuns = (version: Version, from: number, runs: CommitRuns, classes = runs.classes) =>
	classes.flatMap((runner, i) =>
		commitRun(version, String(from + i), runner, {
			mcp: runs.mcp[i] as number,
			node: runs.node[i] as number,
			surface: runs.surface[i] as number,
		}),
	)

describe("the e2e build gate's derive across commits", () => {
	const decided = gate.deriveByCommit([...commitRuns(OLD, 1, RUNS.old), ...commitRuns(NEW, 7, RUNS.new)])
	const row = (cell: string) => decided.find((each) => each.cell === cell)

	it("pools a cell whose commit groups agree within each runner class's range: its n is both groups'", () => {
		expect([row(CELL)?.decision, row(CELL)?.n, row("surface×node")?.decision, row("surface×node")?.n]).toEqual([
			"pooled",
			12,
			"pooled",
			12,
		])
		expect(row(CELL)?.ceiling).toEqual({
			baseline: 15.07,
			byClass: { fast: 15.05, slow: 15.07 },
			catches: "+12%",
			ceiling: 16.83,
		})
	})

	it("derives a shifted cell from the newest commit's runs alone", () => {
		expect(row("mcp×cloudflare")).toEqual({
			cell: "mcp×cloudflare",
			ceiling: { baseline: 4.65, byClass: { fast: 4.55, slow: 4.7 }, catches: "+14%", ceiling: 5.28 },
			decision: "new-only",
			groups: [
				{ classes: { fast: 2, slow: 4 }, commit: OLD.commit, n: 6 },
				{ classes: { fast: 2, slow: 4 }, commit: NEW.commit, n: 6 },
			],
			key: KEY,
			n: 6,
		})
	})
})

describe("the e2e build gate's derive across commits: the runner classes it asks for", () => {
	it("asks the runner classes of a commit's Bun jobs, not of each cell: a cell built only on slow runners derives", () => {
		/* surface×bun, built only in each run's e2e (bun prod) job, landed slow every time; build (bun) did not */
		const slowCell = (run: number) => ({
			...NEW,
			job: "e2e (bun prod)",
			ratios: [{ cell: "surface×bun", key: KEY, ms: 4_600, ratio: 15 + run / 100, referenceMs: 4_600 / 15 }],
			run: String(run),
		})
		const derived = gate.deriveByCommit([...commitRuns(NEW, 7, RUNS.new), ...[7, 8, 9, 10, 11, 12].map(slowCell)])
		const cell = derived.find((each) => each.cell === "surface×bun")
		expect([cell?.groups, cell?.refused, cell?.ceiling?.ceiling]).toEqual([
			[{ classes: { slow: 6 }, commit: NEW.commit, n: 6 }],
			undefined,
			16.63,
		])
	})

	it("refuses a shifted cell whose newest group misses a runner class, by name, and still pools an agreeing one", () => {
		const slowOnly = gate.deriveByCommit([
			...commitRuns(OLD, 1, RUNS.old),
			...commitRuns(NEW, 7, RUNS.new, ["slow", "slow", "slow", "slow", "slow", "slow"]),
		])
		const of = (cell: string) => slowOnly.find((each) => each.cell === cell)
		expect([
			of("mcp×cloudflare")?.refused,
			of("mcp×cloudflare")?.ceiling,
			of(CELL)?.decision,
			of(CELL)?.refused,
		]).toEqual([
			`${KEY} mcp×cloudflare: new-only from ${NEW.commit}: 6 runs, no fast Bun job`,
			undefined,
			"pooled",
			undefined,
		])
	})
})
