/**
 * honey validates, converts and types schemas only through Standard Schema (F2): no file it ships
 * imports a validator vendor. zod and valibot are test-only devDependencies, there so the vendor
 * fallbacks are pinned against the real libraries.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const SRC = join(import.meta.dirname, "../../src")
const VENDORS = ["zod", "valibot", "arktype", "effect", "yup"]
/* a static or dynamic import, or a re-export, of a vendor or one of its subpaths */
const VENDOR_IMPORT = new RegExp(`(?:from|import)\\s*\\(?\\s*["'](?:${VENDORS.join("|")})(?:/[^"']*)?["']`)

/** Every source file under src/, its colocated tests left out. */
function shipped(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) return shipped(path)
		return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : []
	})
}

describe("no shipped file imports a validator vendor (F2)", () => {
	it("src/ imports none of zod, valibot, arktype, effect or yup", () => {
		const offenders = shipped(SRC).filter((file) => VENDOR_IMPORT.test(readFileSync(file, "utf8")))
		expect(offenders.map((file) => relative(SRC, file))).toEqual([])
	})

	it.each([
		'import * as z from "zod"',
		"import { object } from 'valibot'",
		'export { type } from "arktype"',
		'const m = await import("zod/v4")',
		'import { Schema } from "effect"',
	])("the check catches %s", (line) => {
		expect(VENDOR_IMPORT.test(line)).toBe(true)
	})

	it.each(['import { z } from "./zod-like.ts"', "// zod and valibot are fine to mention"])("and ignores %s", (line) => {
		expect(VENDOR_IMPORT.test(line)).toBe(false)
	})
})
