/**
 * The e2e build tier's time gate (bit 21 cfb), two checks per cell:
 *
 * - The regression gate is a RATIO: the cell's build time over a honey-free reference build (reference/), the same
 *   `vite build` on the same runtime and target, timed around the cell's own builds (build-window.ts). CI's
 *   runners come in classes about 1.6x apart (CI runs 40582174256 and 40754723329: the same commit built surface in
 *   2.7 s on one, 4.6 s on another), so an absolute ceiling either reds on a slow runner or passes a regression on a
 *   fast one; the ratio cancels the runner. The reference is honey-free, not a sibling app: honey generate is ~90% of
 *   every app's build, so a slower generator moves every sibling alike and would cancel out of an app-over-app ratio.
 *   Ceilings come from CI's own record-mode runs across both runner classes (blueprint/baselines/build.json, worst x
 *   1.10, as the bench gates). With no ceiling for a cell the ratio is printed, never judged: report-only.
 * - An absolute HANG GUARD per runtime, not a regression gate: it catches a build that hangs or runs away, whatever
 *   the runner. It judges in every mode.
 *
 * Under BUILD_MODE=record every ratio is printed as a `RATIO` line and never judged: how CI records the ceilings.
 */
import { existsSync, readFileSync } from "node:fs"
import type { RuntimeId } from "./builds.ts"

/**
 * One build's hang guard, in ms, per runtime that runs `vite build`. Bit 19 j2's method (worst local median x CI's
 * factor over this machine x the runtime's spread) with the factor of CI's SLOW runner class, 3.9 (surface x
 * cloudflare: 1.42 s here, 5.5 s in CI run 40754723329), not j2's 1.91 (one fast-class run):
 * - bun 1.3.11: worst median 1.44 s (surface x cloudflare) x 3.9 x 1.33 = 7.5 s -> 8 s.
 * - Node: worst median 2.47 s (surface x bun on Node 22; 2.18 s on 26.12.1; 3 builds of every cell under the heavy
 *   lock) x 3.9 x 1.28 (surface x cloudflare's cold first build over its median, 2771/2168 ms on Node 26.12.1) =
 *   12.3 s -> 13 s. CI's 515 Node cells since j2 built in 1.9-8.2 s.
 * It judges a build once it exits: one that never exits is ci.yml's job timeout's. A build over it is hung or
 * runaway, not merely slow: slowness is the ratio's to judge.
 */
export const HANG_GUARD_MS: Record<RuntimeId, number> = { bun: 8_000, node: 13_000 }

/**
 * App builds per cell, judged on their median: one build is one sample against a median of references, so one
 * slow build read as a regression. CI run 40877110861's build (bun) job built defaults×cloudflare once in 2,949 ms
 * (ratio 21.21, over its 20.98 ceiling) where compose×cloudflare and gateway×cloudflare, which track it within a few %,
 * took 2,472 and 2,501, and its own ×bun and ×node cells read 17.55 and 16.39. Three builds pass one such spike and
 * fail two; the cost is two more builds a cell, about +95 s a build job on CI.
 */
export const BUILD_SAMPLES = 3

/** The key a cell's ceiling is kept under: Bun by minor (CI pins BUN_VERSION), Node by major (CI pins only "22"). */
export function runtimeKey(runtime: RuntimeId, version: string): string {
	const parts = version.replace(/^v/, "").split(".")
	return `${runtime} ${(runtime === "bun" ? parts.slice(0, 2) : parts.slice(0, 1)).join(".")}`
}

/** A cell's recorded ratios: the CI median, the ceiling a run must not pass, and each runner class's median. */
export type BuildCeiling = { baseline: number; byClass: Record<string, number>; catches: string; ceiling: number }

export type BuildBaseline = { builds: Record<string, Record<string, BuildCeiling>>; note: string; runs: string[] }

/** Where the ceilings live; absent until the record runs are derived (derive-build-ceilings.ts). */
export const BASELINE_FILE = new URL("../../../../blueprint/baselines/build.json", import.meta.url)

/** How many cells `baseline` holds a ceiling for: 0 while it is pending or emptied for a re-record (report-only). */
export function recordedCells(baseline: BuildBaseline | undefined): number {
	return Object.values(baseline?.builds ?? {}).reduce((sum, cells) => sum + Object.keys(cells).length, 0)
}

