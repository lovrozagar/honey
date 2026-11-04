import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { runVitest } from "./suite-run.ts"

const FIXTURE = resolve(import.meta.dirname, "fixtures/suite-run")

describe("runVitest: a child vitest run, reported by name", () => {
	it("names each failed test, the test a dead worker never finished, a file that failed and the unhandled error", () => {
		expect(runVitest(FIXTURE, [], process.env)).toEqual({
			failures: [
				"breaks.case.ts: the file breaks before any test",
				"dies.case.ts > takes its worker down: never finished, its worker died under it",
				"fails.case.ts > a suite names its failure: failed: AssertionError: expected 1 to be 2 // Object.is equality",
				"unhandled: Error: [vitest-pool]: Worker forks emitted error.",
			],
			status: 1,
		})
	}, 60_000)

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
