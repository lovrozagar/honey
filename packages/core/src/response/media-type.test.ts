import { describe, expect, it } from "vitest"
import { bodyParserFor, isJsonMediaType, isTextMediaType, parseMediaType } from "./media-type.ts"

describe("parseMediaType", () => {
	// v0: 2fa8402d36
	it("lowercases type, subtype and parameter names, and keeps parameter values", () => {
		const mt = parseMediaType('Application/JSON; Charset="UTF-8"; Profile=Foo')
		expect([mt?.essence, mt?.type, mt?.subtype, { ...mt?.params }]).toEqual([
			"application/json",
			"application",
			"json",
			{ charset: "UTF-8", profile: "Foo" },
		])
	})

	// v0: 02388403f9
	it("reads a quoted-string value with escapes and semicolons inside it", () => {
		expect({ ...parseMediaType('multipart/form-data; boundary="a;b\\"c"; x=1')?.params }).toEqual({
			boundary: 'a;b"c',
			x: "1",
		})
	})

	// v0: 2040ef9a13
	it("keeps the first of a repeated parameter and skips malformed pairs", () => {
		expect({ ...parseMediaType("text/plain; charset=a; charset=b; junk; =x")?.params }).toEqual({ charset: "a" })
	})

	// v0: ddd059eeb2
	it("reads the structured-syntax suffix, never from a subtype that is only a suffix", () => {
		expect([
			parseMediaType("application/vnd.api+json")?.suffix,
			parseMediaType("application/problem+json; charset=utf-8")?.suffix,
			parseMediaType("application/json")?.suffix,
			parseMediaType("application/+json")?.suffix,
			parseMediaType("application/json+")?.suffix,
		]).toEqual(["json", "json", null, null, null])
	})

	// v0: 525d871a75
	it.each([null, undefined, "", "json", "application/", "/json", "application/json, text/plain", "a b/c", "é/x"])(
		"%j is no media type",
		(value) => {
			expect(parseMediaType(value)).toBeNull()
		},
	)

	it("holds its parameters in a record with no prototype, a prototype-named one a plain key", () => {
		const params = parseMediaType("text/plain; __proto__=x; constructor=y")?.params
		expect([Object.getPrototypeOf(params), params?.__proto__, params?.constructor]).toEqual([null, "x", "y"])
	})
})

describe("isJsonMediaType and isTextMediaType", () => {
	// v0: 7c9bcf0ff4
	it("JSON is application/json or a +json type, never one that only starts like it", () => {
		const json = ["application/json", "APPLICATION/JSON", "application/vnd.api+json", "application/problem+json"]
		const not = ["application/jsonx", "application/json-seq", "application/json5", "text/json"]
		expect(json.map((v) => isJsonMediaType(parseMediaType(v)))).toEqual([true, true, true, true])
		expect(not.map((v) => isJsonMediaType(parseMediaType(v)))).toEqual([false, false, false, false])
		expect(isJsonMediaType(null)).toBe(false)
	})

	// v0: a41fe5d3ae
	it("text is text/*, application/xml and a +xml type", () => {
		const values = ["TEXT/Plain", "application/xml", "image/svg+xml", "application/octet-stream"]
		expect(values.map((v) => isTextMediaType(parseMediaType(v)))).toEqual([true, true, true, false])
		expect(isTextMediaType(null)).toBe(false)
	})
})

describe("bodyParserFor", () => {
	// v0: 7748564d59
	// v0: 839a0d4b5d
	// v0: 6da60fe45e
	// v0: 0d41ba4a94
	// v0: 342b801330
	// v0: 2bf41878d7
	// v0: 5678fb100a
	// v0: d5576ffdcd
	// v0: 743f4ab13c
	// v0: c16ddbd30d
	// v0: 1e94f0a7a2
	// v0: 53d4a45f90
	it("selects the parser by essence, whatever the case or the parameters", () => {
		expect(
			[
				"application/json",
				"application/json; charset=utf-8",
				"application/ld+json",
				"Multipart/Form-Data; boundary=x",
				"application/x-www-form-urlencoded;charset=UTF-8",
				"multipart/mixed; boundary=x",
				"text/plain",
				"application/xml",
				null,
				undefined,
			].map(bodyParserFor),
		).toEqual(["json", "json", "json", "multipart", "urlencoded", null, null, null, null, null])
	})
})
