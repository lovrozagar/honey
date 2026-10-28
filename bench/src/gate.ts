/**
 * The ratio gate the restored benches share (bit 20 e2), in hotpath.ts's discipline: each scenario's v1 cost as a
 * ratio to a raw twin doing the same work without honey, both timed in the same process in interleaved samples, so
 * the machine and the runtime's speed cancel out and a CI runner compares with a laptop. The median ratio is judged
 * (significance.ts) against the baseline recorded per runtime minor in bench/baselines.json: it regressed when past
 * baseline × (1 + threshold) AND outside the band of its own samples. `--update` records the median of three passes,
 * each a fresh process running exactly what a gate run runs (`--measure`). Under BENCH_MODE=record (CI's steps until
 * bit 20 e3) every ratio is printed as a `RATIO` line and the run never fails.
 */
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { judge, median } from "./significance.ts"

/** One scenario: each call times one sample of its side and returns that sample's cost, in any one unit. */
export type Scenario = { name: string; raw(): Promise<number>; v1(): Promise<number> }

type Baselines = { benches: Record<string, Record<string, Record<string, number>>>; note: string }

const FILE = new URL("../baselines.json", import.meta.url)
const NOTE =
	"v1 cost / its raw twin's (the same work without honey), median of interleaved samples, per bench and runtime " +
	"minor. Record with `<runtime> bench/src/<bench>.ts --update` on a quiet machine, unpinned as CI runs it (pinning " +
	"to two cores shifted adapter's loopback ratios ~10%), under the runtime CI pins, and commit the move with its reason."

const version = typeof Bun !== "undefined" ? Bun.version : process.version.slice(1)
/** The runtime and its minor version, the key a baseline is kept under. */
export const runtime = `${typeof Bun !== "undefined" ? "bun" : "node"} ${version.split(".").slice(0, 2).join(".")}`

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

function read(): Baselines {
	try {
		return JSON.parse(readFileSync(FILE, "utf8")) as Baselines
	} catch {
		/* no file yet: every scenario runs unbaselined until one is recorded */
		return { benches: {}, note: NOTE }
	}
}

/** One pass exactly as the gate measures, its medians on the last line: what --update takes three of. */
async function measure(scenarios: readonly Scenario[], samples: number): Promise<void> {
	const medians: Record<string, number> = {}
	for (const scenario of scenarios) medians[scenario.name] = median(await ratiosOf(scenario, samples))
	process.stdout.write(`${JSON.stringify(medians)}\n`)
}

/**
 * `bench`'s baselines, the median of three passes, each a fresh process as a gate run is: passes inside one process
 * run warm, and their median had sat up to 17% off what single gate runs measure (adapter's post-1kib low, websockets'
 * message-10k high); one noisy pass does not set the bar.
 */
function update(bench: string, scenarios: readonly Scenario[]): void {
	const passes: Record<string, number>[] = []
	for (let pass = 0; pass < 3; pass++) {
		const args = [...process.execArgv, process.argv[1] as string, "--measure"]
		const out = execFileSync(process.execPath, args, { encoding: "utf8", env: process.env })
		passes.push(JSON.parse(out.trim().split("\n").at(-1) as string) as Record<string, number>)
	}
	const recorded = Object.fromEntries(
		scenarios.map(({ name }) => [name, Number(median(passes.map((p) => p[name] ?? 0)).toFixed(2))]),
	)
	const file = read()
	file.note = NOTE
	file.benches[bench] = { ...file.benches[bench], [runtime]: recorded }
	writeFileSync(FILE, `${JSON.stringify(file, null, "\t")}\n`)
	console.log(`${bench}: baselines written for ${runtime} (${version})`)
	console.table(recorded)
}

/**
 * Runs `bench`'s scenarios and judges them (exit code 1 on a regression), records them under BENCH_MODE=record
 * (never failing), or records their baselines under `--update`.
 */
export async function gate(
	bench: string,
	scenarios: readonly Scenario[],
	{ samples, threshold }: { samples: number; threshold: number },
): Promise<void> {
	if (process.argv.includes("--measure")) return measure(scenarios, samples)
	if (process.argv.includes("--update")) return update(bench, scenarios)
	const own = read().benches[bench]?.[runtime]
	const rows = []
	for (const scenario of scenarios) {
		const verdict = judge(await ratiosOf(scenario, samples), own?.[scenario.name], threshold)
		rows.push({
			band: `±${verdict.halfWidth.toFixed(2)}`,
			baseline: own?.[scenario.name] ?? "—",
			limit: verdict.limit === null ? "—" : Number(verdict.limit.toFixed(2)),
			ratio: Number(verdict.ratio.toFixed(2)),
			scenario: scenario.name,
			status: verdict.status === "regressed" ? "REGRESSED" : verdict.status,
		})
	}
	const mode = modeOf(process.env)
	console.log(`${bench}: v1 / raw on ${runtime} (${version}), ${samples} samples, threshold +${threshold * 100}%`)
	if (mode === "record") console.log(`${bench}: ${RECORD_LABEL}`)
	console.table(rows)
	for (const row of rows) console.log(ratioLine(bench, row.scenario, row.ratio))
	if (own === undefined) console.log(`${bench}: no baseline for ${runtime}; advisory only.`)
	const code = exitCode(
		mode,
		own !== undefined,
		rows.map((row) => row.status),
	)
	if (code !== 0) console.error(`${bench}: a scenario regressed past its recorded ratio.`)
	process.exitCode = code
}

/** What CI's steps print and are named: their ratios are recorded, not judged, until bit 20 e3 sets the gates. */
export const RECORD_LABEL = "record mode, gating at e3"

/** `record` when BENCH_MODE=record (set only in ci.yml's bench steps): every ratio printed, the run never fails. */
export function modeOf(env: Readonly<Record<string, string | undefined>>): "judge" | "record" {
	return env.BENCH_MODE === "record" ? "record" : "judge"
}

/** One scenario's ratio as one parseable line, for collecting runs: `RATIO <bench> <scenario> <value>`. */
export const ratioLine = (bench: string, scenario: string, ratio: number) => `RATIO ${bench} ${scenario} ${ratio}`

/** A run's exit code: 1 only when judging against a recorded baseline and a scenario regressed; 0 in record mode. */
export function exitCode(mode: "judge" | "record", baselined: boolean, statuses: readonly string[]): 0 | 1 {
	if (mode === "record" || !baselined) return 0
	return statuses.includes("REGRESSED") ? 1 : 0
}
