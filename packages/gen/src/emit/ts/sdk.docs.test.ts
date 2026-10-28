/**
 * The TS SDK's per-operation doc comments (bit 20 c2): each operation's summary and description, as Go, Rust, Python
 * and C# write them, in a JSDoc block above its overloads, so an editor shows them. Spec text stays text: a summary
 * that would close the comment, or hide behind a bidi or C1 control, is inert, and the block stays one comment.
 */
import { describe, expect, it } from "vitest"
import { generateSdk } from "./sdk.ts"

/** The `.types.gen.ts` text of an SDK over one GET `/widgets`, its summary and description as given. */
function typesText(summary?: string, description?: string): string {
	const document = {
		info: { title: "T", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/widgets": {
				get: { description, operationId: "widgets.list", responses: { 204: { description: "none" } }, summary },
			},
		},
	}
	const { files } = generateSdk(document, { name: "Shop" })
	return Object.entries(files).find(([path]) => path.endsWith(".types.gen.ts"))?.[1] ?? ""
}

/** The lines from the doc block above `list(` up to its first signature. */
function docAbove(text: string): string[] {
	const lines = text.split("\n")
	const first = lines.findIndex((line) => /^\t+list\(/.test(line))
	if ((lines[first - 1] ?? "").trim() !== "*/") return []
	const start = lines.slice(0, first).findLastIndex((line) => line.trim() === "/**")
	return lines.slice(start, first)
}

describe("the TS SDK's per-operation doc comments", () => {
	it("writes an operation's summary and description above its overloads", () => {
		expect(docAbove(typesText("List the widgets", "Newest first, 50 a page."))).toEqual([
			"\t\t/**",
			"\t\t * List the widgets",
			"\t\t *",
			"\t\t * Newest first, 50 a page.",
			"\t\t */",
		])
	})

	it("writes no doc comment for an operation with neither", () => {
		expect(docAbove(typesText())).toEqual([])
	})

	it("keeps a summary that would close the comment, or hide behind a bidi or C1 control, inside one comment", () => {
		const hostile = "end */ export const x = 1 /* ‮⁦ rtl \u0085 next"
		const doc = docAbove(typesText(hostile))
		const body = doc.slice(1, -1).join("\n")
		const raw = [...body].filter((ch) => /[\u0080-\u009f‪-‮⁦-⁩]/.test(ch))
		expect([doc[0], doc.at(-1), body.includes("*/"), raw, body.includes("export const x = 1")]).toEqual([
			"\t\t/**",
			"\t\t */",
			false,
			[],
			true,
		])
	})
})