/** The recorded baseline, or undefined while it is pending (no file yet). */
export function readBaseline(file: URL = BASELINE_FILE): BuildBaseline | undefined {
	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as BuildBaseline) : undefined
}

/** How a run treats its ratios: judged, recorded for a re-derive, or reported only (off the runners that recorded them). */
export type BuildMode = "judge" | "local" | "record"

/**
 * Why a run off GitHub Actions only reports its ratios: the ceilings are CI's, recorded on Actions runners, and a
 * machine's ratio is not CI's: the honey-free reference is JS work and the builds are not only that, so a machine
 * shifts the two unequally (this one's references take ~1.3 s on Node and ~1.7 s on Bun, its cells reading 1.0-1.9 on
 * Node and 0.2-1.0 on Bun, bit 21 bref).
 */
export const LOCAL_REASON =
	"ratio report-only off GitHub Actions: ceilings recorded on CI runners, and a machine's ratio is not a CI runner's"

/**
 * The run's mode, from explicit signals only: `record` when BUILD_MODE=record (a calibration dispatch), `judge` on a
 * GitHub Actions runner (GITHUB_ACTIONS=true, which Actions alone sets; a bare CI=true is exported by local tools
 * too), `local` anywhere else, where the ratio is printed and never judged. The hang guard judges in all three.
 */
export function modeOf(env: Readonly<Record<string, string | undefined>>): BuildMode {
	if (env.BUILD_MODE === "record") return "record"
	return env.GITHUB_ACTIONS === "true" ? "judge" : "local"
}

export function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

export type Verdict = {
	/** Why the cell fails, one reason per check that failed: empty when it passes. */
	failures: string[]
	/** Whether the build ran past its runtime's hang guard. */
	hung: boolean
	ratio: number
	/**
	 * The ratio's own verdict, judged whether or not the build hung: REGRESSED fails; recorded (record mode),
	 * report-only (off Actions, LOCAL_REASON) and unbaselined (no ceiling) never do.
	 */
	status: "ok" | "recorded" | "REGRESSED" | "report-only" | "unbaselined"
}

/**
 * One cell's verdict from its builds' times (BUILD_SAMPLES of them) and its reference's median, all in ms: two
 * independent checks. The ratio is the builds' median over the reference's, judged only against a recorded ceiling
 * outside record mode; the hang guard holds every build, in every mode, so one runaway build fails whatever the
 * median. A regression on a slow runner can cross both, and then both are reported.
 */
export function judgeBuild(input: {
	builds: readonly number[]
	ceiling: BuildCeiling | undefined
	mode: BuildMode
	referenceMs: number
	runtime: RuntimeId
}): Verdict {
	const ratio = Number((median(input.builds) / input.referenceMs).toFixed(2))
	const guard = HANG_GUARD_MS[input.runtime]
	const slowest = Math.max(...input.builds)
	const hung = slowest > guard
	const failures = hung ? [`built in ${Math.round(slowest)}ms, over the ${guard}ms hang guard on ${input.runtime}`] : []
	const status =
		input.mode === "record"
			? "recorded"
			: input.mode === "local"
				? "report-only"
				: input.ceiling === undefined
					? "unbaselined"
					: ratio > input.ceiling.ceiling
						? "REGRESSED"
						: "ok"
	if (status === "REGRESSED") {
		failures.push(
			`build ratio ${ratio} over its ${input.ceiling?.ceiling} ceiling (CI median ${input.ceiling?.baseline})`,
		)
	}
	return { failures, hung, ratio, status }
}

/**
 * One cell's ratio as one parseable line, its builds' median as ms and each build after builds= (for diagnosis):
 * `RATIO build <runtime>@<version> <cell> <ratio> ms=<median> ref=<ms> builds=<ms>,<ms>,<ms>`.
 */
export function ratioLine(
	key: string,
	cell: string,
	ratio: number,
	builds: readonly number[],
	referenceMs: number,
): string {
	const each = builds.map((ms) => Math.round(ms)).join(",")
	const ms = median(builds)
	return `RATIO build ${key.replace(" ", "@")} ${cell} ${ratio} ms=${Math.round(ms)} ref=${Math.round(referenceMs)} builds=${each}`
}

