/**
 * The Java `<Op>Headers` holder's emitted text (bit 16 phase c2, A1/A2): each declared header's accessor and type, its
 * parser by scalar, a name Object or the holder already has, and the operation with no header declares no holder. The
 * executed legs (binary.test.ts) pin the integer and text headers; these pin the number, boolean and reserved names.
 */
import { describe, expect, it } from "vitest"
import { generateJavaSdk } from "./sdk.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"

/** The `items.get` document with `headers` declared on its 200 (the fixture's own headers replaced). */
function withHeaders(headers: Record<string, unknown>) {
	const doc = structuredClone(FIXTURES.http.document()) as {
		paths: Record<string, { get: { responses: Record<string, { headers?: unknown }> } }>
	}
	const ok = doc.paths["/items/{id}"]?.get.responses["200"]
	if (ok === undefined) throw new Error("the fixture's items.get has no 200")
	ok.headers = headers
	return doc
}

/** The emitted `ItemsGetHeaders` holder's text for `headers`. */
function holderOf(headers: Record<string, unknown>): string {
	const files = generateJavaSdk(withHeaders(headers), {}).files
	const path = Object.keys(files).find((name) => name.endsWith("/ItemsGetHeaders.java"))
	if (path === undefined) throw new Error("no ItemsGetHeaders.java was emitted")
	return files[path] as string
}

describe("the <Op>Headers holder: each header's type and parser", () => {
	it("types an integer, a number, a boolean and a text header, and reads each by its scalar", () => {
		const text = holderOf({
			"X-Count": { required: true, schema: { type: "integer" } },
			"X-Label": { schema: { type: "string" } },
			"X-Live": { required: true, schema: { type: "boolean" } },
			"X-Ratio": { schema: { type: "number" } },
		})
		expect(text).toContain('xCount = Answer.header(headers, "X-Count", true, "integer", Long::parseLong);')
		expect(text).toContain("  private String xLabel;")
		expect(text).toContain("  private Boolean xLive;")
		expect(text).toContain("  private Double xRatio;")
		expect(text).toContain('xLive = Answer.header(headers, "X-Live", true, "boolean", Answer::flag);')
		expect(text).toContain('xRatio = Answer.header(headers, "X-Ratio", false, "number", Double::parseDouble);')
		expect(text).toContain('xLabel = Answer.header(headers, "X-Label", false, "text", value -> value);')
	})

	it("never names an accessor after Object's or the holder's own members", () => {
		const text = holderOf({ Clone: { schema: { type: "string" } }, Read: { schema: { type: "string" } } })
		expect(text).not.toMatch(/public String clone\(\)/)
		expect(text).not.toMatch(/public String read\(\)/)
		expect(text).toMatch(/public String clone2\(\)/)
		expect(text).toMatch(/public String read2\(\)/)
	})
})
