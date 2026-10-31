/**
 * A version ships only with its own CHANGELOG entry (bit 21, the 1.0 notes): `scripts/changelog.ts` reads the entry,
 * this repository's own version has one, and release.yml runs the check in the pack job, upstream of every publish.
 * The step itself is run here against a clean and a violating CHANGELOG, so the guard is proven on both paths.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { headingOf, missingEntry, notesFor, prerelease } from "../../../../scripts/changelog.ts"
import { jobsRunning, ROOT, stepsRunning, upstream, workflow } from "./fixture/workflows.ts"
import { SPAWN_TIMEOUT } from "../fixture/spawn-timeout.ts"

const release = workflow("release.yml")
/** the packages whose version the entry must cover; both ship under one tag */
const SHIPPED = ["packages/core", "packages/gen"]
const versionOf = (dir: string) =>
	(JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as { version: string }).version

const ENTRY = "## 1.2.3\n\n### Added\n\n- A thing you can use.\n"
const DATED = ENTRY.replace("## 1.2.3", "## 1.2.3 - 2026-10-31")

describe("an entry read from a CHANGELOG", () => {
	it("takes a dated entry for a release, and an undated one only for a candidate", () => {
		expect(missingEntry(DATED, "1.2.3")).toBeNull()
		expect(missingEntry(ENTRY, "1.2.3-rc.1")).toBeNull()
		expect(missingEntry(ENTRY, "1.2.3")).toBe(
			'CHANGELOG.md\'s "## 1.2.3" entry is undated: a release dates its entry, a candidate does not',
		)
		/* the file's one dated form, nothing else after the version: the date's shape, not its validity */
		expect(headingOf("1.2.3").test("## 1.2.3 (soon)")).toBe(false)
		expect(headingOf("1.2.3").test("## 1.2.3 - soon")).toBe(false)
	})

	it("reads no other version's entry as this one's", () => {
		expect(missingEntry("## 1.2.30\n\n### Added\n\n- A thing.\n", "1.2.3")).toBe('CHANGELOG.md has no "## 1.2.3" entry')
		expect(missingEntry("## 11.2.3\n\n### Added\n\n- A thing.\n", "1.2.3")).toBe('CHANGELOG.md has no "## 1.2.3" entry')
		/* the version is a literal, never a pattern: `1x2x3` does not read `1.2.3`'s entry */
		expect(missingEntry("## 1x2x3\n\n### Added\n\n- A thing.\n", "1.2.3")).toBe('CHANGELOG.md has no "## 1.2.3" entry')
	})

	it("refuses a heading with no section and a section with nothing listed", () => {
		expect(missingEntry("## 1.2.3\n\nSoon.\n", "1.2.3")).toBe(
			'CHANGELOG.md\'s "## 1.2.3" entry has no section (### Breaking, ### Added, …)',
		)
		expect(missingEntry("## 1.2.3\n\n### Added\n\nSoon.\n", "1.2.3")).toBe(
			'CHANGELOG.md\'s "## 1.2.3" entry lists nothing',
		)
	})

	it("reads only its own entry, never the release below it", () => {
		const page = `## 1.2.3\n\n${"## 1.2.2\n\n### Fixed\n\n- An older fix.\n"}`
		expect(missingEntry(page, "1.2.3")).toBe(
			'CHANGELOG.md\'s "## 1.2.3" entry has no section (### Breaking, ### Added, …)',
		)
	})
})

describe("a candidate reads its release's notes", () => {
	it("maps a prerelease to the release it is a candidate for, and says which is which", () => {
		expect(["1.0.0-rc.1", "1.0.0-rc.12", "2.3.4-beta.0", "1.0.0"].map(notesFor)).toEqual([
			"1.0.0",
			"1.0.0",
			"2.3.4",
			"1.0.0",
		])
		expect(["1.0.0-rc.1", "1.0.0"].map(prerelease)).toEqual([true, false])
	})

	it("needs the release's entry, not one of its own", () => {
		expect(missingEntry(ENTRY, "1.2.3-rc.1")).toBeNull()
		/* a `## 1.2.3-rc.1` heading is not what a candidate reads: the release's entry serves it, undated */
		expect(missingEntry("## 1.2.3-rc.1\n\n### Added\n\n- A thing.\n", "1.2.3-rc.1")).toBe(
			'CHANGELOG.md has no "## 1.2.3" entry',
		)
		expect(missingEntry("## 1.2.4\n\n### Added\n\n- A thing.\n", "1.2.3-rc.1")).toBe(
			'CHANGELOG.md has no "## 1.2.3" entry',
		)
	})

	it("holds a candidate to the same sections and bullets as a release", () => {
		expect(missingEntry("## 1.2.3\n\nSoon.\n", "1.2.3-rc.1")).toBe(
			'CHANGELOG.md\'s "## 1.2.3" entry has no section (### Breaking, ### Added, …)',
		)
	})
})