/**
 * The references timed around one cell's builds (build-window.ts) as one parseable line, their median the cell's
 * RATIO line's ref=: `REFERENCE build <runtime>@<version> <cell> <median> <ms>,<ms>,<ms>,<ms>`.
 */
export function referenceLine(key: string, cell: string, samples: readonly number[]): string {
	return `REFERENCE build ${key.replace(" ", "@")} ${cell} ${Math.round(median(samples))} ${samples.map((ms) => Math.round(ms)).join(",")}`
}

/** One RATIO line parsed back: what the derive reads from a CI job's log. */
/** One RATIO line parsed back; `builds` only on a line from a median-of-BUILD_SAMPLES run (none before). */
export type RatioRecord = {
	builds?: number[]
	cell: string
	key: string
	ms: number
	ratio: number
	referenceMs: number
}

const RATIO_RE = /^RATIO build (\S+)@(\S+) (\S+) ([\d.]+) ms=(\d+) ref=(\d+)(?: builds=([\d,]+))?$/

/** Every RATIO line in a log (any prefix before `RATIO`, as a CI log's job and timestamp columns). */
export function parseRatios(log: string): RatioRecord[] {
	const out: RatioRecord[] = []
	for (const line of log.split("\n")) {
		const at = line.indexOf("RATIO build ")
		const match = at === -1 ? null : RATIO_RE.exec(line.slice(at).trim())
		if (match === null) continue
		const [, runtime, version, cell, ratio, ms, ref] = match as unknown as string[]
		const builds: string | undefined = match[7]
		const record = {
			cell,
			key: `${runtime} ${version}`,
			ms: Number(ms),
			ratio: Number(ratio),
			referenceMs: Number(ref),
		}
		out.push(builds === undefined ? record : { builds: builds.split(",").map(Number), ...record })
	}
	return out
}

export type RunnerClass = "fast" | "middle" | "slow" | "unclassified"

/**
 * A CI job's runner class, from its own surface builds on bun (each Bun job builds surface: build (bun) for all three
 * targets, e2e (bun prod) and (cf-workers prod) for theirs), their median ms. CI's 87 such cells on main from run
 * 40582174256 to 40754723329 built in 2.4-2.9 s on the fast class, 3.4-3.8 s on a middle one and 4.2-5.5 s on the
 * slow one, and the class is per job: run 40726553833 built it in 2.7 s in build (bun), 4.7 s in cf-workers prod.
 * A job with no surface build on bun is unclassified: Node's 515 cells over the same runs spread 1.9-8.2 s with no
 * gap, so no Node threshold has evidence. Each RATIO line carries its reference's ms, for a re-derive to class by.
 */
export function jobClass(ratios: readonly RatioRecord[]): RunnerClass {
	const surface = ratios.filter((record) => record.key.startsWith("bun ") && record.cell.startsWith("surface×"))
	if (surface.length === 0) return "unclassified"
	const ms = median(surface.map((record) => record.ms))
	if (ms < 3_100) return "fast"
	return ms < 4_000 ? "middle" : "slow"
}

/** The record runs a derive needs: at least 6, their Bun jobs on the fast class and on the slow one. */
export const MIN_RECORD_RUNS = 6

/**
 * The ceilings from record-mode CI jobs (each its run id and its RATIO lines): per runtime key and cell, the median,
 * the worst x 1.10 as the ceiling, and each runner class's median. Throws unless the jobs come from enough runs and
 * their Bun jobs span the fast and slow classes.
 */
export function deriveCeilings(
	jobs: readonly { job: string; ratios: readonly RatioRecord[]; run: string }[],
): Record<string, Record<string, BuildCeiling>> {
	const classed = jobs.map((job) => ({ ...job, class: jobClass(job.ratios) }))
	const runs = new Set(jobs.map((job) => job.run))
	const classes = new Set(classed.map((job) => job.class))
	if (runs.size < MIN_RECORD_RUNS || !classes.has("fast") || !classes.has("slow")) {
		throw new Error(
			`a derive needs ${MIN_RECORD_RUNS}+ record runs whose Bun jobs span the fast and slow runner classes; got ` +
				`${runs.size} runs, classes ${[...classes].sort().join(",")}`,
		)
	}
	const out: Record<string, Record<string, BuildCeiling>> = {}
	for (const [id, samples] of samplesByCell(classed)) {
		const [key, cell] = id.split("\t") as [string, string]
		out[key] = { ...out[key], [cell]: ceilingOf(samples) }
	}
	return out
}

