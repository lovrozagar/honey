/**
 * Every ci.yml job that reads the perf base out of git declares full history (bit 22 a1 fix-up). The base is a
 * pinned commit, so its readers ask git whether that commit is an ancestor of origin/main, whether it carries
 * bun.lock, and how far behind it is — questions a depth-1 checkout cannot answer. CI run 41145247987 red exactly
 * there: the `test` job's shallow clone did not hold 43a4462, and the guard reported the base as "not an ancestor"
 * when the cause was the fetch depth.
 *
 * Two halves, so neither side can rot:
 *
 * - every job with a step running one of `READERS` checks out with `fetch-depth: 0`;
 * - every file that reaches `bench/src/perf-base.ts` through imports sits under a root `READERS` covers, so a new
 *   reader somewhere else reds here and its author has to say which job runs it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { ROOT, type Step, workflow } from "./fixture/workflows.ts"

const ci = workflow("ci.yml")

/** The commands that reach the perf base's readers, each with the root whose files they run. */
const READERS = [
	{ command: "bun run test:bench", root: "bench/src" },
	/* phase b adds the five bench entries and the e2e build runner; each lands here with its job */
] as const

const CHECKOUT = "actions/checkout@"

/** Each job's steps, with the job's id. */
const stepsOf = (): readonly (Step & { readonly job: string })[] =>
	Object.entries(ci.jobs).flatMap(([job, { steps = [] }]) => steps.map((step) => ({ ...step, job })))

/** The jobs whose steps run `command`. */
const jobsRunning = (command: string): readonly string[] => [
	...new Set(
		stepsOf()
			.filter((step) => step.run?.includes(command))
			.map((step) => step.job),
	),
]

/** `<job>` for each job in `jobs` whose checkout does not ask for full history. */
function shallowCheckouts(jobs: readonly string[]): string[] {
	return jobs.filter((job) => {
		const checkouts = (ci.jobs[job]?.steps ?? []).filter((step) => step.uses?.startsWith(CHECKOUT))
		return checkouts.length === 0 || checkouts.some((step) => step.with?.["fetch-depth"] !== 0)
	})
}

/** Every `.ts` file under `dir`, repo-relative. */
function filesUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name)
		if (statSync(path).isDirectory()) return name === "node_modules" ? [] : filesUnder(path)
		return path.endsWith(".ts") ? [relative(ROOT, path)] : []
	})
}

/** Each file's own imports, as repo-relative paths, for the files this repository writes (relative specifiers only). */
function importsOf(file: string): string[] {
	const text = readFileSync(join(ROOT, file), "utf8")
	const dir = join(file, "..")
	return [...text.matchAll(/(?:^|\n)(?:import|export)[^"'\n]*["'](\.[^"']+)["']/g)].map(([, spec]) =>
		relative(ROOT, resolve(ROOT, dir, spec as string)),
	)
}

/** Every file that reaches `target` through imports, directly or through another, repo-relative and sorted. */
export function reaching(target: string, files: readonly string[]): string[] {
	const edges = new Map(files.map((file) => [file, importsOf(file)] as const))
	const found = new Set<string>()
	let grew = true
	while (grew) {
		grew = false
		for (const [file, imports] of edges)
			if (!found.has(file) && imports.some((spec) => spec === target || found.has(spec))) {
				found.add(file)
				grew = true
			}
	}
	return [...found].sort()
}

describe("the perf base's readers run with full history (bit 22)", () => {
	it("checks out full history in every job that runs one", () => {
		for (const { command } of READERS) {
			const jobs = jobsRunning(command)
			expect(jobs, command).not.toEqual([])
			expect(shallowCheckouts(jobs), command).toEqual([])
		}
	})

	it("reads a job with no fetch-depth, and one that asks for a depth, as shallow", () => {
		const jobs = jobsRunning("bun run test:bench")
		expect(jobs).toEqual(["test"])
		/* the rule's own shape: only `fetch-depth: 0` counts, since 1 and 50 are both depths a base can fall outside */
		expect(shallowCheckouts(["lint"])).toEqual(["lint"])
	})

	it("keeps every reader of the base under a root a job is named for", () => {
		const roots = READERS.map(({ root }) => root)
		const searched = roots.flatMap((root) => filesUnder(join(ROOT, root)))
		const readers = reaching("bench/src/perf-base.ts", [
			...searched,
			...filesUnder(join(ROOT, "packages/core/tests")),
			...filesUnder(join(ROOT, "packages/core/src")),
		])
		expect(readers.filter((file) => !roots.some((root) => file.startsWith(`${root}/`)))).toEqual([])
		/* and it is not vacuous: the base's own test reaches it */
		expect(readers).toContain("bench/src/perf-base.test.ts")
	})
})
