/**
 * The dx/ pages hold to the code (bit 20): every test a dx/ row names exists, as a files.tsv row, the colocated test of
 * a src row, or a named integration, telemetry or e2e suite. A dangling pointer is a promise no test keeps. The docs
 * half (every dx/ value on a docs page) joins in phase c.
 */
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join, matchesGlob, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { parseRows } from "../structure/check-tree.ts"

const REPO = resolve(import.meta.dirname, "../../../..")
const DX = join(REPO, "blueprint/dx")

/** One dx/ row's test pointer: the page and line it sits on, and the path or glob it names. */
type Pointer = { at: string; ref: string }

/** Every backticked path in the `test` cell (the last column) of each table row of `markdown`, from page `page`. */
export function pointersOf(page: string, markdown: string): Pointer[] {
	return markdown.split("\n").flatMap((line, index) => {
		if (!line.startsWith("| ") || line.startsWith("| ---") || line.startsWith("| value ")) return []
		const cells = line.slice(1, -1).split(" | ")
		if (cells.length < 6) return []
		const test = cells.at(-1) ?? ""
		return [...test.matchAll(/`([^`]+)`/g)].map(([, ref]) => ({ at: `${page}:${index + 1}`, ref: ref as string }))
	})
}

/** Whether `file` answers pointer `ref`: a glob matches it anywhere below, a path is its tail. */
const answers = (ref: string, file: string) =>
	ref.includes("*") ? matchesGlob(file, `**/${ref}`) : file.endsWith(`/${ref}`)

/**
 * The pointers no file answers: a pointer (a path suffix or a glob) answers when it matches a tracked file under
 * packages/ that is a files.tsv row, the colocated test of a src row, or a named integration, telemetry or e2e suite.
 */
export function dangling(pointers: readonly Pointer[], tracked: readonly string[], rows: readonly string[]): string[] {
	const rowSet = new Set(rows)
	const siblings = new Set(
		rows.filter((row) => /(?<!\.test)\.ts$/.test(row)).map((row) => row.replace(/\.ts$/, ".test.ts")),
	)
	const named = (file: string) =>
		rowSet.has(file) || siblings.has(file) || /\/tests\/(integration|telemetry|e2e)\//.test(file)
	return pointers
		.filter(({ ref }) => !tracked.some((file) => named(file) && answers(ref, file)))
		.map(({ at, ref }) => `${at} ${ref}`)
}

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "packages"], {
	cwd: REPO,
	encoding: "utf8",
})
	.split("\n")
	.filter((file) => file !== "")
const rows = parseRows(readFileSync(join(REPO, "blueprint/files.tsv"), "utf8")).map((row) => row.path)
const pages = readdirSync(DX).filter((name) => name.endsWith(".md"))

describe("dx/ pointers", () => {
	it("names only tests that exist, on every dx/ page", () => {
		const pointers = pages.flatMap((page) => pointersOf(page, readFileSync(join(DX, page), "utf8")))
		expect(pointers.length).toBeGreaterThan(100)
		expect(dangling(pointers, tracked, rows)).toEqual([])
	})

	it("reports a pointer no file answers, by its page and line, and keeps one a real test answers", () => {
		const table = [
			"| value | required | default | outcome | pitfall | test |",
			"| --- | --- | --- | --- | --- | --- |",
			"| a | no | — | — | — | `routing/app.test.ts` |",
			"| b | no | — | — | — | `nowhere/bogus.test.ts`, `emit/*/binary.test.ts` |",
		].join("\n")
		expect(dangling(pointersOf("fixture.md", table), tracked, rows)).toEqual(["fixture.md:4 nowhere/bogus.test.ts"])
	})
})
