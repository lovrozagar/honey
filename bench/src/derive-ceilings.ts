#!/usr/bin/env bun
/**
 * blueprint/baselines/bench.json from CI's own runs (plan 37; the bench's twin of derive-build-ceilings.ts):
 *
 *   bun bench/src/derive-ceilings.ts <run id>...
 *
 * Reads each run's hot-path benchmark job log through `gh`: its CPU model, its `RATIO <bench> <scenario> <ratio>` lines
 * (judged and record runs alike) and the benches whose record it refused. A bench pools the runs whose head commit
 * holds the same `bench/src/<bench>.ts` and `bench/src/gate.ts` as the newest run's, the scenarios and the pass protocol
 * they are measured by: an edit to either starts a new pool. Each scenario's ceiling is ceiling-rule.ts's over every
 * gated scenario, its baseline the median, its `catches` the ceiling over the baseline; a scenario whose level differs
 * by CPU model has that reason's per-model medians and lowest-model catch rewritten from the new pool, any other reason
 * and `reportOnly` kept. It refuses a bench with fewer than MIN_RECORD_RUNS pooled runs and writes nothing then.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { ceilingRule, MIN_RECORD_RUNS, WORST_MARGIN } from "../../packages/core/tests/e2e/ceiling-rule.ts"
import type { Ceiling } from "./gate.ts"
import { median } from "./significance.ts"

/** What one run's bench job printed: its CPU model (unclassed when it printed none), ratios and refused benches. */
export type BenchLog = {
	readonly model: string
	readonly ratios: readonly { readonly bench: string; readonly ratio: number; readonly scenario: string }[]
	readonly refused: readonly string[]
}

/** `AMD EPYC 9V45 96-Core Processor` as `EPYC 9V45`, `INTEL(R) XEON(R) PLATINUM 8573C` as `Xeon 8573C`. */
export function modelOf(line: string): string {
	const epyc = /EPYC (\S+)/i.exec(line)
	if (epyc) return `EPYC ${epyc[1]}`
	const xeon = /XEON\(R\)(?: PLATINUM| GOLD)? (\S+)/i.exec(line)
	return xeon ? `Xeon ${xeon[1]}` : line.trim()
}

/** A bench job's log, as `gh run view --job <id> --log` prints it. */
export function parseBenchLog(log: string): BenchLog {
	const model = /model name\s*:\s*(.+)$/m.exec(log)?.[1]
	const ratios = [...log.matchAll(/RATIO (\S+) (\S+) ([\d.]+)\s*$/gm)].map((m) => ({
		bench: m[1] as string,
		ratio: Number(m[3]),
		scenario: m[2] as string,
	}))
	const refused = [...log.matchAll(/(\S+): record refused:/g)].map((m) => m[1] as string)
	return { model: model === undefined ? "unclassed" : modelOf(model), ratios, refused }
}

/** One run's bench log with its id and, per bench, the pool key its head commit gives that bench. */
export type BenchRun = { readonly keys: Readonly<Record<string, string>>; readonly log: BenchLog; readonly run: string }

/** The runs whose key for `bench` is the newest run's (the last in `runs`): the runs of the code measured now. */
export function poolOf(runs: readonly BenchRun[], bench: string): BenchRun[] {
	const newest = runs.at(-1)?.keys[bench]
	return runs.filter((each) => newest !== undefined && each.keys[bench] === newest)
}

const CPU_REASON =
	/its level differs by CPU model \(per-model medians: [^)]*\); a ratio cancels runner speed, not microarchitecture, so this pooled ceiling covers every model and catches only \+\d+% on the lowest one\./

/** A model-level reason's text for `ratios` by model under `ceiling`. */
function cpuReason(byModel: ReadonlyMap<string, readonly number[]>, ceiling: number): string {
	const models = [...byModel.keys()].sort((a, b) =>
		a === "unclassed" ? 1 : b === "unclassed" ? -1 : a.localeCompare(b),
	)
	const medians = models.map((model) => [model, median(byModel.get(model) as number[])] as const)
	const lowest = Math.min(...medians.map(([, level]) => level))
	return (
		`its level differs by CPU model (per-model medians: ${medians.map(([model, level]) => `${model} ${level.toFixed(3)}`).join(", ")}); ` +
		"a ratio cancels runner speed, not microarchitecture, so this pooled ceiling covers every model and catches " +
		`only +${Math.round((ceiling / lowest - 1) * 100)}% on the lowest one.`
	)
}

