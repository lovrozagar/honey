import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { failuresIn, runVitest } from "./suite-run.ts"

const FIXTURE = resolve(import.meta.dirname, "fixtures/suite-run")

/* vitest prints this for the fork dies.case.ts kills only when it beats the run's teardown */
const POOL_ERROR = "unhandled: Error: [vitest-pool]: Worker forks emitted error."

/** vitest's output for one error caught outside a test, under its `type` banner. */
const banner = (type: string, line: string) => `⎯⎯⎯⎯ ${type} ⎯⎯⎯⎯\n${line}\n ❯ at its stack\n`

describe("runVitest: a child vitest run, reported by name", () => {
	it("names each failed test, the test a dead worker never finished, a file that failed and an unhandled error", () => {
		const run = runVitest(FIXTURE, [], process.env)
		expect({ ...run, failures: run.failures.filter((failure) => failure !== POOL_ERROR) }).toEqual({
			failures: [
				"breaks.case.ts: the file breaks before any test",
				"dies.case.ts > takes its worker down: never finished, its worker died under it",
				"fails.case.ts > a suite names its failure: failed: AssertionError: expected 1 to be 2 // Object.is equality",
				"unhandled: Error: thrown from a timer, outside the test",
			],
			status: 1,
		})
	}, 60_000)

	it("names a pool error when vitest prints one, under each banner vitest gives an error outside a test", () => {
		const output = [
			banner("Unhandled Error", "Error: [vitest-pool]: Worker forks emitted error."),
			banner("Uncaught Exception", "Error: from a timer"),
			banner("Unhandled Rejection", "Error: from a promise"),
		].join("\n")
		expect(failuresIn({ testResults: [] }, output, FIXTURE)).toEqual([
			POOL_ERROR,
			"unhandled: Error: from a timer",
			"unhandled: Error: from a promise",
		])
	})

	it("names nothing for a clean run", () => {
		expect(runVitest(FIXTURE, ["passes.case.ts"], process.env)).toEqual({ failures: [], status: 0 })
	}, 60_000)

	it("names a red run that wrote no report: vitest's exit, or the signal that killed it", () => {
		const killed = { ...process.env, NODE_OPTIONS: `--import=${resolve(FIXTURE, "kills-vitest.mjs")}` }
		expect([
			runVitest(FIXTURE, ["--config", "missing.config.ts"], process.env),
			runVitest(FIXTURE, ["passes.case.ts"], killed),
		]).toEqual([
			{ failures: ["vitest exited 1 with no report"], status: 1 },
			{ failures: ["vitest was killed by SIGKILL"], status: 1 },
		])
	}, 60_000)
})
