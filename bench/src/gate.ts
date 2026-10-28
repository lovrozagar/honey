/**
 * The ratio gate the five benches share (bit 20 e2, ceilings at e3): each scenario's v1 cost as a ratio to a raw twin
 * doing the same work without honey, both timed in the same process in interleaved samples, so the machine and the
 * runtime's speed cancel out. The median ratio is judged against the scenario's `ceiling` in
 * blueprint/baselines/bench.json, per runtime minor: above it is REGRESSED. The ceilings come from CI's own runs (the
 * worst of six, plus 10%; the file's note), so the CI run is the gate; a local run on other hardware only hints.
 * Under BENCH_MODE=record every ratio is printed as a `RATIO` line and the run never fails: how CI re-records.
 */
import { readFileSync } from "node:fs"
import { halfWidth, median } from "./significance.ts"

/** One scenario: each call times one sample of its side and returns that sample's cost, in any one unit. */
export type Scenario = { name: string; raw(): Promise<number>; v1(): Promise<number> }

/** A scenario's recorded ratios: the CI median, and the ceiling a run's median must not pass. */
export type Ceiling = { baseline: number; catches: string; ceiling: number }

type BenchFile = { benches: Record<string, Record<string, Record<string, Ceiling>>>; note: string; runs: string[] }

const FILE = new URL("../../blueprint/baselines/bench.json", import.meta.url)

const version = typeof Bun !== "undefined" ? Bun.version : process.version.slice(1)
/** The runtime and its minor version, the key a ceiling is kept under. */
export const runtime = `${typeof Bun !== "undefined" ? "bun" : "node"} ${version.split(".").slice(0, 2).join(".")}`

/** `bench`'s ceilings for a runtime minor (this one by default), or undefined when none are recorded for it. */
export function ceilingsOf(bench: string, at = runtime): Record<string, Ceiling> | undefined {
	return (JSON.parse(readFileSync(FILE, "utf8")) as BenchFile).benches[bench]?.[at]
}

/** One scenario's report row: its median ratio judged against its ceiling, REGRESSED when above it. */
export function rowOf(scenario: string, ratios: readonly number[], own: Ceiling | undefined) {
	const ratio = median(ratios)
	const status = own === undefined ? "unbaselined" : ratio > own.ceiling ? "REGRESSED" : "ok"
	return {
		band: `±${halfWidth(ratios).toFixed(2)}`,
		baseline: own?.baseline ?? "—",
		ceiling: own?.ceiling ?? "—",
		ratio: Number(ratio.toFixed(2)),
		scenario,
		status,
	}
}

/** Interleaved samples of v1 and raw after one throwaway run of each, so both JITs have settled. */
async function ratiosOf(scenario: Scenario, samples: number): Promise<number[]> {
	await scenario.v1()
	await scenario.raw()
	const ratios: number[] = []
	for (let s = 0; s < samples; s++) {
		const v1 = await scenario.v1()
		const raw = await scenario.raw()
		ratios.push(v1 / raw)
	}
	return ratios
}

/** Runs `bench`'s scenarios and judges them against their ceilings: exit code 1 on a regression. */
export async function gate(bench: string, scenarios: readonly Scenario[], { samples }: { samples: number }) {
	const own = ceilingsOf(bench)
	const rows = []
	for (const scenario of scenarios) {
		rows.push(rowOf(scenario.name, await ratiosOf(scenario, samples), own?.[scenario.name]))
	}
	report(bench, `${bench}: v1 / raw on ${runtime} (${version}), ${samples} samples`, rows, own !== undefined)
}

/**
 * Prints a run's header, table and one `RATIO` line per scenario, and sets its exit code: 1 when judged against
 * recorded ceilings and a scenario regressed, else 0. hotpath's report goes through here too.
 */
export function report(
	bench: string,
	header: string,
	rows: readonly { ratio: number; scenario: string; status: string }[],
	baselined: boolean,
): void {
	const mode = modeOf(process.env)
	console.log(header)
	if (mode === "record") console.log(`${bench}: ${RECORD_LABEL}`)
	console.table(rows)
	for (const row of rows) console.log(ratioLine(bench, row.scenario, row.ratio))
	if (!baselined) console.log(`${bench}: no ceilings for ${runtime}; advisory only (CI's pins are recorded).`)
	const code = exitCode(
		mode,
		baselined,
		rows.map((row) => row.status),
	)
	if (code !== 0) console.error(`${bench}: a scenario's ratio is above its ceiling in bench.json.`)
	process.exitCode = code
}

/** What a record-mode run prints: its ratios are recorded, not judged. */
export const RECORD_LABEL = "record mode, not gating"

/** `record` when BENCH_MODE=record (a re-record in CI): every ratio printed, the run never fails. */
export function modeOf(env: Readonly<Record<string, string | undefined>>): "judge" | "record" {
	return env.BENCH_MODE === "record" ? "record" : "judge"
}

/** One scenario's ratio as one parseable line, for collecting runs: `RATIO <bench> <scenario> <value>`. */
export const ratioLine = (bench: string, scenario: string, ratio: number) => `RATIO ${bench} ${scenario} ${ratio}`

/** A run's exit code: 1 only when judging against recorded ceilings and a scenario regressed; 0 in record mode. */
export function exitCode(mode: "judge" | "record", baselined: boolean, statuses: readonly string[]): 0 | 1 {
	if (mode === "record" || !baselined) return 0
	return statuses.includes("REGRESSED") ? 1 : 0
}
