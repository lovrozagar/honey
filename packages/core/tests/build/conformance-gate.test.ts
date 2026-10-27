/**
 * The release's conformance gate (bit 19 i, R11): the release waits on ci.yml, whose harness job runs every target's
 * cells on its toolchain and records what each observed, and whose conformance job holds every cell of every target
 * against that record with compareCell (gen's conformance/gate.ts). Here, with no toolchain: the workflow wiring, the
 * gate's verdicts on recorded cells, and the gate script over the real grid.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { call, data } from "../../../gen/tests/integration/conformance/cells.ts"
import {
	type CellRecord,
	gateProblems,
	readRecords,
	recordCell,
} from "../../../gen/tests/integration/conformance/gate.ts"
import { type Cell, cellsFor, TARGETS, type Target } from "../../../gen/tests/integration/conformance/matrix.ts"
import { caller, jobsRunning, ROOT, type Step, upstream, workflow } from "./fixture/workflows.ts"

const GATE = "packages/gen/tests/integration/conformance/gate.ts"

const dirs: string[] = []
const scratch = () => {
	const dir = mkdtempSync(join(tmpdir(), "honey-conformance-gate-"))
	dirs.push(dir)
	return dir
}
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

describe("the release waits on the harness and its gate", () => {
	const release = workflow("release.yml")
	const ci = workflow("ci.yml")
	const step = (job: string, text: string): Step | undefined =>
		ci.jobs[job]?.steps?.find((s) => s.run?.includes(text) || s.uses?.startsWith(text))

	it("needs ci.yml upstream of every publish, and ci.yml's conformance job needs its harness job", () => {
		const ciJob = caller(release, "./.github/workflows/ci.yml")
		expect(ciJob).toBeDefined()
		for (const id of jobsRunning(release, "npm publish")) expect([...upstream(release, id)], id).toContain(ciJob)
		expect(jobsRunning(ci, GATE)).toEqual(["conformance"])
		expect([...upstream(ci, "conformance")]).toContain("harness")
		for (const id of ["harness", "conformance"]) {
			expect(ci.jobs[id]?.if, `${id} runs on every event`).toBeUndefined()
			expect(ci.jobs[id]?.["continue-on-error"], `${id} fails its run`).toBeUndefined()
		}
	})

	it("records every cell the harness runs, with every toolchain required, and gates that record", () => {
		const harness = step("harness", "bun run test:harness")
		expect(harness?.env?.HONEY_REQUIRE_TOOLCHAINS).toBe("1")
		const recorded = harness?.env?.HONEY_CONFORMANCE_RECORD
		expect(recorded).toEqual(expect.stringMatching(/\S/))
		const upload = step("harness", "actions/upload-artifact@")
		expect(upload?.with?.path).toBe(recorded)
		expect(upload?.with?.["if-no-files-found"]).toBe("error")
		const download = step("conformance", "actions/download-artifact@")
		expect(download?.with?.name).toBe(upload?.with?.name)
		const gate = step("conformance", GATE)
		expect(gate?.run).toBe(`bun ${GATE} "$CELLS"`)
		expect(gate?.env?.CELLS).toBe(download?.with?.path)
	})
})

/* a two-target grid of one-call cells: the gate's rules, independent of the grid's rows */
const cell = (id: string): Cell => ({
	calls: [call("ping", "GET", `/${id}`)],
	expect: [data({ ok: true })],
	feature: "f",
	id,
	key: `f/${id}`,
})
const GRID = new Map<Target, readonly Cell[]>([
	["go", [cell("a"), cell("b")]],
	["ts", [cell("a")]],
])
const held = (target: Target, key: string): CellRecord => ({
	key,
	observed: [{ data: { ok: true }, kind: "data", status: 200 }],
	target,
	wire: [],
})
const regressed = (target: Target, key: string): CellRecord => ({
	key,
	observed: [{ data: { ok: false }, kind: "data", status: 200 }],
	target,
	wire: [],
})
const lacks = (target: Target, key: string): CellRecord => ({ key, lacks: true, target })

describe("the gate's verdicts on recorded cells", () => {
	it("passes a grid every cell of which a runner held", () => {
		expect(gateProblems(GRID, [held("go", "f/a"), held("go", "f/b"), held("ts", "f/a")])).toEqual([])
	})

	it("blocks a regressed cell with compareCell's line, whatever another runner held", () => {
		const records = [held("go", "f/a"), regressed("go", "f/b"), held("ts", "f/a"), regressed("ts", "f/a")]
		expect(gateProblems(GRID, records)).toEqual([
			"go f/b: regressed: call 0: data.ok: expected true, got false",
			"ts f/a: regressed: call 0: data.ok: expected true, got false",
		])
	})

	it("blocks a cell no runner of its target ran: another target's run does not count", () => {
		expect(gateProblems(GRID, [held("go", "f/a"), held("ts", "f/a"), held("ts", "f/b")])).toEqual(["go f/b: not run"])
	})

	it("passes a cell lacked by design, held by another runner of the target or by none; never a red one", () => {
		expect(gateProblems(GRID, [held("go", "f/a"), lacks("go", "f/b"), lacks("ts", "f/a"), held("ts", "f/a")])).toEqual(
			[],
		)
		expect(
			gateProblems(GRID, [held("go", "f/a"), lacks("go", "f/b"), regressed("go", "f/b"), held("ts", "f/a")]),
		).toEqual(["go f/b: regressed: call 0: data.ok: expected true, got false"])
	})

	it("reads back what the harness records, one file per process; no directory, nothing recorded", () => {
		const dir = scratch()
		const records = [held("go", "f/a"), regressed("go", "f/b"), lacks("ts", "f/a")]
		for (const record of records) recordCell(dir, record)
		recordCell(undefined, held("ts", "f/a"))
		expect(readdirSync(dir)).toEqual([`cells-${process.pid}.jsonl`])
		expect(readRecords(dir)).toEqual(records)
	})
})

/** The gate script on the record under `dir`, as ci.yml's conformance job runs it. */
const gate = (dir: string) => {
	const ran = spawnSync("bun", [GATE, dir], { cwd: ROOT, encoding: "utf8" })
	return { out: `${ran.stdout}${ran.stderr}`, status: ran.status }
}

describe("the gate script over the real grid", () => {
	const total = TARGETS.reduce((n, target) => n + cellsFor(target).length, 0)

	it("blocks a release when the harness recorded nothing: every cell of every target is not run", () => {
		const { out, status } = gate(scratch())
		expect(status).toBe(1)
		const blocked = out.split("\n").filter((line) => line.endsWith(": not run"))
		expect(blocked).toHaveLength(total)
		expect(new Set(blocked.map((line) => line.split(" ")[0]))).toEqual(new Set(TARGETS))
	})

	it("passes once every cell of every target is accounted for, and says how many", () => {
		const dir = scratch()
		for (const target of TARGETS) for (const { key } of cellsFor(target)) recordCell(dir, lacks(target, key))
		const { out, status } = gate(dir)
		expect({ out: out.trim(), status }).toEqual({
			out: `conformance gate: ${total} cells across ${TARGETS.length} targets pass`,
			status: 0,
		})
	})
})
