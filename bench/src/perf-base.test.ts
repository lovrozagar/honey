/**
 * The A/B gate's base (bit 22 a1): perf-base.json is read or refused by what it lacks, a base is usable only when it
 * is an ancestor of origin/main with a lockfile and inside the staleness bound, a move must measure itself, and the
 * base this repository pins passes all three against real git.
 */
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { DRIFT_BOUND, type Move, moveRefused, placedAt, readPerfBase, STALE_AFTER, unusable } from "./perf-base.ts"

const ROOT = resolve(import.meta.dirname, "../..")
const FILE = join(ROOT, "blueprint/baselines/perf-base.json")
const PINNED = { ancestor: true, behind: 1, known: true, lockfile: true, shallow: false }
const SHA = "43a4462c0ffee43a4462c0ffee43a4462c0ffee0"

describe("perf-base.json, read", () => {
	it("takes a base with its sha, date, note and history", () => {
		const text = JSON.stringify({ history: [], note: "the 1.0 notes tip", recorded: "2026-10-31", sha: SHA })
		expect(readPerfBase(text)).toEqual({ history: [], note: "the 1.0 notes tip", recorded: "2026-10-31", sha: SHA })
	})

	it("defaults history to empty, since the first base has moved from nothing", () => {
		const text = JSON.stringify({ note: "the first base", recorded: "2026-10-31", sha: SHA })
		expect(readPerfBase(text).history).toEqual([])
	})

	it("refuses a short sha, a branch name, a bad date, an empty note and a history that is not a list", () => {
		const base = { history: [], note: "n", recorded: "2026-10-31", sha: SHA }
		const refuse = (over: Record<string, unknown>) => () => readPerfBase(JSON.stringify({ ...base, ...over }))
		expect(refuse({ sha: "43a4462" })).toThrow("sha is not a 40-hex commit")
		expect(refuse({ sha: "main" })).toThrow("sha is not a 40-hex commit")
		expect(refuse({ sha: SHA.toUpperCase() })).toThrow("sha is not a 40-hex commit")
		expect(refuse({ recorded: "31-10-2026" })).toThrow("recorded is not a YYYY-MM-DD date")
		expect(refuse({ note: "  " })).toThrow("note is empty")
		expect(refuse({ history: {} })).toThrow("history is not a list")
	})
})

describe("whether a base can be used", () => {
	it("takes a pinned ancestor with a lockfile inside the bound", () => {
		expect(unusable(SHA, PINNED)).toBeNull()
		expect(unusable(SHA, { ...PINNED, behind: STALE_AFTER })).toBeNull()
	})

	it("refuses a base that is not an ancestor, carries no lockfile, or is past the staleness bound", () => {
		expect(unusable(SHA, { ...PINNED, ancestor: false })).toBe(
			"perf-base.json: 43a4462 is not an ancestor of origin/main",
		)
		expect(unusable(SHA, { ...PINNED, lockfile: false })).toBe("perf-base.json: 43a4462 carries no bun.lock")
		expect(unusable(SHA, { ...PINNED, behind: STALE_AFTER + 1 })).toBe(
			`perf-base.json: 43a4462 is ${STALE_AFTER + 1} commits behind origin/main, past ${STALE_AFTER}`,
		)
	})

	it("names every reason at once, so one read is the whole answer", () => {
		expect(unusable(SHA, { ancestor: false, behind: 9_000, known: true, lockfile: false, shallow: false })).toBe(
			"perf-base.json: 43a4462 is not an ancestor of origin/main; 43a4462 carries no bun.lock; 43a4462 is 9000 commits behind origin/main, past 400",
		)
	})
})

/** A move of the pinned sha, carrying `ratios`. */
const move = (ratios: Record<string, number>): Move => ({ moved: "2026-10-31", ratios, sha: SHA })

describe("a base move measures itself", () => {
	it("takes a move whose every ratio is inside the drift bound", () => {
		expect(moveRefused(move({ "hotpath static": 1.0, "streaming sse-1k": DRIFT_BOUND }), "routine")).toBeNull()
	})

	it("refuses a move that measured nothing", () => {
		expect(moveRefused(move({}), "routine")).toBe("perf-base.json: the move to 43a4462 measured no ratios")
	})

	it("refuses a drifting move whose note names no cost, and takes one that does", () => {
		const drifted = move({ "hotpath static": 1.08, "streaming sse-1k": 1.0 })
		expect(moveRefused(drifted, "routine")).toBe(
			"perf-base.json: the move to 43a4462 drifts (hotpath static 1.08), unnamed",
		)
		expect(moveRefused(drifted, "+1,169 bytes for the realtime send's POST")).toBeNull()
	})
})

describe("the base this repository pins", () => {
	it("is an ancestor of origin/main, carries a lockfile and is inside the staleness bound", () => {
		const { sha } = readPerfBase(readFileSync(FILE, "utf8"))
		const placed = placedAt(ROOT, sha)
		expect({ reason: unusable(sha, placed), ...placed }).toEqual({
			ancestor: true,
			behind: placed.behind,
			known: true,
			lockfile: true,
			reason: null,
			shallow: false,
		})
		expect(placed.behind).toBeLessThanOrEqual(STALE_AFTER)
	})

	it("reads a commit this clone does not hold as unusable, so the live leg is not vacuous", () => {
		const absent = "0000000000000000000000000000000000000000"
		const placed = placedAt(ROOT, absent)
		expect(placed).toEqual({
			ancestor: false,
			behind: Number.POSITIVE_INFINITY,
			known: false,
			lockfile: false,
			shallow: false,
		})
		expect(unusable(absent, placed)).toBe("perf-base.json: 0000000 is not a commit in this clone")
	})

	/*
	 * The clone, before the base. CI's first run of this guard red as "43a4462 is not an ancestor of origin/main" on a
	 * depth-1 checkout that simply did not hold the commit (run 41145247987, the `test` job). The cause is the job's
	 * fetch depth, so the message names it; perf-base-history.test.ts holds every job that reads this to full history.
	 */
	it("blames the clone, not the base, when the commit is missing from a shallow one", () => {
		expect(
			unusable(SHA, {
				ancestor: false,
				behind: Number.POSITIVE_INFINITY,
				known: false,
				lockfile: false,
				shallow: true,
			}),
		).toBe("perf-base.json: this clone is shallow and does not hold 43a4462: the job needs fetch-depth: 0")
	})
})
