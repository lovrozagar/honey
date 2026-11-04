/**
 * honey/unversioned-public (plan 39 6.8): no name a package's `exports` reach carries a version suffix, and no export
 * renames a value to one. Through real oxlint, because the rule reads the rest of the package from disk.
 */
import { describe, expect, it } from "vitest"
import { oxlintReports } from "./rule-harness.ts"
import { SPAWN_TIMEOUT } from "../tests/fixture/spawn-timeout.ts"

const MANIFEST = JSON.stringify({ exports: { ".": { "honey-source": "./src/index.ts" } } })

const versioned = (name: string, bare: string) =>
	`\`${name}\` is public through "." and its name carries a version: drop the version: call it \`${bare}\`; a format's version is data, not a name`

function reports(files: Record<string, string>) {
	return oxlintReports("unversioned-public", { "package.json": MANIFEST, ...files })
}

describe("honey/unversioned-public", { timeout: SPAWN_TIMEOUT }, () => {
	it("reports a public declaration and the type it reaches, each where it is declared", () => {
		expect(
			reports({
				"src/index.ts": 'export { generate, type TreeV2 } from "./tree.ts"\n',
				"src/tree.ts": [
					"export type NodeV2 = { c: NodeV2[] }",
					"export type TreeV2 = { root: NodeV2; v: 2 }",
					"export function generate(tree: TreeV2): string { return String(tree.v) }",
					"",
				].join("\n"),
			}),
		).toEqual([
			{ file: "src/tree.ts", message: versioned("NodeV2", "Node") },
			{ file: "src/tree.ts", message: versioned("TreeV2", "Tree") },
		])
	})

	it("reports an export that renames to a version, and leaves internal and unversioned names alone", () => {
		expect(
			reports({
				"src/index.ts": [
					'export { parse as parseV1 } from "./parse.ts"',
					'export { "utf8" as "readV3" } from "./parse.ts"',
					'export { utf8, Http2 } from "./parse.ts"',
					"",
				].join("\n"),
				"src/parse.ts": [
					"export const parse = (): void => {}",
					"export const utf8 = 1",
					"export const Http2 = 2",
					"export const readV1 = (): void => {}",
					"",
				].join("\n"),
			}),
		).toEqual([
			{
				file: "src/index.ts",
				message:
					"`parseV1` is exported under a version: drop the version: call it `parse`; a format's version is data, not a name",
			},
			{
				file: "src/index.ts",
				message:
					"`readV3` is exported under a version: drop the version: call it `read`; a format's version is data, not a name",
			},
		])
	})

	it("reads nothing outside a package that publishes source", () => {
		expect(oxlintReports("unversioned-public", { "loose.ts": "export type TreeV2 = string\n" })).toEqual([])
	})
})
