import { describe, expect, it } from "vitest"
import { accepts } from "../../../src/accepts.ts"

function req(accept?: string): Request {
	const headers: Record<string, string> = {}
	if (accept) headers.accept = accept
	return new Request("http://localhost/test", { headers })
}

describe("accepts — internal", () => {
	it("exact match", () => {
		expect(accepts(req("application/json"), ["application/json"])).toBe("application/json")
	})

	it("highest q wins", () => {
		expect(
			accepts(req("text/csv;q=1.0, application/json;q=0.9"), ["application/json", "text/csv"]),
		).toBe("text/csv")
	})

	it("no match → null", () => {
		expect(accepts(req("text/html"), ["application/json"])).toBeNull()
	})

	it("wildcard */* matches first supported", () => {
		expect(accepts(req("*/*"), ["application/json", "text/csv"])).toBe("application/json")
	})

	it("no Accept header → first supported", () => {
		expect(accepts(req(), ["application/json"])).toBe("application/json")
	})

	it("type wildcard text/* matches text/csv", () => {
		expect(accepts(req("text/*"), ["text/csv", "application/json"])).toBe("text/csv")
	})

	it("q=0 excluded from matching", () => {
		expect(accepts(req("text/html;q=0, application/json"), ["text/html", "application/json"])).toBe(
			"application/json",
		)
	})

	it("same q → server preference (first in supported array)", () => {
		expect(accepts(req("text/csv, application/json"), ["application/json", "text/csv"])).toBe(
			"application/json",
		)
	})

	it("malformed Accept header → first supported", () => {
		expect(accepts(req(";;;garbage;;;"), ["application/json"])).toBe("application/json")
	})

	it("multiple types with varying q", () => {
		expect(
			accepts(req("text/html;q=0.1, application/json;q=0.5, text/csv;q=0.9"), [
				"text/html",
				"application/json",
				"text/csv",
			]),
		).toBe("text/csv")
	})

	it("case-insensitive media type matching", () => {
		expect(accepts(req("Application/JSON"), ["application/json"])).toBe("application/json")
	})

	it("case-insensitive subtype", () => {
		expect(accepts(req("text/HTML"), ["text/html"])).toBe("text/html")
	})

	it("mixed case in Accept matches lowercase supported", () => {
		expect(
			accepts(req("TEXT/CSV;q=1.0, application/json;q=0.5"), ["application/json", "text/csv"]),
		).toBe("text/csv")
	})
})

describe("accepts — consumer", () => {
	it("API returns JSON for json Accept, CSV for csv Accept", () => {
		const supported = ["application/json", "text/csv"]

		const jsonReq = req("application/json")
		expect(accepts(jsonReq, supported)).toBe("application/json")

		const csvReq = req("text/csv")
		expect(accepts(csvReq, supported)).toBe("text/csv")
	})

	it("browser Accept header → best match", () => {
		/* typical browser sends: text/html, xhtml, xml;q=0.9, wildcard;q=0.8 */
		const browserAccept = "text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8"
		const result = accepts(req(browserAccept), ["application/json", "text/html"])
		expect(result).toBe("text/html")
	})
})
