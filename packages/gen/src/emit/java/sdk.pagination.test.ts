/**
 * C1 is cut (H20, 01-decisions:165): pagination is the API author's alone, so the Java SDK has no pagination surface
 * (bit 16 phase f, the close's C1 row). No file the emitter writes, for any fixture or any e2e app, in either style,
 * spells a pager, a next-page call or an auto-paging iterator: a cursor field is only a stream's resume cursor.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { FIXTURES, type FixtureKey, type JavaFixture } from "./__fixtures__/documents.ts"
import { generateJavaSdk } from "./sdk.ts"

const APPS = ["compose", "defaults", "gateway", "kitchen", "surface"] as const
const REPO = join(import.meta.dirname, "../../../../..")
/** A pagination surface's words, in any casing: a pager, a next page, auto-paging. */
const PAGINATION = /paginat|pager\b|nextpage|hasnextpage|autopag|iteratepages|pageiterator|listall/i

/** Each document the gates build, by name: every fixture and every e2e app (each SDK holds both styles, bit 21 i6). */
function documents(): [string, Record<string, unknown>][] {
	const fixtures = (Object.keys(FIXTURES) as FixtureKey[]).map((key): [string, Record<string, unknown>] => {
		const fixture: JavaFixture = FIXTURES[key]
		return [key, fixture.document()]
	})
	const apps = APPS.map((app): [string, Record<string, unknown>] => [
		app,
		JSON.parse(
			readFileSync(join(REPO, `packages/core/tests/e2e/apps/${app}/src/_gen/openapi.gen.json`), "utf8"),
		) as Record<string, unknown>,
	])
	return [...fixtures, ...apps]
}

describe("generateJavaSdk: no pagination surface (C1 cut, H20)", () => {
	/* new: phase f, the close's C1 row */
	it("writes no pager, next-page call or auto-paging iterator in any SDK the gates build", () => {
		const found = documents().flatMap(([name, document]) =>
			Object.entries(generateJavaSdk(document).files)
				.filter(([, text]) => PAGINATION.test(text))
				.map(([path]) => `${name}: ${path}`),
		)
		expect(found).toEqual([])
	})
})
