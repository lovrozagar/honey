/**
 * The base the A/B perf gate measures against (bit 22 a1): `blueprint/baselines/perf-base.json`, a pinned commit and
 * nothing else. It replaces bench.json's and build.json's ceilings — a baseline that is a sha cannot go stale against
 * a runner, only against the code, and that staleness is bounded here.
 *
 * Three facts make a base usable, each a leg rather than a habit: it is an ancestor of `origin/main` (so it is code
 * that shipped, not a branch), it carries `bun.lock` (so its tree installs), and it is at most `STALE_AFTER` commits
 * behind main (so a base pinned and forgotten becomes a red, never a widening blind spot). Moving it is the
 * reviewer's commit, and a move must measure itself: see the plan's §1.
 */
import { execFileSync } from "node:child_process"

/** A base move's record: the sha it moved to, when, and every gated scenario's new-over-old ratio. */
export type Move = { moved: string; ratios: Record<string, number>; sha: string }

/** perf-base.json: the pinned base, why it was pinned, and every move before it. */
export type PerfBase = { history: readonly Move[]; note: string; recorded: string; sha: string }

/** How far behind `origin/main` a base may be pinned. 400 is about one bit; main carries 704 commits since v0.7.3. */
export const STALE_AFTER = 400

/** A base move's widest ratio: past it the note must name the bytes behind it (the plan's §1, ruling 1). */
export const DRIFT_BOUND = 1.02

const SHA = /^[0-9a-f]{40}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * perf-base.json read from `text`, or a thrown error naming what it lacks: the sha is a full 40-hex commit, the date
 * is a date, the note is not empty, and history, when present, is a list of moves. A baseline nobody can read is a
 * baseline nobody can check.
 */
export function readPerfBase(text: string): PerfBase {
	const raw = JSON.parse(text) as Partial<PerfBase>
	if (typeof raw.sha !== "string" || !SHA.test(raw.sha)) throw new Error("perf-base.json: sha is not a 40-hex commit")
	if (typeof raw.recorded !== "string" || !DATE.test(raw.recorded))
		throw new Error("perf-base.json: recorded is not a YYYY-MM-DD date")
	if (typeof raw.note !== "string" || raw.note.trim() === "") throw new Error("perf-base.json: note is empty")
	if (raw.history !== undefined && !Array.isArray(raw.history)) throw new Error("perf-base.json: history is not a list")
	return { history: raw.history ?? [], note: raw.note, recorded: raw.recorded, sha: raw.sha }
}

/** What a base's repository says about it: the three facts `unusable` judges. */
export type Placed = { ancestor: boolean; behind: number; lockfile: boolean }

/**
 * Why the base at `sha` cannot be used, or null when it can: every reason, in one message, so one read names them
 * all rather than one per run.
 */
export function unusable(sha: string, { ancestor, behind, lockfile }: Placed): string | null {
	const why = [
		...(ancestor ? [] : [`${sha.slice(0, 7)} is not an ancestor of origin/main`]),
		...(lockfile ? [] : [`${sha.slice(0, 7)} carries no bun.lock`]),
		...(behind > STALE_AFTER
			? [`${sha.slice(0, 7)} is ${behind} commits behind origin/main, past ${STALE_AFTER}`]
			: []),
	]
	return why.length === 0 ? null : `perf-base.json: ${why.join("; ")}`
}

/**
 * Why a move to `sha` is refused, or null: every gated scenario's ratio is at or under DRIFT_BOUND, unless the note
 * names the bytes behind the one that is not. A move with no ratios measured nothing, so it is refused outright.
 */
export function moveRefused(move: Move, note: string): string | null {
	const ratios = Object.entries(move.ratios)
	if (ratios.length === 0) return `perf-base.json: the move to ${move.sha.slice(0, 7)} measured no ratios`
	const over = ratios.filter(([, ratio]) => ratio > DRIFT_BOUND).map(([name, ratio]) => `${name} ${ratio}`)
	if (over.length === 0) return null
	/* the escape hatch is a named cost, as a runtime byte lock's raise is: the note must say "bytes" and what they buy */
	if (/\bbytes\b/.test(note)) return null
	return `perf-base.json: the move to ${move.sha.slice(0, 7)} drifts (${over.join(", ")}), unnamed`
}

/** Each git call's bound: a read of local history, so a second is already far past normal. */
export const GIT_TIMEOUT_MS = 60_000

/** The three facts about `sha`, read from the repository at `root` with git; each call is bounded. */
export function placedAt(root: string, sha: string): Placed {
	const git = (...args: readonly string[]) =>
		execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: GIT_TIMEOUT_MS }).trim()
	const ancestor = (() => {
		try {
			git("merge-base", "--is-ancestor", sha, "origin/main")
			return true
		} catch {
			/* a non-ancestor, or an unknown sha: either way it is not a base */
			return false
		}
	})()
	const lockfile = (() => {
		try {
			return git("cat-file", "-e", `${sha}:bun.lock`) === ""
		} catch {
			/* no such path at that commit */
			return false
		}
	})()
	const behind = (() => {
		try {
			return Number(git("rev-list", "--count", `${sha}..origin/main`))
		} catch {
			/* a sha git cannot count from is as far behind as it gets: unusable, never a thrown read */
			return Number.POSITIVE_INFINITY
		}
	})()
	return { ancestor, behind, lockfile }
}
