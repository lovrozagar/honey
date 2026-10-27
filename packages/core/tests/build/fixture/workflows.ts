/**
 * The repo's GitHub workflows parsed (js-yaml, test-only), for the release's provenance and conformance-gate legs: a
 * workflow's jobs, a job's upstream through `needs`, and the jobs or steps that run a command.
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"

const jsYaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown }

export const ROOT = resolve(import.meta.dirname, "../../../../..")

export type Step = {
	readonly "continue-on-error"?: unknown
	readonly env?: Readonly<Record<string, string>>
	readonly if?: string
	readonly name?: string
	readonly run?: string
	readonly uses?: string
	readonly with?: Readonly<Record<string, unknown>>
	readonly "working-directory"?: string
}
export type Job = {
	readonly "continue-on-error"?: unknown
	readonly if?: string
	readonly needs?: string | readonly string[]
	readonly permissions?: Readonly<Record<string, string>>
	readonly steps?: readonly Step[]
	readonly uses?: string
}
export type Workflow = {
	readonly jobs: Readonly<Record<string, Job>>
	readonly on: Readonly<Record<string, unknown>>
	readonly permissions?: Readonly<Record<string, string>>
}

/** `.github/workflows/<name>`, parsed. */
export const workflow = (name: string): Workflow =>
	jsYaml.load(readFileSync(join(ROOT, ".github/workflows", name), "utf8")) as Workflow

/** The jobs `id` names in `needs`. */
export const needsOf = (job: Job): readonly string[] =>
	job.needs === undefined ? [] : typeof job.needs === "string" ? [job.needs] : job.needs

/** Every job `id` waits on, directly or through another, in `wf`. */
export function upstream(wf: Workflow, id: string): ReadonlySet<string> {
	const seen = new Set<string>()
	const visit = (job: string) => {
		for (const need of needsOf(wf.jobs[job] ?? {}))
			if (!seen.has(need)) {
				seen.add(need)
				visit(need)
			}
	}
	visit(id)
	return seen
}

/** The steps of every job in `wf` whose script contains `text`, each with its job's id. */
export const stepsRunning = (wf: Workflow, text: string): readonly (Step & { readonly job: string })[] =>
	Object.entries(wf.jobs).flatMap(([job, { steps = [] }]) =>
		steps.filter((step) => step.run?.includes(text)).map((step) => ({ ...step, job })),
	)

/** The ids of the jobs in `wf` with a step whose script contains `text`. */
export const jobsRunning = (wf: Workflow, text: string): readonly string[] => [
	...new Set(stepsRunning(wf, text).map((step) => step.job)),
]

/** The id of the job in `wf` that calls the reusable workflow `path` (`./.github/workflows/ci.yml`), if any. */
export const caller = (wf: Workflow, path: string): string | undefined =>
	Object.entries(wf.jobs).find(([, job]) => job.uses === path)?.[0]
