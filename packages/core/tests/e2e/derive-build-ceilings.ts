#!/usr/bin/env bun
/**
 * blueprint/baselines/build.json from CI's record runs (bit 21 cfb; the build gate's twin of bit 20's bench derive):
 *
 *   bun packages/core/tests/e2e/derive-build-ceilings.ts <run id>...
 *   bun packages/core/tests/e2e/derive-build-ceilings.ts --by-commit <run id>...
 *
 * Reads each run's build and prod e2e jobs' logs through `gh`, takes their `RATIO build` lines, classes each job by its
 * own surface builds on bun (build-gate.ts jobClass), prints one row per job (run, job, class, surface ms, the honey-free
 * reference's median) and writes the ceilings: per runtime key and cell, the median, the worst x 1.10 and each class's
 * median. It refuses fewer than 6 runs, or Bun jobs that never landed on both the fast and the slow runner class.
 * Records from ci.yml dispatched with build_mode=record; a judged run's lines count too.
 *
 * --by-commit, for runs spanning code versions: each cell's samples grouped by their run's head commit, pooled when
 * the groups agree within each runner class's range, else taken from the newest commit's runs alone (build-gate.ts
 * deriveByCommit). It prints a row per cell (its groups with n and class split, pooled or new-only, median, ceiling)
 * and writes the baseline from the decided samples; when any cell is refused (its decided runs under 6, or missing a
 * Bun class) it names each and writes nothing, so more runs are dispatched on the newest commit first.
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
	BASELINE_FILE,
	type BuildBaseline,
	type BuildCeiling,
	type CommitJob,
	deriveByCommit,
	deriveCeilings,
	jobClass,
	median,
	parseRatios,
} from "./build-gate.ts"

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

const byCommit = process.argv.includes("--by-commit")
const runs = process.argv.slice(2).filter((each) => each !== "--by-commit")
const jobs: CommitJob[] = []
for (const run of runs) {
	const listed = JSON.parse(await gh(["run", "view", run, "--json", "createdAt,headSha,jobs"])) as {
		createdAt: string
		headSha: string
		jobs: { databaseId: number; name: string }[]
	}
	for (const job of listed.jobs.filter((each) => BUILDS_IN.test(each.name))) {
		const ratios = parseRatios(await gh(["run", "view", "--job", String(job.databaseId), "--log"]))
		if (ratios.length === 0) throw new Error(`run ${run}'s job "${job.name}" printed no RATIO build lines`)
		jobs.push({ commit: listed.headSha.slice(0, 7), created: listed.createdAt, job: job.name, ratios, run })
	}
}

for (const job of jobs) {
	const surface = job.ratios.filter((record) => record.key.startsWith("bun ") && record.cell.startsWith("surface×"))
	const row = [
		job.run,
		job.commit,
		job.job.padEnd(24),
		jobClass(job.ratios).padEnd(12),
		surface.length > 0 ? `surface ${Math.round(median(surface.map((record) => record.ms)))} ms` : "no bun surface",
		`reference ${Math.round(median(job.ratios.map((record) => record.referenceMs)))} ms`,
	]
	process.stdout.write(`${row.join("  ")}\n`)
}

/* --by-commit: one row per cell, then the ceilings from each cell's decided samples, or every refusal and no write */
function decidedBuilds(): Record<string, Record<string, BuildCeiling>> {
	const decisions = deriveByCommit(jobs)
	for (const each of decisions) {
		const groups = each.groups.map(
			(group) =>
				`${group.commit} n=${group.n} (${Object.entries(group.classes)
					.map(([runner, n]) => `${runner} ${n}`)
					.join(", ")})`,
		)
		const verdict = each.ceiling ? `median ${each.ceiling.baseline} ceiling ${each.ceiling.ceiling}` : "REFUSED"
		const row = [`${each.key} ${each.cell}`.padEnd(28), groups.join(" | "), `${each.decision} n=${each.n}`, verdict]
		process.stdout.write(`${row.join("  ")}\n`)
	}
	const refused = decisions.flatMap((each) => (each.refused === undefined ? [] : [each.refused]))
	if (refused.length > 0) {
		process.stdout.write(`\nrefused, nothing written; dispatch more record runs on the newest commit:\n`)
		for (const reason of refused) process.stdout.write(`  ${reason}\n`)
		process.exit(1)
	}
	const out: Record<string, Record<string, BuildCeiling>> = {}
	for (const each of decisions) out[each.key] = { ...out[each.key], [each.cell]: each.ceiling as BuildCeiling }
	return out
}

const builds = byCommit ? decidedBuilds() : deriveCeilings(jobs)
const note =
	"Per runtime key (Bun by minor, Node by major) and e2e build cell: the cell's build time over a honey-free " +
	"reference build's (packages/core/tests/e2e/build-gate.ts), from the RATIO build lines of the build and prod e2e " +
	`jobs of CI runs ${[...new Set(runs)].sort().join(", ")} (ci.yml dispatched with build_mode=record). Each job is ` +
	"classed fast, middle or slow by its own surface builds on bun, Node-only jobs unclassified; byClass is each class's " +
	"median. baseline: the median of every job's ratio. ceiling: the worst plus a 10% margin (worst x 1.10). A ratio " +
	"above its ceiling is REGRESSED. catches: ceiling / baseline. No retry: a red with honey unchanged is answered by a " +
	"re-record (6+ runs spanning both runner classes, derived by derive-build-ceilings.ts), never a rerun." +
	(byCommit
		? " Derived --by-commit: a cell whose head-commit groups agree (each group's median within the other's range, " +
			"per runner class) pools them; any other takes the newest commit's runs alone."
		: "")
const out: BuildBaseline = { builds, note, runs: [...new Set(runs)].sort() }
writeFileSync(fileURLToPath(BASELINE_FILE), `${JSON.stringify(out, null, "\t")}\n`)
process.stdout.write(
	`wrote ${fileURLToPath(BASELINE_FILE)}: ${Object.values(builds).flatMap(Object.keys).length} cells\n`,
)
