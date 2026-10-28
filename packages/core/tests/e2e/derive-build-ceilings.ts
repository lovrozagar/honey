#!/usr/bin/env bun
/**
 * blueprint/baselines/build.json from CI's record runs (bit 21 cfb; the build gate's twin of bit 20's bench derive):
 *
 *   bun packages/core/tests/e2e/derive-build-ceilings.ts <run id>...
 *
 * Reads each run's build and prod e2e jobs' logs through `gh`, takes their `RATIO build` lines, classes each job by its
 * own surface builds on bun (build-gate.ts jobClass), prints one row per job (run, job, class, surface ms, the honey-free
 * reference's median) and writes the ceilings: per runtime key and cell, the median, the worst x 1.10 and each class's
 * median. It refuses fewer than 6 runs, or Bun jobs that never landed on both the fast and the slow runner class.
 * Records from ci.yml dispatched with build_mode=record; a judged run's lines count too.
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { BASELINE_FILE, type BuildBaseline, deriveCeilings, jobClass, median, parseRatios } from "./build-gate.ts"

/* the jobs that build e2e apps through run-build.ts: build (bun|node) and every prod e2e cell */
const BUILDS_IN = /^(build \(|e2e \(.* prod\)$)/

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

const runs = process.argv.slice(2)
const jobs: Parameters<typeof deriveCeilings>[0][number][] = []
for (const run of runs) {
	const listed = JSON.parse(await gh(["run", "view", run, "--json", "jobs"])) as {
		jobs: { databaseId: number; name: string }[]
	}
	for (const job of listed.jobs.filter((each) => BUILDS_IN.test(each.name))) {
		const ratios = parseRatios(await gh(["run", "view", "--job", String(job.databaseId), "--log"]))
		if (ratios.length === 0) throw new Error(`run ${run}'s job "${job.name}" printed no RATIO build lines`)
		jobs.push({ job: job.name, ratios, run })
	}
}

for (const job of jobs) {
	const surface = job.ratios.filter((record) => record.key.startsWith("bun ") && record.cell.startsWith("surface×"))
	const row = [
		job.run,
		job.job.padEnd(24),
		jobClass(job.ratios).padEnd(12),
		surface.length > 0 ? `surface ${Math.round(median(surface.map((record) => record.ms)))} ms` : "no bun surface",
		`reference ${Math.round(median(job.ratios.map((record) => record.referenceMs)))} ms`,
	]
	process.stdout.write(`${row.join("  ")}\n`)
}

const builds = deriveCeilings(jobs)
const note =
	"Per runtime key (Bun by minor, Node by major) and e2e build cell: the cell's build time over a honey-free " +
	"reference build's (packages/core/tests/e2e/build-gate.ts), from the RATIO build lines of the build and prod e2e " +
	`jobs of CI runs ${[...new Set(runs)].sort().join(", ")} (ci.yml dispatched with build_mode=record). Each job is ` +
	"classed fast, middle or slow by its own surface builds on bun, Node-only jobs unclassified; byClass is each class's " +
	"median. baseline: the median of every job's ratio. ceiling: the worst plus a 10% margin (worst x 1.10). A ratio " +
	"above its ceiling is REGRESSED. catches: ceiling / baseline. No retry: a red with honey unchanged is answered by a " +
	"re-record (6+ runs spanning both runner classes, derived by derive-build-ceilings.ts), never a rerun."
const out: BuildBaseline = { builds, note, runs: [...new Set(runs)].sort() }
writeFileSync(fileURLToPath(BASELINE_FILE), `${JSON.stringify(out, null, "\t")}\n`)
process.stdout.write(
	`wrote ${fileURLToPath(BASELINE_FILE)}: ${Object.values(builds).flatMap(Object.keys).length} cells\n`,
)
