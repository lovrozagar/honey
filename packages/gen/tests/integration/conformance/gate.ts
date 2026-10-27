/**
 * The release's conformance gate (bit 19 i, R11). The harness records each cell a target runs, with what it observed
 * (`recordCell` under HONEY_CONFORMANCE_RECORD, harness.ts), and each cell a runner lacks by design. The gate holds
 * every cell of every target in TARGETS against that record with compareCell: a regressed cell, or one no runner of
 * its target ran or lacks, blocks. ci.yml's conformance job runs it on the harness job's record: `bun gate.ts <dir>`.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Cell, cellsFor, compareCell, type Observed, TARGETS, type Target, type WireHop } from "./matrix.ts"

/** one line of the record: a cell a runner ran, with what it observed and the wire, or one it lacks by design */
export type CellRecord =
	| { readonly key: string; readonly lacks: true; readonly target: Target }
	| {
			readonly key: string
			readonly observed: readonly Observed[]
			readonly target: Target
			readonly wire: readonly WireHop[]
	  }

/** Append `entry` to this process's record under `dir`; with no `dir`, nothing is recorded. */
export function recordCell(dir: string | undefined, entry: CellRecord): void {
	if (dir === undefined) return
	mkdirSync(dir, { recursive: true })
	appendFileSync(join(dir, `cells-${process.pid}.jsonl`), `${JSON.stringify(entry)}\n`)
}

/** Every entry recorded under `dir`, file by file. */
export function readRecords(dir: string): CellRecord[] {
	return readdirSync(dir)
		.filter((file) => file.endsWith(".jsonl"))
		.sort()
		.flatMap((file) =>
			readFileSync(join(dir, file), "utf8")
				.split("\n")
				.filter((line) => line !== "")
				.map((line) => JSON.parse(line) as CellRecord),
		)
}

/** One line per cell of `grid` the record does not pass: each run of it that regressed, or none ran or lacks it. */
export function gateProblems(grid: ReadonlyMap<Target, readonly Cell[]>, records: readonly CellRecord[]): string[] {
	const byCell = Map.groupBy(records, (record) => `${record.target} ${record.key}`)
	const problems: string[] = []
	for (const [target, cells] of grid)
		for (const cell of cells) {
			const mine = byCell.get(`${target} ${cell.key}`) ?? []
			if (mine.length === 0) problems.push(`${target} ${cell.key}: not run`)
			for (const record of mine) {
				if ("lacks" in record) continue
				const lines = compareCell(cell, record.observed, record.wire)
				if (lines.length > 0) problems.push(`${target} ${cell.key}: regressed: ${lines.join("; ")}`)
			}
		}
	return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const dir = process.argv[2]
	if (dir === undefined) throw new Error("usage: gate.ts <the harness's record directory>")
	const grid = new Map(TARGETS.map((target) => [target, cellsFor(target)]))
	const problems = gateProblems(grid, readRecords(dir))
	for (const problem of problems) console.error(problem)
	const cells = [...grid.values()].reduce((n, list) => n + list.length, 0)
	if (problems.length > 0) process.exit(1)
	console.log(`conformance gate: ${cells} cells across ${grid.size} targets pass`)
}
