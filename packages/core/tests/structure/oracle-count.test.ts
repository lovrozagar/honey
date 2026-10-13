import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import OracleReporter, { checkOracle, type Outcome, parseBaseline } from "./oracle-count.ts"

const REPO = resolve(import.meta.dirname, "../../../..")
const FLAKY = "_v0/tests/unit/plugin/cli.test.ts > generate > binds no port"

const BASELINE = parseBaseline(
	[
		"prose that is not a setting",
		"oracle.scope: _v0/tests",
		"oracle.passed: 3",
		"oracle.skipped: 1",
		`oracle.flaky: ${FLAKY}`,
		"",
	].join("\n"),
)

const ok = (name: string): Outcome => ({ name: `_v0/tests/a.test.ts > ${name}`, state: "passed" })
const RUN: Outcome[] = [
	ok("one"),
	ok("two"),
	{ name: FLAKY, state: "passed" },
	{ name: "_v0/tests/b.test.ts > s", state: "skipped" },
]

describe("parseBaseline", () => {
	it("reads the oracle.* lines and ignores the prose around them", () => {
		expect(BASELINE).toEqual({ flaky: [FLAKY], passed: 3, scope: "_v0/tests", skipped: 1 })
	})

	it("reads the committed baseline", () => {
		const committed = parseBaseline(readFileSync(join(REPO, "blueprint/baselines/oracle-baseline.txt"), "utf8"))
		expect(committed).toMatchObject({ passed: 6713, scope: "_v0/tests", skipped: 40 })
		expect(committed.flaky).toHaveLength(1)
	})

	it("refuses a baseline without its counts", () => {
		expect(() => parseBaseline("oracle.scope: _v0/tests\n")).toThrow(/oracle.passed/)
	})
})

describe("checkOracle", () => {
	it("passes a run that matches the baseline", () => {
		expect(checkOracle(RUN, BASELINE)).toEqual([])
	})

	it("counts a listed flaky case as passed when it fails", () => {
		const run = RUN.map((o) => (o.name === FLAKY ? { ...o, state: "failed" as const } : o))
		expect(checkOracle(run, BASELINE)).toEqual([])
	})

	it("fails on a lost case", () => {
		expect(checkOracle(RUN.slice(1), BASELINE)).toEqual(["passed 2, baseline 3"])
	})

	it("fails on a silent skip, which no test turns red", () => {
		const run = RUN.map((o) => (o.name.endsWith("> one") ? { ...o, state: "skipped" as const } : o))
		expect(checkOracle(run, BASELINE)).toEqual(["passed 2, baseline 3", "skipped 2, baseline 1"])
	})

	it("fails on a failure that is not listed as flaky", () => {
		const run = RUN.map((o) => (o.name.endsWith("> two") ? { ...o, state: "failed" as const } : o))
		expect(checkOracle(run, BASELINE)).toEqual(["failed: _v0/tests/a.test.ts > two", "passed 2, baseline 3"])
	})

	it("counts only the oracle's scope", () => {
		const run = [...RUN, { name: "packages/core/tests/x.test.ts > v1", state: "passed" as const }]
		expect(checkOracle(run, BASELINE)).toEqual([])
	})
})

const testCase = (name: string, state: string) => ({ fullName: name, result: () => ({ state }) })

describe("OracleReporter", () => {
	const testModule = (file: string, cases: ReturnType<typeof testCase>[]) => ({
		children: { allTests: () => cases },
		moduleId: join(REPO, file),
	})
	const modules = [
		testModule("_v0/tests/a.test.ts", [testCase("one", "passed"), testCase("two", "passed")]),
		testModule("_v0/tests/unit/plugin/cli.test.ts", [testCase("generate > binds no port", "failed")]),
		testModule("_v0/tests/b.test.ts", [testCase("s", "skipped")]),
	]

	it("names each case by its repo-relative file and full name", () => {
		expect(new OracleReporter({ baseline: BASELINE, enforce: true }).outcomesOf(modules as never)).toEqual([
			{ name: "_v0/tests/a.test.ts > one", state: "passed" },
			{ name: "_v0/tests/a.test.ts > two", state: "passed" },
			{ name: FLAKY, state: "failed" },
			{ name: "_v0/tests/b.test.ts > s", state: "skipped" },
		])
	})

	it("fails the run on drift when enforcing, and stays quiet otherwise", () => {
		const report: string[] = []
		const enforcing = new OracleReporter({ baseline: BASELINE, enforce: true, write: (line) => report.push(line) })
		expect(enforcing.verdict(modules.slice(0, 1) as never)).toBe(1)
		expect(report).toEqual(["oracle drift: passed 2, baseline 3", "oracle drift: skipped 0, baseline 1"])
		expect(enforcing.verdict(modules as never)).toBe(0)
		expect(new OracleReporter({ baseline: BASELINE, enforce: false }).verdict(modules.slice(0, 1) as never)).toBe(0)
	})
})
