/**
 * The phase-aware tree check (H19.4): files.tsv is the file list, and up to the completed bit the
 * tree matches it exactly. A row whose bit has run must exist (a `src` row with its colocated
 * test); a file under a checked root must have a row whose bit has run or is the one in progress
 * (`COMPLETE + 1`), which lands file by file before it completes.
 */

/** The bit construction has completed. Each bit raises it in the change that completes it; the tree
 * check and the lose-nothing gate both read it. */
export const COMPLETE = 18

export type Row = { bit: number; kind: string; path: string; pkg: string }

type Entry = { bit: number; implicitTest: boolean; pattern: string }

/* rows that name a repo path; any other row is relative to its package */
const REPO_PREFIXES = ["packages/", "bench/", "blueprint/", "_v0/", "."]

/* where an unlisted file is a defect; elsewhere only listed rows are checked */
const CHECKED_ROOTS = [
	"packages/core/src/",
	"packages/core/lint/",
	"packages/core/tests/",
	"packages/gen/src/",
	"packages/gen/tests/",
]

const SOURCE = /\.[cm]?[jt]s$/
const TEST = /\.test\.[cm]?[jt]s$/

function repoPath(path: string, pkg: string): string {
	return REPO_PREFIXES.some((prefix) => path.startsWith(prefix)) ? path : `packages/${pkg}/${path}`
}

export function parseRows(tsv: string): Row[] {
	return tsv
		.split("\n")
		.filter((line) => line.trim() !== "" && !line.startsWith("#") && !line.startsWith("path\t"))
		.map((line) => {
			const [path = "", pkg = "", kind = "", bit = ""] = line.split("\t")
			return { bit: Number(bit), kind, path: repoPath(path, pkg), pkg }
		})
}

/** `a/{b,c}/d` → `a/b/d`, `a/c/d`; every group, left to right. */
function expand(pattern: string): string[] {
	const open = pattern.indexOf("{")
	if (open === -1) return [pattern]
	const close = pattern.indexOf("}", open)
	const head = pattern.slice(0, open)
	const tail = pattern.slice(close + 1)
	return pattern
		.slice(open + 1, close)
		.split(",")
		.flatMap((alt) => expand(`${head}${alt}${tail}`))
}

function covers(pattern: string, file: string): boolean {
	if (pattern.endsWith("/*")) return file.startsWith(pattern.slice(0, -1))
	if (pattern.endsWith("/")) return file.startsWith(pattern)
	return file === pattern || file.startsWith(`${pattern}/`)
}

function entriesOf(rows: readonly Row[]): Entry[] {
	const listed = new Set(rows.flatMap((row) => expand(row.path)))
	return rows.flatMap((row) =>
		expand(row.path).flatMap((pattern) => {
			const entry = { bit: row.bit, implicitTest: false, pattern }
			if (row.kind !== "src" || !SOURCE.test(pattern) || TEST.test(pattern)) return [entry]
			const test = pattern.replace(SOURCE, ".test.ts")
			return listed.has(test) ? [entry] : [entry, { bit: row.bit, implicitTest: true, pattern: test }]
		}),
	)
}

const pad = (bit: number) => String(bit).padStart(2, "0")

export function checkTree(rows: readonly Row[], files: readonly string[], complete: number): string[] {
	const entries = entriesOf(rows)
	const errors: string[] = []
	for (const entry of entries) {
		if (entry.bit > complete || files.some((file) => covers(entry.pattern, file))) continue
		errors.push(`${entry.implicitTest ? "missing test" : "missing"}: ${entry.pattern} (bit ${pad(entry.bit)})`)
	}
	for (const file of files) {
		if (!CHECKED_ROOTS.some((root) => file.startsWith(root))) continue
		const bits = entries.filter((entry) => covers(entry.pattern, file)).map((entry) => entry.bit)
		if (bits.length === 0) errors.push(`unlisted: ${file}`)
		else if (Math.min(...bits) > complete + 1) {
			errors.push(`early: ${file} (bit ${pad(Math.min(...bits))}, complete ${pad(complete)})`)
		}
	}
	return errors
}
