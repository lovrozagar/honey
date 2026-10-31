/**
 * The release's CHANGELOG check (bit 21, the 1.0 notes): a version ships only with its own entry, so a tag whose
 * notes nobody wrote cannot reach npm. release.yml runs it in the pack job, before the packing and before the
 * publish, and `tests/build/changelog.test.ts` runs it against this repository and against fixtures.
 *
 * Usage: `bun scripts/changelog.ts <version>` — it reads `CHANGELOG.md` beside the working directory, prints why the
 * entry does not count, and exits 1. A version with its entry prints nothing and exits 0. A prerelease reads its
 * final release's entry (`1.0.0-rc.1` → `## 1.0.0`), undated; a final release needs that entry dated.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The heading that opens `version`'s entry: `## <version>`, alone while the release is unreleased, or followed by
 * its date once it ships. It is anchored at both ends, so `## 1.0.10` is not `1.0.1`'s entry.
 */
export const headingOf = (version: string): RegExp =>
	new RegExp(String.raw`^## ${version.replaceAll(".", String.raw`\.`)}(?: - \d{4}-\d{2}-\d{2})?$`, "m")

/**
 * The release a version's notes live under: a prerelease shares its final release's entry, so `1.0.0-rc.1` reads
 * `## 1.0.0`. One entry serves the candidates and the release, which is what a reader wants — the notes do not
 * change between rc.1 and the final, and a `## 1.0.0-rc.1` heading would duplicate them.
 */
export const notesFor = (version: string): string => version.split("-")[0] as string

/** Whether `version` is a prerelease: a hyphen after the triple, as semver spells it. */
export const prerelease = (version: string): boolean => version.includes("-")

/**
 * Why `changelog` holds no entry for `version`, or null when it does: a heading, at least one `###` section under
 * it, and at least one bullet. A heading with nothing under it is not notes, so it does not count.
 */
export function missingEntry(changelog: string, version: string): string | null {
	const notes = notesFor(version)
	const heading = headingOf(notes).exec(changelog)
	if (heading === null) return `CHANGELOG.md has no "## ${notes}" entry`
	const body = changelog.slice(heading.index + heading[0].length).split(/^## /m)[0] ?? ""
	if (!/^### \S/m.test(body)) return `CHANGELOG.md's "## ${notes}" entry has no section (### Breaking, ### Added, …)`
	if (!/^- \S/m.test(body)) return `CHANGELOG.md's "## ${notes}" entry lists nothing`
	/* a final release dates its entry; a candidate reads the same entry while it is still undated */
	if (!prerelease(version) && !/ - \d{4}-\d{2}-\d{2}$/.test(heading[0]))
		return `CHANGELOG.md's "## ${notes}" entry is undated: a release dates its entry, a candidate does not`
	return null
}

/** The CLI: the version to check is the one argument, and `CHANGELOG.md` is read from the working directory. */
function main(argv: readonly string[]): number {
	const version = argv[0]
	if (version === undefined || version === "") {
		process.stderr.write("usage: bun scripts/changelog.ts <version>\n")
		return 2
	}
	const why = missingEntry(readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf8"), version)
	if (why === null) return 0
	process.stderr.write(`${why}\n`)
	return 1
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