/** One cell's ratio from one job: its runner class and its run. */
type Sample = { class: RunnerClass; ratio: number; run: string }

/** Every cell's samples, keyed `<runtime key>\t<cell>`, in key order. */
function samplesByCell(jobs: readonly { class: RunnerClass; ratios: readonly RatioRecord[]; run: string }[]) {
	const cells = new Map<string, Sample[]>()
	for (const job of jobs) {
		for (const record of job.ratios) {
			const id = `${record.key}\t${record.cell}`
			cells.set(id, [...(cells.get(id) ?? []), { class: job.class, ratio: record.ratio, run: job.run }])
		}
	}
	return [...cells].sort(([a], [b]) => a.localeCompare(b))
}

/** A cell's ceiling from its samples: the median, the worst x 1.10, and each runner class's median. */
function ceilingOf(samples: readonly Sample[]): BuildCeiling {
	const ratios = samples.map((sample) => sample.ratio)
	const baseline = Number(median(ratios).toFixed(2))
	const ceiling = Number((Math.max(...ratios) * 1.1).toFixed(2))
	const byClass = Object.fromEntries(
		classesOf(samples).map((each) => [each, Number(median(ratiosOf(samples, each)).toFixed(2))]),
	)
	return { baseline, byClass, catches: `+${Math.round((ceiling / baseline - 1) * 100)}%`, ceiling }
}

const classesOf = (samples: readonly Sample[]) => [...new Set(samples.map((sample) => sample.class))].sort()
const ratiosOf = (samples: readonly Sample[], runner: RunnerClass) =>
	samples.filter((sample) => sample.class === runner).map((sample) => sample.ratio)

/** One record-mode CI job with its run's head commit and creation time (gh run view's headSha and createdAt). */
export type CommitJob = { commit: string; created: string; job: string; ratios: readonly RatioRecord[]; run: string }

/** A cell's derive across commits: its groups, whether they pooled, and its ceiling or why it has none. */
export type CellDecision = {
	cell: string
	ceiling?: BuildCeiling
	decision: "new-only" | "pooled"
	groups: { classes: Partial<Record<RunnerClass, number>>; commit: string; n: number }[]
	key: string
	/** The samples the ceiling comes from: every group's when pooled, the newest commit's otherwise. */
	n: number
	/** Why the cell gets no ceiling: what its decided samples lack. */
	refused?: string
}

/** Whether `value` lies within `range`'s min-max, both ends included. */
const within = (value: number, range: readonly number[]) => value >= Math.min(...range) && value <= Math.max(...range)

/**
 * Whether two commit groups of one cell measure the same code: each group's median lies within the other's min-max,
 * over the runner classes both carry, each sample divided by its class's centre, the midpoint of the two groups'
 * medians of that class. A slower runner class carries a higher ratio, so classes are centred rather than mixed raw,
 * and each group weighs alike in a centre, so a shift stays visible when the groups' class mixes differ (a centre
 * over all samples sits on whichever group has more of that class and hides it). Simulated on the record runs'
 * class layouts with 4% noise (cfb shift-cause.md), shifted with no shift / caught at +10%: Bun ×bun 3% / 98%,
 * ×cloudflare 6% / 99%, a mix of fast 2 slow 8 against fast 8 slow 2 8% / 97%. Judged class by class instead,
 * Bun's 1-4 samples a class gave ranges too narrow to hold one distribution: 56%, 79% and 80% shifted with no shift.
 * A Node job's class is `unclassified`, one class, so Node compares its plain ratios. Groups with no class in common
 * cannot be shown to agree.
 */
