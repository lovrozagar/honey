/**
 * SPAWNING_HELPERS, what honey/spawn-timeout knows of another module, is exactly what the code says: every core and
 * gen module read with spawners.js's own AST walk to a fixed point (spawning-exports.ts), kept to the exports a test
 * file imports. A listed helper that stops spawning and a spawning helper left off both red, so the list cannot rot.
 * And the tree itself: every in-scope test file passes the rule, so a dropped timeout reds here as in lint.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { SPAWN_TIMEOUT } from "../../gen/src/gen/__fixtures__/spawn-timeout.ts"
import { reportsOf } from "./rule-harness.ts"
import { DEFERRED, SPAWNING_HELPERS } from "./spawners.js"
import { importedByTests, modules, spawningExports } from "./spawning-exports.ts"
import { rule } from "./spawn-timeout.js"

const REPO = join(import.meta.dirname, "../../..")

let tracked: string[] | undefined
/* git's tracked files of core and gen: a spawn, so every leg reading them carries the bound */
const files = () =>
	(tracked ??= modules(execFileSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8" }).split("\n")))

const pairs = (map: ReadonlyMap<string, readonly string[]>) =>
	[...map].flatMap(([file, names]) => names.map((name) => `${file} ${name}`)).sort()

describe("SPAWNING_HELPERS", { timeout: SPAWN_TIMEOUT }, () => {
	it("lists only helpers that spawn: each one reaches a spawn in the code", () => {
		const derived = new Set(pairs(spawningExports(files())))
		expect(pairs(SPAWNING_HELPERS).filter((pair) => !derived.has(pair))).toEqual([])
	})

	it("leaves off no spawning helper a test file imports", () => {
		const listed = new Set(pairs(SPAWNING_HELPERS))
		const used = importedByTests(files(), spawningExports(files()))
		expect(pairs(used).filter((pair) => !listed.has(pair))).toEqual([])
	})

	it("defers only exports that still reach a spawn", () => {
		const all = new Set(pairs(spawningExports(files(), true)))
		const deferred = new Map([...DEFERRED].map(([file, names]) => [file, [...names.keys()]]))
		expect(pairs(deferred).filter((pair) => !all.has(pair))).toEqual([])
	})
})

describe("the tree under honey/spawn-timeout", { timeout: SPAWN_TIMEOUT }, () => {
	it("has no test or hook that spawns on vitest's default bound", () => {
		const tests = files().filter((file) => file.endsWith(".test.ts"))
		const fixture = Object.fromEntries(tests.map((file) => [file, readFileSync(join(REPO, file), "utf8")]))
		expect(reportsOf(rule, fixture).map((r) => `${r.file}: ${r.message}`)).toEqual([])
	})
})
