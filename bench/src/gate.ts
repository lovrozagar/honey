/**
 * The ratio gate the five benches share (bit 20 e2, ceilings at e3): each scenario's v1 cost as a ratio to a raw twin
 * doing the same work without honey, both timed in the same process in interleaved samples, so the machine and the
 * runtime's speed cancel out. The samples come in k passes (PASSES) interleaved across the scenarios, and the median of
 * a scenario's pass medians is judged against its `ceiling` in blueprint/baselines/bench.json, per runtime minor: above
 * it is REGRESSED. The ceilings come from CI's own runs (the worst of six, plus 10%; the file's note), so the CI run is
 * the gate; a local run on other hardware only hints. Under BENCH_MODE=record every judged ratio is printed as a
 * `RATIO` line and no ceiling fails the run, but a scenario whose pass medians disagree past SPREAD_TOLERANCE refuses
 * it: an unsteady measurement is never recorded. That is how CI re-records.
 */
import { readFileSync } from "node:fs"
import { halfWidth, median } from "./significance.ts"

/**
 * One scenario: each call times one sample of its side and returns that sample's cost, in any one unit. `warmup` is
 * how many throwaway v1 + raw pairs run before its first pass, for one that reaches steady state only after many
 * (websockets.ts says why); a pass's own warm-up pair still runs.
 */
export type Scenario = { name: string; raw(): Promise<number>; v1(): Promise<number>; warmup?: number }

/**
 * A scenario's recorded ratios: the CI median, and the ceiling a run's median must not pass. A `reportOnly` one is
 * judged and printed but never fails the run; its `reason` says why (bench.json).
 */
export type Ceiling = { baseline: number; catches: string; ceiling: number; reason?: string; reportOnly?: true }

type BenchFile = { benches: Record<string, Record<string, Record<string, Ceiling>>>; note: string; runs: string[] }

const FILE = new URL("../../blueprint/baselines/bench.json", import.meta.url)

const version = typeof Bun !== "undefined" ? Bun.version : process.version.slice(1)
/** The runtime and its minor version, the key a ceiling is kept under. */
export const runtime = `${typeof Bun !== "undefined" ? "bun" : "node"} ${version.split(".").slice(0, 2).join(".")}`

/** `bench`'s ceilings for a runtime minor (this one by default), or undefined when none are recorded for it. */
export function ceilingsOf(bench: string, at = runtime): Record<string, Ceiling> | undefined {
	return (JSON.parse(readFileSync(FILE, "utf8")) as BenchFile).benches[bench]?.[at]
}

/**
 * One scenario's report row from its passes' ratios: the median of the pass medians judged against its ceiling,
 * REGRESSED when above it; a report-only scenario is labelled so instead, over or under, and never reads REGRESSED.
 * The band is the 95% half-width of the pass medians, the spread the judged median comes from (one pass: its samples');
 * `spread` is spreadOf's, what a record run is refused on.
 */
export function rowOf(scenario: string, passes: readonly (readonly number[])[], own: Ceiling | undefined) {
	const medians = passes.map((ratios) => median(ratios))
	const ratio = median(medians)
	return {
		band: `±${halfWidth(medians.length > 1 ? medians : passes.flat()).toFixed(2)}`,
		baseline: own?.baseline ?? "—",
		ceiling: own?.ceiling ?? "—",
		ratio: Number(ratio.toFixed(2)),
		scenario,
		spread: Number(spreadOf(medians).toFixed(3)),
		status: statusOf(ratio, own),
	}
}

/** How far a scenario's pass medians disagree: (max - min) / their median; 0 for one pass. */
export function spreadOf(medians: readonly number[]): number {
	return (Math.max(...medians) - Math.min(...medians)) / median(medians)
}

/**
 * The widest pass spread a record run accepts (bit 21 k-pass). A scenario past it is not steady across one process,
 * so its ratio depends on how long the run is: it is fixed in its bench, never recorded, never widened here. Measured
 * on 5 local k=3 record runs of the five benches, all 27 scenarios (Bun 1.3.11, Node 26.12.1, bit 21 k-pass): steady
 * scenarios spread 0.06 at the median, 0.22 at p95 and 0.457 at most (finalize 500x50); the drift this refuses read
 * 0.91-1.46 (websockets' echo: 1.15-1.46 on the feed loop it shared with realtime-inbound, 0.91 once before each
 * sample closed its connection; websockets.ts has both fixes). 0.5 sits between them.
 * A burst that lifts one pass past it refuses the run too: that run is re-run, though its median held.
 */
