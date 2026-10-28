/**
 * The dx/ contract's reading (bit 20): each dx/ row's test pointers and values, the files that answer a pointer, and
 * the values a docs page leaves out. dx-coverage.test and new-capability.test read through it.
 */
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join, matchesGlob } from "node:path"
import { parseRows } from "../structure/check-tree.ts"
import { REPO } from "../../../gen/src/emit/shared/__fixtures__/docs-blocks.ts"

export const DX = join(REPO, "blueprint/dx")

/** One test pointer: the page and line it sits on, and the path or glob it names. */
export type Pointer = { at: string; ref: string }

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

/**
 * The values of dx/ page `page` no docs page documents: each row's value (the first cell) names what a user passes, by
 * its backticked identifiers or, with none, its words, and every one of them must appear on `docs` (the area's page).
 * A row still proposed ("decision only" in its test cell) documents nothing yet, so it needs no page.
 */
export function undocumented(page: string, markdown: string, docs: string): string[] {
	return markdown.split("\n").flatMap((line, index) => {
		if (!line.startsWith("| ") || line.startsWith("| ---") || line.startsWith("| value ")) return []
		const cells = line.slice(1, -1).split(" | ")
		if (cells.length < 6 || (cells.at(-1) ?? "").includes("decision only")) return []
		const value = (cells[0] ?? "").trim()
		const names = [...value.matchAll(/`([^`]+)`/g)].map(([, name]) => name as string)
		return (names.length > 0 ? names : [value])
			.filter((name) => !docs.includes(name))
			.map((name) => `${page}:${index + 1} ${name}`)
	})
}

/** Every tracked or untracked (never ignored) file under packages/. */
export const tracked = execFileSync(
	"git",
	["ls-files", "--cached", "--others", "--exclude-standard", "--", "packages"],
	{
		cwd: REPO,
		encoding: "utf8",
	},
)
	.split("\n")
	.filter((file) => file !== "")
/** Every files.tsv path. */
export const rows = parseRows(readFileSync(join(REPO, "blueprint/files.tsv"), "utf8")).map((row) => row.path)
/** The dx/ pages. */
export const pages = readdirSync(DX).filter((name) => name.endsWith(".md"))
