/**
 * What a runtime directory holds, as the budget legs and CI's compile-cache keys read it (bit 19 k2): its entries as
 * git sees them, tracked or untracked, never ignored. An ignored entry (a session hook's `.tmp` receipt, twice the
 * cause of a red verify) ships nowhere and is no compile input; an untracked one is a new file nobody registered, and
 * "nothing else beside them" still catches it. Each leg runs in a throwaway repo, never a real runtime directory.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runtimeBytes } from "./sdk-budget.ts"
import { SPAWN_TIMEOUT } from "../src/gen/__fixtures__/spawn-timeout.ts"

const repos: string[] = []
afterEach(() => {
	for (const dir of repos.splice(0)) rmSync(dir, { force: true, recursive: true })
})

/** A git repo holding one tracked `runtime/a.py`, `.tmp/` ignored through .git/info/exclude (no .gitignore entry). */
function runtimeRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "runtime-listing-"))
	repos.push(repo)
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" })
	git("init", "-q")
	writeFileSync(join(repo, ".git/info/exclude"), ".tmp/\n")
	mkdirSync(join(repo, "runtime"))
	writeFileSync(join(repo, "runtime/a.py"), "x = 1\n")
	git("add", "runtime/a.py")
	return join(repo, "runtime")
}

describe("a runtime directory's listing", () => {
	it("leaves out an ignored entry: a hook's .tmp receipt is no runtime file", { timeout: SPAWN_TIMEOUT }, () => {
		const dir = runtimeRepo()
		mkdirSync(join(dir, ".tmp/grunt"), { recursive: true })
		writeFileSync(join(dir, ".tmp/grunt/receipt.txt"), "session\n")
		expect(runtimeBytes(dir, ".py")).toEqual({ bytes: 6, names: ["a.py"], others: [] })
	})

	it(
		"keeps an untracked entry that is not ignored: a new file nobody registered is still caught",
		{ timeout: SPAWN_TIMEOUT },
		() => {
			const dir = runtimeRepo()
			writeFileSync(join(dir, "stray.txt"), "?\n")
			writeFileSync(join(dir, "b.py"), "y = 2\n")
			expect(runtimeBytes(dir, ".py")).toEqual({ bytes: 12, names: ["a.py", "b.py"], others: ["stray.txt"] })
		},
	)
})