export const SPREAD_TOLERANCE = 0.5

function statusOf(ratio: number, own: Ceiling | undefined): string {
	if (own === undefined) return "unbaselined"
	if (own.reportOnly === true) return ratio > own.ceiling ? "report-only: over" : "report-only: ok"
	return ratio > own.ceiling ? "REGRESSED" : "ok"
}

/**
 * k, the passes each scenario is measured in (bit 21 k-pass). A short bench measures in well under two seconds (CI
 * 40913885826: the whole adapter step, node's start included, spanned 1.72 s), so a runner burst of a second or two
 * covered a whole k=1 measurement and moved every ratio at once (adapter's four scenarios high together, stacked-json
 * 2.36 over its 2.354 ceiling, v1 unchanged). With the passes interleaved across the scenarios and every round but the
 * last held to ROUND_FLOOR_MS, such a burst inflates one pass of each, and the median of three outvotes it: the build
 * gate's k=3 (build-gate.ts) for the same class of red. BENCH_PASSES overrides it, for a local run.
 */
export const PASSES = 3

/**
 * The least a round (one pass of every scenario) lasts before the next starts, idle when its work is shorter; the last
 * round never waits. Source: the longest burst seen, 1.72 s, the span of CI 40913885826's adapter step, whose four
 * scenarios all read high; across the 30 runs of ci-f/r6/history.txt the 7 with all four adapter scenarios above their
 * median spanned 1.35-1.72 s, and none lifted websockets, measured ~4.5 s before (1.07 at most). Plus a 50% margin:
 * 1.72 x 1.5 = 2.58, so 2.6 s. Time-based on purpose, so it holds on either runner class; hotpath's and finalize's
 * rounds already last longer and never wait.
 */
export const ROUND_FLOOR_MS = 2600

/** Time for measure(): the wall clock, or a test's own. */
export type Clock = { now(): number; sleep(ms: number): Promise<void> }

