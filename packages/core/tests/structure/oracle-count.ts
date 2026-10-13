/**
 * The oracle count (00-rules "The oracle"): the frozen v0 suite must keep exactly the committed
 * number of passing and skipped cases. A lost case or a silent skip turns no test red, so this
 * runs as a vitest reporter at the end of `bun run test` (HONEY_ORACLE=1) and fails the run.
 */
import { readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import type { Reporter, TestModule } from "vitest/node"

export type Baseline = { flaky: string[]; passed: number; scope: string; skipped: number }
export type Outcome = { name: string; state: "failed" | "passed" | "skipped" }

const REPO = resolve(import.meta.dirname, "../../../..")
const BASELINE_FILE = join(REPO, "blueprint/baselines/oracle-baseline.txt")

export function parseBaseline(text: string): Baseline {
	const settings = new Map<string, string[]>()
	for (const match of text.matchAll(/^oracle\.(\w+): (.*)$/gm)) {
		const [, key = "", value = ""] = match
		settings.set(key, [...(settings.get(key) ?? []), value.trim()])
	}
	const count = (key: string) => {
		const value = settings.get(key)?.[0]
		if (value === undefined) throw new Error(`oracle baseline has no oracle.${key} line`)
		return Number(value)
	}
	return {
		flaky: settings.get("flaky") ?? [],
		passed: count("passed"),
		scope: settings.get("scope")?.[0] ?? "",
		skipped: count("skipped"),
	}
}

export function checkOracle(outcomes: readonly Outcome[], baseline: Baseline): string[] {
	const inScope = outcomes.filter((o) => o.name.startsWith(`${baseline.scope}/`))
	const flaky = new Set(baseline.flaky)
	const errors = inScope.filter((o) => o.state === "failed" && !flaky.has(o.name)).map((o) => `failed: ${o.name}`)
	const passed = inScope.filter((o) => o.state === "passed" || (o.state === "failed" && flaky.has(o.name))).length
	const skipped = inScope.filter((o) => o.state === "skipped").length
	if (passed !== baseline.passed) errors.push(`passed ${passed}, baseline ${baseline.passed}`)
	if (skipped !== baseline.skipped) errors.push(`skipped ${skipped}, baseline ${baseline.skipped}`)
	return errors
}

export default class OracleReporter implements Reporter {
	readonly #baseline: Baseline
	readonly #enforce: boolean
	readonly #write: (line: string) => void

	/* vitest constructs a reporter with its own options object, so every setting is named */
	constructor(options: { baseline?: Baseline; enforce?: boolean; write?: (line: string) => void } = {}) {
		this.#baseline = options.baseline ?? parseBaseline(readFileSync(BASELINE_FILE, "utf8"))
		this.#enforce = options.enforce ?? process.env.HONEY_ORACLE === "1"
		this.#write = options.write ?? ((line) => process.stderr.write(`${line}\n`))
	}

	outcomesOf(modules: readonly TestModule[]): Outcome[] {
		return modules.flatMap((module) => {
			const file = relative(REPO, module.moduleId)
			return [...module.children.allTests()].map((test) => {
				const state = test.result().state
				return { name: `${file} > ${test.fullName}`, state: state === "pending" ? "skipped" : state }
			})
		})
	}

	/** 1 when the run drifted from the baseline (and is enforced), else 0. */
	verdict(modules: readonly TestModule[]): number {
		if (!this.#enforce) return 0
		const errors = checkOracle(this.outcomesOf(modules), this.#baseline)
		for (const error of errors) this.#write(`oracle drift: ${error}`)
		return errors.length === 0 ? 0 : 1
	}

	onTestRunEnd(modules: readonly TestModule[]): void {
		if (this.verdict(modules) === 1) process.exitCode = 1
	}
}