function agree(a: readonly Sample[], b: readonly Sample[]): boolean {
	const shared = classesOf(a).filter((each) => classesOf(b).includes(each))
	if (shared.length === 0) return false
	const centre = new Map(shared.map((each) => [each, (median(ratiosOf(a, each)) + median(ratiosOf(b, each))) / 2]))
	const centred = (samples: readonly Sample[]) =>
		samples.flatMap((sample) => {
			const by = centre.get(sample.class)
			return by === undefined ? [] : [sample.ratio / by]
		})
	const [x, y] = [centred(a), centred(b)]
	return within(median(x), y) && within(median(y), x)
}

/**
 * What a cell's decided samples lack for a ceiling under `key`: 6+ runs carrying the cell, and on Bun, as
 * deriveCeilings asks, the fast and the slow runner class among the Bun jobs of the commits they come from
 * (`classes`): a cell built in one job per run (a Bun ×node cell, build (bun) alone) would otherwise wait on that one
 * job landing on a fast runner.
 */
function lacks(key: string, samples: readonly Sample[], classes: readonly RunnerClass[]): string | undefined {
	const runs = new Set(samples.map((sample) => sample.run)).size
	const missing = [
		...(runs < MIN_RECORD_RUNS ? [`fewer than ${MIN_RECORD_RUNS}`] : []),
		...(key.startsWith("bun ") ? (["fast", "slow"] as const).filter((each) => !classes.includes(each)) : []).map(
			(each) => `no ${each} Bun job`,
		),
	]
	return missing.length === 0 ? undefined : `${runs} runs, ${missing.join(", ")}`
}

/**
 * The ceilings from record runs spanning code versions, cell by cell. Each cell's samples are grouped by their run's
 * head commit; when every two groups agree (agree) they pool, else the cell is derived from the newest commit's group
 * alone (newest by its latest run's creation), since a changed app's older runs measure other code. Either way the
 * decided samples need 6+ runs and, on Bun, both runner classes, or the cell is refused, naming what it lacks.
 */
export function deriveByCommit(jobs: readonly CommitJob[]): CellDecision[] {
	const latest = new Map<string, string>()
	for (const job of jobs) {
		if ((latest.get(job.commit) ?? "") < job.created) latest.set(job.commit, job.created)
	}
	const commits = [...latest].sort(([, a], [, b]) => a.localeCompare(b)).map(([commit]) => commit)
	const commitOf = new Map(jobs.map((job) => [job.run, job.commit]))
	const classesAt = (at: readonly string[]) =>
		[...new Set(jobs.filter((job) => at.includes(job.commit)).map((job) => jobClass(job.ratios)))].sort()
	return samplesByCell(jobs.map((job) => ({ ...job, class: jobClass(job.ratios) }))).map(([id, samples]) => {
		const [key, cell] = id.split("\t") as [string, string]
		const groups = commits
			.map((commit) => ({ commit, samples: samples.filter((sample) => commitOf.get(sample.run) === commit) }))
			.filter((group) => group.samples.length > 0)
		const pooled = groups.every((group, i) => groups.slice(i + 1).every((other) => agree(group.samples, other.samples)))
		const newest = groups.at(-1) as (typeof groups)[number]
		const decided = pooled ? samples : newest.samples
		const missing = lacks(key, decided, classesAt(pooled ? commits : [newest.commit]))
		const decision = pooled ? ("pooled" as const) : ("new-only" as const)
		return {
			cell,
			...(missing === undefined ? { ceiling: ceilingOf(decided) } : {}),
			decision,
			groups: groups.map((group) => ({
				classes: Object.fromEntries(
					classesOf(group.samples).map((each) => [each, ratiosOf(group.samples, each).length]),
				),
				commit: group.commit,
				n: group.samples.length,
			})),
			key,
			n: decided.length,
			...(missing === undefined
				? {}
				: { refused: `${key} ${cell}: ${pooled ? "pooled" : `new-only from ${newest.commit}`}: ${missing}` }),
		}
	})
}

/** Cells of `cells` with no ceiling under each of `keys`: what a baseline still lacks. */
export function missingCeilings(
	baseline: BuildBaseline | undefined,
	keys: readonly string[],
	cells: readonly string[],
): string[] {
	return keys.flatMap((key) =>
		cells.filter((cell) => baseline?.builds[key]?.[cell] === undefined).map((cell) => `${key} ${cell}`),
	)
}