describe("this repository's CHANGELOG", () => {
	const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8")

	it("holds the entry for the version both packages ship", () => {
		const versions = [...new Set(SHIPPED.map(versionOf))]
		expect(versions).toHaveLength(1)
		expect(missingEntry(changelog, versions[0] as string)).toBeNull()
	})

	it("opens on the entry the shipped version reads, which a candidate shares with its release", () => {
		const headings = changelog.split("\n").filter((line) => line.startsWith("## "))
		expect(headings[0]).toBe(`## ${notesFor(versionOf("packages/core"))}`)
	})
})

describe("release.yml runs the check before it publishes", () => {
	const checks = stepsRunning(release, "scripts/changelog.ts")

	it("runs it once, in a job every publish waits on", () => {
		expect(checks).toHaveLength(1)
		const publishing = jobsRunning(release, "npm publish")
		expect(publishing).toHaveLength(1)
		expect([...upstream(release, publishing[0] as string)]).toContain((checks[0] as { job: string }).job)
	})

	it("checks the tag's own version, the leading v cut", () => {
		expect(checks[0]?.run).toContain('"${GITHUB_REF_NAME#v}"')
	})
})

describe("release.yml's CHANGELOG step, run", () => {
	const dirs: string[] = []
	afterAll(() => {
		for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
	})

	/** The step run by bash in a directory holding `changelog`, on tag `refName`. */
	function run(changelog: string, refName: string) {
		const step = stepsRunning(release, "scripts/changelog.ts")[0]
		const dir = mkdtempSync(join(tmpdir(), "honey-changelog-"))
		dirs.push(dir)
		writeFileSync(join(dir, "CHANGELOG.md"), changelog)
		const env = { ...process.env, GITHUB_REF_NAME: refName, GITHUB_WORKSPACE: ROOT }
		const ran = spawnSync("bash", ["-e", "-c", step?.run ?? "exit 99"], { cwd: dir, encoding: "utf8", env })
		return { out: `${ran.stdout}${ran.stderr}`, status: ran.status }
	}

	it("passes on a CHANGELOG holding the tag's dated entry", { timeout: SPAWN_TIMEOUT }, () => {
		expect(run(DATED, "v1.2.3")).toEqual({ out: "", status: 0 })
	})

	it("passes a candidate on the release's undated entry", { timeout: SPAWN_TIMEOUT }, () => {
		expect(run(ENTRY, "v1.2.3-rc.1")).toEqual({ out: "", status: 0 })
	})

	it("refuses a candidate whose release has no entry, naming the release", { timeout: SPAWN_TIMEOUT }, () => {
		const absent = run(ENTRY, "v9.9.9-rc.1")
		expect(absent.status).toBe(1)
		expect(absent.out).toContain('CHANGELOG.md has no "## 9.9.9" entry')
	})

	it("refuses a release whose entry is still undated", { timeout: SPAWN_TIMEOUT }, () => {
		const undated = run(ENTRY, "v1.2.3")
		expect(undated.status).toBe(1)
		expect(undated.out).toContain("entry is undated: a release dates its entry")
	})

	it("refuses a tag whose entry nobody wrote, naming the version", { timeout: SPAWN_TIMEOUT }, () => {
		const absent = run(ENTRY, "v9.9.9")
		expect(absent.status).toBe(1)
		expect(absent.out).toContain('CHANGELOG.md has no "## 9.9.9" entry')
	})

	it("refuses a heading with nothing written under it", { timeout: SPAWN_TIMEOUT }, () => {
		const empty = run("## 1.2.3\n\nSoon.\n", "v1.2.3")
		expect(empty.status).toBe(1)
		expect(empty.out).toContain('"## 1.2.3" entry has no section')
	})
})
