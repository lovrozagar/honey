/**
 * One vitest run in a child process, reported by name: its exit status and, from vitest's JSON report and its
 * output, each test that failed, each test a dead worker never finished, each file that failed outside its tests
 * and each unhandled error. A gate that says only "171 of 172" sends its reader to rerun it; this one says what.
 *
 * A worker that dies (a crash, an out-of-memory kill) leaves its file "passed" in the JSON report, its running
 * test "pending" and the error only in the output, so both are read.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"

const VITEST = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs")

/** How a run went: vitest's exit status, and by name what went wrong in it. */
export type SuiteRun = {
	/** Each failed test, each test a dead worker never finished, each file failing outside its tests, each unhandled error; empty on a clean run. */
	readonly failures: readonly string[]
	/** vitest's exit status. */
	readonly status: number
}

/** The part of vitest's JSON report read here. */
type JsonReport = {
	testResults: {
		assertionResults: { failureMessages: string[]; fullName: string; status: string }[]
		message: string
		name: string
		status: string
	}[]
}

const UNHANDLED = /⎯+ Unhandled (?:Error|Rejection) ⎯+\n+(.+)/g

/** Why a test is named: its failure's first line, or that a dead worker never let it finish. */
function verdict(status: string, messages: readonly string[]): string {
	return status === "failed" ? `failed: ${firstLine(messages[0] ?? "")}` : "never finished, its worker died under it"
}

function firstLine(text: string): string {
	return text.split("\n")[0] as string
}

/** What `report` and the run's `output` say went wrong, each by name, files relative to `cwd`. */
function failuresIn(report: JsonReport, output: string, cwd: string): string[] {
	const inFiles = report.testResults.flatMap((file) => {
		const at = relative(cwd, file.name)
		const tests = file.assertionResults
			.filter((test) => test.status === "failed" || test.status === "pending")
			.map((test) => `${at} > ${test.fullName}: ${verdict(test.status, test.failureMessages)}`)
		return tests.length === 0 && file.status === "failed" ? [`${at}: ${firstLine(file.message)}`] : tests
	})
	const unhandled = [...output.matchAll(UNHANDLED)].map(([, line]) => `unhandled: ${line}`)
	return [...inFiles.sort(), ...unhandled]
}

/** `vitest run ...args` in `cwd` under `env`, reported by name. A red run always names something. */
export function runVitest(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): SuiteRun {
	const dir = mkdtempSync(join(tmpdir(), "honey-suite-run-"))
	const reportFile = join(dir, "report.json")
	try {
		const reporters = ["--reporter=default", "--reporter=json", `--outputFile.json=${reportFile}`]
		const run = spawnSync(process.execPath, [VITEST, "run", ...args, ...reporters], { cwd, encoding: "utf8", env })
		const report = existsSync(reportFile)
			? (JSON.parse(readFileSync(reportFile, "utf8")) as JsonReport)
			: { testResults: [] }
		const failures = failuresIn(report, `${run.stdout}${run.stderr}`, cwd)
		const status = run.status ?? 1
		if (status !== 0 && failures.length === 0) {
			failures.push(
				run.signal === null ? `vitest exited ${status} with no report` : `vitest was killed by ${run.signal}`,
			)
		}
		return { failures, status }
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
}