/** The benches of `current` re-derived from `runs` (oldest first), or every bench's refusal when one pools too few. */
export function deriveBenches(
	current: Readonly<Record<string, Record<string, Record<string, Ceiling>>>>,
	runs: readonly BenchRun[],
): { benches: Record<string, Record<string, Record<string, Ceiling>>>; refused: string[]; used: string[] } {
	const gated = Object.values(current)
		.flatMap((byRuntime) => Object.values(byRuntime).flatMap((scenarios) => Object.values(scenarios)))
		.filter((each) => each.reportOnly !== true).length
	/* the budget is split across the gated scenarios; a file of report-only ones still fits one */
	const cells = Math.max(1, gated)
	const benches: Record<string, Record<string, Record<string, Ceiling>>> = {}
	const refused: string[] = []
	const used = new Set<string>()
	for (const [bench, byRuntime] of Object.entries(current)) {
		const pool = poolOf(runs, bench)
		if (pool.length < MIN_RECORD_RUNS) {
			refused.push(`${bench}: ${pool.length} runs on its newest code, fewer than ${MIN_RECORD_RUNS}`)
			continue
		}
		for (const each of pool) used.add(each.run)
		benches[bench] = {}
		for (const [at, scenarios] of Object.entries(byRuntime)) {
			const out: Record<string, Ceiling> = {}
			for (const [scenario, own] of Object.entries(scenarios)) {
				const byModel = new Map<string, number[]>()
				for (const { log } of pool) {
					for (const each of log.ratios.filter((r) => r.bench === bench && r.scenario === scenario))
						byModel.set(log.model, [...(byModel.get(log.model) ?? []), each.ratio])
				}
				const ratios = [...byModel.values()].flat()
				if (ratios.length < MIN_RECORD_RUNS) {
					refused.push(`${bench} ${scenario}: ${ratios.length} ratios, fewer than ${MIN_RECORD_RUNS}`)
					continue
				}
				const baseline = Number(median(ratios).toFixed(3))
				const ceiling = Number(ceilingRule(ratios, cells).toFixed(3))
				const reason = own.reason?.replace(CPU_REASON, () => cpuReason(byModel, ceiling))
				out[scenario] = {
					baseline,
					catches: `+${Math.round((ceiling / baseline - 1) * 100)}%`,
					ceiling,
					...(reason !== undefined && { reason }),
					...(own.reportOnly === true && { reportOnly: true as const }),
				}
			}
			benches[bench][at] = out
		}
	}
	return { benches, refused, used: [...used].sort() }
}

async function gh(args: string[]): Promise<string> {
	const proc = Bun.spawn(["gh", ...args], { stderr: "pipe", stdout: "pipe" })
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])
	if (code !== 0) throw new Error(`gh ${args.join(" ")} exited ${code}: ${err}`)
	return out
}

/** `git rev-parse <commit>:<path>`: the blob a path holds at a commit. */
async function blob(commit: string, path: string): Promise<string> {
	const proc = Bun.spawn(["git", "rev-parse", `${commit}:${path}`], { stderr: "pipe", stdout: "pipe" })
	const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
	if (code !== 0) throw new Error(`git rev-parse ${commit}:${path} failed: fetch the run's commit first`)
	return out.trim()
}

if (import.meta.main) {
	const FILE = new URL("../../blueprint/baselines/bench.json", import.meta.url)
	const current = JSON.parse(readFileSync(FILE, "utf8")) as {
		benches: Record<string, Record<string, Record<string, Ceiling>>>
	}
	const runs: (BenchRun & { created: string })[] = []
	for (const run of process.argv.slice(2)) {
		const listed = JSON.parse(await gh(["run", "view", run, "--json", "createdAt,headSha,jobs"])) as {
			createdAt: string
			headSha: string
			jobs: { databaseId: number; name: string }[]
		}
		const job = listed.jobs.find((each) => each.name === "hot-path benchmark")
		if (job === undefined) throw new Error(`run ${run} has no hot-path benchmark job`)
		const log = parseBenchLog(await gh(["run", "view", "--job", String(job.databaseId), "--log"]))
		const gate = await blob(listed.headSha, "bench/src/gate.ts")
		const keys: Record<string, string> = {}
		for (const bench of Object.keys(current.benches))
			keys[bench] = `${await blob(listed.headSha, `bench/src/${bench}.ts`)} ${gate}`
		runs.push({ created: listed.createdAt, keys, log, run })
		process.stdout.write(
			`${run}  ${listed.headSha.slice(0, 7)}  ${log.model.padEnd(12)}  ${log.ratios.length} ratios\n`,
		)
	}
	runs.sort((a, b) => a.created.localeCompare(b.created))
	const { benches, refused, used } = deriveBenches(current.benches, runs)
	if (refused.length > 0) {
		process.stdout.write(`\nrefused, nothing written:\n${refused.map((each) => `  ${each}\n`).join("")}`)
		process.exit(1)
	}
	const note =
		"Per bench, runtime and scenario: v1 cost over its raw twin's, the median of 3 interleaved pass medians, from " +
		"the RATIO lines of the hot-path benchmark job of every CI run below, judged and record alike " +
		"(bench/src/derive-ceilings.ts). A bench pools the runs whose bench/src/<bench>.ts and bench/src/gate.ts match " +
		"the newest run's. Ceiling (packages/core/tests/e2e/ceiling-rule.ts): per scenario, fit log(ratio) (mean m, " +
		"sample sd s), sigma_upper = s * sqrt((n-1)/chi2_0.10,n-1), z = Phi^-1(1 - 0.02/G) with G the gated scenarios, " +
		`ceiling = max(worst x ${WORST_MARGIN}, exp(m + z*sigma_upper)); baseline the median; catches = ceiling / ` +
		"baseline. A ratio cancels runner speed, not CPU microarchitecture, so a scenario whose level differs by model " +
		"carries a reason naming its per-model levels and its catch on the lowest. A same-runner A/B gate (head vs a " +
		"pinned base commit) replaces these ceilings next. A reportOnly scenario is printed and never fails the run. " +
		"No retry: a red with v1 unchanged is answered by a re-derive over more runs, never a rerun until green."
	writeFileSync(FILE, `${JSON.stringify({ benches, note, runs: used }, null, "\t")}\n`)
	process.stdout.write(`wrote ${FILE.pathname}: ${Object.keys(benches).length} benches from ${used.length} runs\n`)
}
