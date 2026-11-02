/**
 * Every export 0.7.3 shipped and 1.0 does not is judged once, and each one judged `guide` is named in
 * docs/migration.md (bit 22 a). This is the leg the `LoggerInstance` → `Logger` rename and the `logger()`
 * middleware's removal needed: both were silent breaks a consumer met at its own typecheck, with nothing in the
 * guide, and 37 import sites in one app. A removal nobody judged reds here.
 */
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { exportedNames, REMOVED_NAMES, REMOVED_SUBPATHS, removed, surfaceOf } from "./removed-exports.ts"

const REPO = resolve(import.meta.dirname, "../../../..")
const CORE = join(REPO, "packages/core")
const GUIDE = "docs/migration.md"

type Exports = Record<string, { "honey-source"?: string } | string>

/** Each subpath 1.0 exports from source, read through its `honey-source` condition. */
function liveSources(): Record<string, string> {
	const manifest = JSON.parse(readFileSync(join(CORE, "package.json"), "utf8")) as { exports: Exports }
	const out: Record<string, string> = {}
	for (const [subpath, target] of Object.entries(manifest.exports)) {
		const source = typeof target === "object" ? target["honey-source"] : undefined
		if (source !== undefined) out[subpath] = readFileSync(join(CORE, source), "utf8")
	}
	return out
}

const baseline = JSON.parse(readFileSync(join(REPO, "blueprint/baselines/v073-exports.json"), "utf8")) as Record<
	string,
	string[]
>
const live = surfaceOf(liveSources())
const gone = removed(baseline, live)
const guide = readFileSync(join(REPO, GUIDE), "utf8")
/** whether `text` names the identifier `name`, whole-token (a phrase is looked for as written) */
const names = (text: string) => (name: string) =>
	/^[A-Za-z_$][\w$]*$/.test(name) ? new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(text) : text.includes(name)

describe("exportedNames", () => {
	it("reads a list, a re-export, an alias and a declaration alike, and nothing else", () => {
		const source = [
			'export { createLogger, logger } from "./logger.ts"',
			'export type { LogData, LoggerInstance as Logger } from "./logger.ts"',
			"export const SILENT = 1",
			"export function nodeEnv() {}",
			"export class Honey {}",
			"export type LogLevel = string",
			"export interface HoneyCodegen {}",
			"const hidden = 2",
			"export default hidden",
		].join("\n")
		expect([...exportedNames(source)].sort()).toEqual([
			"Honey",
			"HoneyCodegen",
			"LogData",
			"LogLevel",
			"Logger",
			"SILENT",
			"createLogger",
			"logger",
			"nodeEnv",
		])
	})
})

describe("removed", () => {
	it("separates a subpath that went whole from a name a kept subpath lost", () => {
		const old = { ".": ["honey", "trustProxy"], "./trust": ["trustProxy"] }
		const now = { ".": new Set(["honey"]) }
		expect(removed(old, now)).toEqual({ names: ["trustProxy"], subpaths: ["./trust"] })
	})
})

describe("the guide carries every break a 0.7.3 app can meet (bit 22 a)", () => {
	it("reads the pinned 0.7.3 surface and today's, both non-empty", () => {
		expect({
			baseline: Object.keys(baseline).length,
			live: Object.keys(live).length,
			root: live["."]?.size ?? 0,
		}).toEqual({ baseline: 48, live: 59, root: 78 })
	})

	it("judges every removed name, and no name it no longer loses", () => {
		expect({ judged: Object.keys(REMOVED_NAMES).sort(), lost: gone.names }).toEqual({
			judged: gone.names,
			lost: gone.names,
		})
	})

	it("judges every removed subpath, and no subpath it still exports", () => {
		expect(REMOVED_SUBPATHS.map((entry) => entry.subpath).sort()).toEqual(gone.subpaths)
	})

	it("names in the guide every removed name judged `guide`", () => {
		const unnamed = Object.entries(REMOVED_NAMES)
			.filter(([, verdict]) => verdict.kind === "guide")
			.map(([name]) => name)
			.filter((name) => !names(guide)(name))
			.sort()
		expect(unnamed).toEqual([])
	})

	it("says in the guide what covers each removed subpath", () => {
		const uncovered = REMOVED_SUBPATHS.filter((entry) => entry.covers !== null && !names(guide)(entry.covers)).map(
			(entry) => entry.subpath,
		)
		expect(uncovered).toEqual([])
	})

	/* the one subpath the guide may not name: it is judged, it carries its reason, and the guide stays clean of it */
	it("keeps a subpath the guide must not name out of it, with its reason", () => {
		const unnamed = REMOVED_SUBPATHS.filter((entry) => entry.covers === null)
		expect({
			named: unnamed.filter((entry) => guide.includes(entry.subpath)).map((entry) => entry.subpath),
			reasoned: unnamed.every((entry) => (entry.why ?? "").length > 20),
			some: unnamed.length > 0,
		}).toEqual({ named: [], reasoned: true, some: true })
	})

	it("gives every internal a reason, so nothing is dismissed silently", () => {
		const bare = Object.entries(REMOVED_NAMES)
			.filter(([, verdict]) => verdict.kind === "internal" && verdict.why.trim().length < 20)
			.map(([name]) => name)
		expect(bare).toEqual([])
	})
})
