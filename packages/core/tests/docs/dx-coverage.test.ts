/**
 * The dx/ pages hold to the code (bit 20): every test a dx/ row names exists, as a files.tsv row, the colocated test of
 * a src row, or a named integration, telemetry or e2e suite. A dangling pointer is a promise no test keeps. And every
 * dx/ value appears on its area's page under docs/, so no public value goes undocumented.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { REPO } from "../../../gen/src/emit/shared/__fixtures__/docs-blocks.ts"
import { DX, dangling, pages, pointersOf, rows, tracked, undocumented } from "./dx.ts"

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

describe("dx/ values on docs pages", () => {
	it("documents every dx/ value on its area's docs page (docs/<area>.md)", () => {
		const missing = pages
			.filter((page) => page !== "README.md")
			.flatMap((page) => {
				const docs = join(REPO, "docs", page)
				const text = existsSync(docs) ? readFileSync(docs, "utf8") : ""
				return undocumented(page, readFileSync(join(DX, page), "utf8"), text)
			})
		expect(missing).toEqual([])
	})

	it("reports a value its page leaves out, by its dx/ page and line, and skips a row still proposed", () => {
		const table = [
			"| value | required | default | outcome | pitfall | test |",
			"| --- | --- | --- | --- | --- | --- |",
			"| `cors(options)` / `csrf(options)` | no | — | — | — | `middleware/cors.test.ts` |",
			"| trailing slash | — | — | — | — | `routing/request-path.test.ts` |",
			"| `:id(\\d+)` | no | off | **proposed** | — | decision only (bit 01) |",
		].join("\n")
		const docs = "Use `cors(options)` for cross-origin calls."
		expect(undocumented("fixture.md", table, docs)).toEqual([
			"fixture.md:3 csrf(options)",
			"fixture.md:4 trailing slash",
		])
	})
})
