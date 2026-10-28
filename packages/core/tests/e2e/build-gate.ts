/**
 * The e2e build tier's time gate (bit 21 cfb), two checks per cell:
 *
 * - The regression gate is a RATIO: the cell's build time over a honey-free reference build (reference/), the same
 *   `vite build` on the same runtime and target, timed in the same run-build.ts process on the same runner. CI's
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
 * Reference builds timed per runtime and target in a run-build.ts process, after one untimed warm-up (a cold first
 * build is ~1.36x a warm one here): the median of 5. The reference spreads 1.03-1.08 max/median here; the median
 * of 5 holds the ratio against up to two outlying reference samples for ~0.5 s a target on a slow runner.
 */
export const REFERENCE_SAMPLES = 5

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

/** The recorded baseline, or undefined while it is pending (no file yet). */
export function readBaseline(file: URL = BASELINE_FILE): BuildBaseline | undefined {
	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as BuildBaseline) : undefined
}

/** `record` when BUILD_MODE=record (a calibration run in CI): every ratio printed, none judged. */
export function modeOf(env: Readonly<Record<string, string | undefined>>): "judge" | "record" {
	return env.BUILD_MODE === "record" ? "record" : "judge"
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
	/** The ratio's own verdict, judged whether or not the build hung: REGRESSED fails, recorded and unbaselined never do. */
	status: "ok" | "recorded" | "REGRESSED" | "unbaselined"
}

/**
 * One cell's verdict from its build time and its reference's median, both in ms: two independent checks. The hang
 * guard judges in every mode; the ratio judges only against a recorded ceiling outside record mode. A regression on a
 * slow runner can cross both, and then both are reported.
 */
export function judgeBuild(input: {
	ceiling: BuildCeiling | undefined
	mode: "judge" | "record"
	ms: number
	referenceMs: number
	runtime: RuntimeId
}): Verdict {
	const ratio = Number((input.ms / input.referenceMs).toFixed(2))
	const guard = HANG_GUARD_MS[input.runtime]
	const hung = input.ms > guard
	const failures = hung
		? [`built in ${Math.round(input.ms)}ms, over the ${guard}ms hang guard on ${input.runtime}`]
		: []
	const status =
		input.mode === "record"
			? "recorded"
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

/** One cell's ratio as one parseable line: `RATIO build <runtime>@<version> <cell> <ratio> ms=<ms> ref=<ms>`. */
export function ratioLine(key: string, cell: string, ratio: number, ms: number, referenceMs: number): string {
	return `RATIO build ${key.replace(" ", "@")} ${cell} ${ratio} ms=${Math.round(ms)} ref=${Math.round(referenceMs)}`
}

/** A reference's samples as one parseable line: `REFERENCE build <runtime>@<version> <target> <median> <samples>`. */
export function referenceLine(key: string, target: string, samples: readonly number[]): string {
	return `REFERENCE build ${key.replace(" ", "@")} ${target} ${Math.round(median(samples))} ${samples.map((ms) => Math.round(ms)).join(",")}`
}

/** One RATIO line parsed back: what the derive reads from a CI job's log. */
export type RatioRecord = { cell: string; key: string; ms: number; ratio: number; referenceMs: number }

const RATIO_RE = /^RATIO build (\S+)@(\S+) (\S+) ([\d.]+) ms=(\d+) ref=(\d+)$/

/** Every RATIO line in a log (any prefix before `RATIO`, as a CI log's job and timestamp columns). */
export function parseRatios(log: string): RatioRecord[] {
	const out: RatioRecord[] = []
	for (const line of log.split("\n")) {
		const at = line.indexOf("RATIO build ")
		const match = at === -1 ? null : RATIO_RE.exec(line.slice(at).trim())
		if (match === null) continue
		const [, runtime, version, cell, ratio, ms, ref] = match as unknown as string[]
		out.push({ cell, key: `${runtime} ${version}`, ms: Number(ms), ratio: Number(ratio), referenceMs: Number(ref) })
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
	const values = new Map<string, { byClass: Map<string, number[]>; ratios: number[] }>()
	for (const job of classed) {
		for (const record of job.ratios) {
			const id = `${record.key}\t${record.cell}`
			const entry = values.get(id) ?? { byClass: new Map(), ratios: [] }
			entry.ratios.push(record.ratio)
			entry.byClass.set(job.class, [...(entry.byClass.get(job.class) ?? []), record.ratio])
			values.set(id, entry)
		}
	}
	const out: Record<string, Record<string, BuildCeiling>> = {}
	for (const [id, entry] of [...values].sort(([a], [b]) => a.localeCompare(b))) {
		const [key, cell] = id.split("\t") as [string, string]
		const baseline = Number(median(entry.ratios).toFixed(2))
		const ceiling = Number((Math.max(...entry.ratios) * 1.1).toFixed(2))
		const byClass = Object.fromEntries(
			[...entry.byClass].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, Number(median(v).toFixed(2))]),
		)
		const catches = `+${Math.round((ceiling / baseline - 1) * 100)}%`
		out[key] = { ...out[key], [cell]: { baseline, byClass, catches, ceiling } }
	}
	return out
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
