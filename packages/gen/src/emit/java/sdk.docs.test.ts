/**
 * The Java SDK's per-operation doc comments (bit 20 c2): each method's javadoc holds the operation's id, then its
 * summary and description as `<p>` paragraphs, as Go, Rust, Python and C# carry them, so an IDE shows them. Spec text
 * stays text: a summary that would close the comment, or hide behind a bidi or C1 control, is inert, and the javadoc
 * stays one comment (adversarial.test compiles and loads such an SDK).
 */
import { describe, expect, it } from "vitest"
import { generateJavaSdk } from "./sdk.ts"

/** The client's text for an SDK over one GET `/widgets`, its summary and description as given. */
function clientText(summary?: string, description?: string): string {
	const document = {
		info: { title: "T", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/widgets": {
				get: { description, operationId: "listWidgets", responses: { 204: { description: "none" } }, summary },
			},
		},
	}
	const { files } = generateJavaSdk(document, { clientName: "ShopClient", packageName: "com.example.shop" })
	return Object.entries(files).find(([path]) => path.endsWith("/ShopClient.java"))?.[1] ?? ""
}

/** The javadoc above the first `listWidgets(` method. */
function docAbove(text: string): string[] {
	const lines = text.split("\n")
	const first = lines.findIndex((line) => line.includes(" listWidgets(ListWidgetsParams params"))
	const start = lines.slice(0, first).findLastIndex((line) => line.trim().startsWith("/**"))
	return lines.slice(start, first)
}

describe("the Java SDK's per-operation doc comments", () => {
	it("writes an operation's summary and description after its id, as javadoc paragraphs", () => {
		expect(docAbove(clientText("List the widgets", "Newest first, 50 a page."))).toEqual([
			"  /**",
			"   * listWidgets",
			"   *",
			"   * <p>List the widgets",
			"   *",
			"   * <p>Newest first, 50 a page.",
			"   */",
		])
	})

	it("keeps the id alone for an operation with neither", () => {
		expect(docAbove(clientText())).toEqual(["  /** listWidgets */"])
	})

	it("keeps a summary that would close the comment, or hide behind a bidi or C1 control, inside one comment", () => {
		const hostile = "end */ static { halt(); } /* ‮⁦ rtl \u0085 next"
		const doc = docAbove(clientText(hostile))
		const body = doc.slice(1, -1).join("\n")
		const raw = [...body].filter((ch) => /[\u0080-\u009f‪-‮⁦-⁩]/.test(ch))
		expect([doc[0], doc.at(-1), body.includes("*/"), raw, body.includes("static { halt(); }")]).toEqual([
			"  /**",
			"   */",
			false,
			[],
			true,
		])
	})
})
