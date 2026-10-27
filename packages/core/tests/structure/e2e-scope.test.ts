/**
 * The e2e harness is a consumer of `@lovrozagar/honey`, never part of its package: no file under tests/e2e may sit in
 * core's own package scope, where Node and TypeScript resolve `@lovrozagar/honey` as a self-reference to core's own
 * exports (bit 19 i: with core's exports map, stub-ws.ts's type import reached v1's source while the apps reached
 * v0's, and generation broke). Each importing file's nearest package.json names another package, so the import
 * resolves through node_modules as any consumer's does.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const CORE = join(import.meta.dirname, "../..")
const E2E = join(CORE, "tests/e2e")
const IMPORTS_HONEY = /(?:from|import)\s*\(?\s*["']@lovrozagar\/honey(?:\/[^"']*)?["']/

/** Every TypeScript file under `dir`, installed and generated trees left out. */
function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) return ["node_modules", "_gen", ".wrangler"].includes(entry.name) ? [] : sources(path)
		return entry.name.endsWith(".ts") ? [path] : []
	})
}

/** The name in the package.json nearest above `file`: the package scope Node and TypeScript resolve it in. */
function scopeOf(file: string): string | undefined {
	for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
		const manifest = join(dir, "package.json")
		if (existsSync(manifest)) return (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name
	}
	return undefined
}

describe("the e2e harness's package scope (bit 19 i)", () => {
	it("puts no file that imports @lovrozagar/honey inside core's own package, so none self-references it", () => {
		const importing = sources(E2E).filter((file) => IMPORTS_HONEY.test(readFileSync(file, "utf8")))
		expect(importing.length).toBeGreaterThan(0)
		const selfReferencing = importing.filter((file) => scopeOf(file) === "@lovrozagar/honey")
		expect(selfReferencing.map((file) => relative(CORE, file))).toEqual([])
	})
})
