/**
 * Every capability v1 added (bits/20:7) has its own page under docs/capabilities/ (bit 20): a page, an example (a code
 * block other than plain text) and a "Tested by:" line naming the tests that pin it, each one a test that exists.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { blocksOf, DOCS } from "../../../gen/src/emit/shared/__fixtures__/docs-blocks.ts"
import { dangling, rows, tracked } from "./dx.ts"

/** The capabilities v1 added, each with its page under docs/capabilities/. */
const CAPABILITIES = [
	["open media types and response headers", "media-types.md"],
	["range requests", "range.md"],
	["cache-control", "cache-control.md"],
	["rate limiting", "rate-limit.md"],
	["compression", "compress.md"],
	["problem+json errors", "problem-json.md"],
	["webhooks", "webhooks.md"],
	["realtime resume", "realtime-resume.md"],
	["the C# and Java SDKs", "csharp-java-sdks.md"],
	["the generated CLI", "generated-cli.md"],
	["MCP structured output", "mcp-structured-output.md"],
] as const

/** What capability page `page` lacks: the page, an example, a "Tested by:" line, or a test it names that does not exist. */
export function lacking(page: string, markdown: string | undefined): string[] {
	if (markdown === undefined) return [`${page}: no page`]
	const examples = blocksOf(page, markdown).filter((block) => block.info !== "text")
	const tested = markdown.split("\n").findIndex((line) => line.startsWith("Tested by:"))
	const refs =
		tested === -1
			? []
			: [...(markdown.split("\n")[tested] ?? "").matchAll(/`([^`]+)`/g)].map(([, ref]) => ({
					at: `${page}:${tested + 1}`,
					ref: ref as string,
				}))
	return [
		...(examples.length === 0 ? [`${page}: no example`] : []),
		...(refs.length === 0 ? [`${page}: no "Tested by:" test`] : []),
		...dangling(refs, tracked, rows),
	]
}

describe("the new capabilities' pages", () => {
	it("gives each capability v1 added a page, an example and the tests that pin it", () => {
		const read = (page: string) => {
			const path = join(DOCS, "capabilities", page)
			return existsSync(path) ? readFileSync(path, "utf8") : undefined
		}
		expect(CAPABILITIES.flatMap(([, page]) => lacking(page, read(page)))).toEqual([])
	})

	it("reports a page with no example, one with no test, and a test that does not exist", () => {
		const prose = "# Range\n\nTested by: `response/range.test.ts`\n"
		const untested = "# Range\n\n```ts\nexport {}\n```\n"
		const bogus = "# Range\n\n```ts\nexport {}\n```\n\nTested by: `nowhere/range.test.ts`\n"
		expect([
			...lacking("prose.md", prose),
			...lacking("untested.md", untested),
			...lacking("bogus.md", bogus),
			...lacking("absent.md", undefined),
		]).toEqual([
			"prose.md: no example",
			'untested.md: no "Tested by:" test',
			"bogus.md:7 nowhere/range.test.ts",
			"absent.md: no page",
		])
	})
})