const wallClock: Clock = {
	now: () => performance.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/** The passes a run takes: BENCH_PASSES when set (a positive integer, else it throws), PASSES otherwise. */
export function passesOf(env: Readonly<Record<string, string | undefined>>): number {
	const value = env.BENCH_PASSES
	if (value === undefined) return PASSES
	const passes = Number(value)
	if (!Number.isInteger(passes) || passes < 1)
		throw new Error(`BENCH_PASSES must be a positive integer, got "${value}"`)
	return passes
}

/** A scenario's samples: each pass's v1 / raw ratios, and every v1 and raw cost across the passes. */
export type Measured = { name: string; passes: number[][]; raw: number[]; v1: number[] }

/** One pass: a throwaway run of each side, so both JITs have settled, then interleaved samples of v1 and raw. */
async function passOf(scenario: Scenario, samples: number, into: Measured): Promise<void> {
	await scenario.v1()
	await scenario.raw()
	const ratios: number[] = []
	for (let s = 0; s < samples; s++) {
		const v1 = await scenario.v1()
		const raw = await scenario.raw()
		into.v1.push(v1)
		into.raw.push(raw)
		ratios.push(v1 / raw)
	}
	into.passes.push(ratios)
}

type Options = { clock?: Clock; floorMs?: number; passes: number; samples: number }

/**
 * Measures the scenarios in `passes` rounds, each one pass of every scenario in order (A B C, A B C, ...), after each
 * one's `warmup`; every round but the last lasts at least `floorMs` (idle when shorter), so each scenario's passes
 * spread over the whole run rather than one stretch of it. Each result keeps its scenario's order and name; `idleMs`
 * is the time spent waiting on the floor.
 */
export async function measure(
	scenarios: readonly Scenario[],
	{ clock = wallClock, floorMs = ROUND_FLOOR_MS, passes, samples }: Options,
): Promise<{ idleMs: number; measured: Measured[] }> {
	const runs = scenarios.map((scenario) => {
		const measured: Measured = { name: scenario.name, passes: [], raw: [], v1: [] }
		return { measured, scenario }
	})
	for (const { scenario } of runs) await warm(scenario)
	let idleMs = 0
	for (let pass = 0; pass < passes; pass++) {
		const started = clock.now()
		for (const { measured, scenario } of runs) await passOf(scenario, samples, measured)
		const left = floorMs - (clock.now() - started)
		if (pass < passes - 1 && left > 0) {
			await clock.sleep(left)
			idleMs += left
		}
	}
	return { idleMs, measured: runs.map(({ measured }) => measured) }
}

async function warm(scenario: Scenario): Promise<void> {
	for (let w = 0; w < (scenario.warmup ?? 0); w++) {
		await scenario.v1()
		await scenario.raw()
	}
}

/** How a run sampled, for its header: `median of 3 interleaved passes of 15 samples, rounds of >= 2.6 s (idle 4.1 s)`. */
export const samplingOf = (passes: number, samples: number, idleMs: number) =>
	`median of ${passes} interleaved passes of ${samples} samples, rounds of >= ${ROUND_FLOOR_MS / 1000} s (idle ${(idleMs / 1000).toFixed(1)} s)`

/** Runs `bench`'s scenarios and judges them against their ceilings: exit code 1 on a regression. */
export async function gate(bench: string, scenarios: readonly Scenario[], { samples }: { samples: number }) {
	const own = ceilingsOf(bench)
	const passes = passesOf(process.env)
	const { idleMs, measured } = await measure(scenarios, { passes, samples })
	const rows = measured.map((m) => rowOf(m.name, m.passes, own?.[m.name]))
	report(
		bench,
		`${bench}: v1 / raw on ${runtime} (${version}), ${samplingOf(passes, samples, idleMs)}`,
		rows,
		own !== undefined,
	)
}

/** What report() reads of a row: its judged ratio, its status and its pass spread. */
export type Row = { ratio: number; scenario: string; spread: number; status: string }

/**
 * Prints a run's header, table and one `RATIO` line per scenario, and sets its exit code (exitCode's). hotpath's
 * report goes through here too.
 */
export function report(bench: string, header: string, rows: readonly Row[], baselined: boolean): void {
	const mode = modeOf(process.env)
	console.log(header)
	if (mode === "record") console.log(`${bench}: ${RECORD_LABEL}`)
	console.table(rows)
	for (const row of rows) console.log(ratioLine(bench, row.scenario, row.ratio))
	if (!baselined) console.log(`${bench}: no ceilings for ${runtime}; advisory only (CI's pins are recorded).`)
	const code = exitCode(mode, baselined, rows)
	if (code !== 0 && mode === "record") console.error(`${bench}: record refused: ${unsteady(rows).join(", ")}.`)
	if (code !== 0 && mode === "judge") console.error(`${bench}: a scenario's ratio is above its ceiling in bench.json.`)
	process.exitCode = code
}

/** The rows whose pass spread is past SPREAD_TOLERANCE, each as `<scenario> spread <x> > <tolerance>`. */
export function unsteady(rows: readonly Row[]): string[] {
	return rows
		.filter((row) => row.spread > SPREAD_TOLERANCE)
		.map((row) => `${row.scenario} spread ${row.spread} > ${SPREAD_TOLERANCE}`)
}

/** What a record-mode run prints: its ratios are recorded, not judged. */
export const RECORD_LABEL = "record mode, not gating"

/** `record` when BENCH_MODE=record (a re-record in CI): every ratio printed, no ceiling judged. */
export function modeOf(env: Readonly<Record<string, string | undefined>>): "judge" | "record" {
	return env.BENCH_MODE === "record" ? "record" : "judge"
}

/** One scenario's ratio as one parseable line, for collecting runs: `RATIO <bench> <scenario> <value>`. */
export const ratioLine = (bench: string, scenario: string, ratio: number) => `RATIO ${bench} ${scenario} ${ratio}`

/**
 * A run's exit code. Judging: 1 only against recorded ceilings when a scenario regressed. Recording: 1 when a scenario's
 * pass spread is past SPREAD_TOLERANCE, the run refused so its ratios are never collected; else 0.
 */
export function exitCode(mode: "judge" | "record", baselined: boolean, rows: readonly Row[]): 0 | 1 {
	if (mode === "record") return unsteady(rows).length > 0 ? 1 : 0
	if (!baselined) return 0
	return rows.some((row) => row.status === "REGRESSED") ? 1 : 0
}
