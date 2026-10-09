import { describe, expect, it } from "vitest"
import { bodyParserFor, isJsonMediaType, isTextMediaType, parseMediaType } from "../../../src/media-type.ts"

describe("parseMediaType", () => {
	it("lowercases type, subtype and parameter names, keeps parameter values", () => {
		const mt = parseMediaType('Application/JSON; Charset="UTF-8"; Profile=Foo')
		expect(mt?.essence).toBe("application/json")
		expect(mt?.params).toEqual({ charset: "UTF-8", profile: "Foo" })
	})

	it("reads the structured-syntax suffix", () => {
		expect(parseMediaType("application/vnd.api+json")?.suffix).toBe("json")
		expect(parseMediaType("application/problem+json; charset=utf-8")?.suffix).toBe("json")
		expect(parseMediaType("application/json")?.suffix).toBeNull()
		expect(parseMediaType("application/+json")?.suffix).toBeNull()
	})

	it("returns null for absent or malformed values", () => {
		for (const v of [null, undefined, "", "json", "application/", "/json", "application/json, text/plain", "a b/c"]) {
			expect(parseMediaType(v)).toBeNull()
		}
	})

	it("parses quoted-string parameters with escapes and semicolons", () => {
		const mt = parseMediaType('multipart/form-data; boundary="a;b\\"c"; x=1')
		expect(mt?.params).toEqual({ boundary: 'a;b"c', x: "1" })
	})

	it("keeps the first of a repeated parameter and skips malformed pairs", () => {
		expect(parseMediaType("text/plain; charset=a; charset=b; junk; =x")?.params).toEqual({ charset: "a" })
	})
})

describe("isJsonMediaType / isTextMediaType", () => {
	it("JSON is application/json or any +json type, nothing that only starts with it", () => {
		expect(isJsonMediaType(parseMediaType("application/json"))).toBe(true)
		expect(isJsonMediaType(parseMediaType("APPLICATION/JSON"))).toBe(true)
		expect(isJsonMediaType(parseMediaType("application/vnd.api+json"))).toBe(true)
		expect(isJsonMediaType(parseMediaType("application/jsonx"))).toBe(false)
		expect(isJsonMediaType(parseMediaType("application/json-seq"))).toBe(false)
		expect(isJsonMediaType(parseMediaType("text/json"))).toBe(false)
		expect(isJsonMediaType(null)).toBe(false)
	})

	it("text is text/*, application/xml and +xml", () => {
		expect(isTextMediaType(parseMediaType("TEXT/Plain"))).toBe(true)
		expect(isTextMediaType(parseMediaType("application/xml"))).toBe(true)
		expect(isTextMediaType(parseMediaType("image/svg+xml"))).toBe(true)
		expect(isTextMediaType(parseMediaType("application/octet-stream"))).toBe(false)
	})
})

describe("bodyParserFor", () => {
	it("selects by essence", () => {
		expect(bodyParserFor("application/json; charset=utf-8")).toBe("json")
		expect(bodyParserFor("application/ld+json")).toBe("json")
		expect(bodyParserFor("Multipart/Form-Data; boundary=x")).toBe("multipart")
		expect(bodyParserFor("application/x-www-form-urlencoded;charset=UTF-8")).toBe("urlencoded")
		expect(bodyParserFor("multipart/mixed; boundary=x")).toBeNull()
		expect(bodyParserFor("text/plain")).toBeNull()
		expect(bodyParserFor(null)).toBeNull()
	})
})
