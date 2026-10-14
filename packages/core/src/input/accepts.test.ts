import { describe, expect, expectTypeOf, it } from "vitest"
import { accepts } from "./accepts.ts"

const JSON_TYPE = "application/json"
const HTML = "text/html"
const CSV = "text/csv"

/** A request carrying `accept`, or no Accept header at all. */
function req(accept?: string): Request {
	return new Request("http://localhost/", accept === undefined ? {} : { headers: { accept } })
}

describe("accepts: nothing to negotiate", () => {
	// v0: 7b43605077
	// v0: b202114070
	// v0: d17c6bd012
	// v0: 44448d2036
	// v0: 175f8c1900
	// v0: b72bea37b8
	// v0: 8212058dc5
	it.each<[string | undefined, string[], string | null]>([
		[undefined, [JSON_TYPE, HTML], JSON_TYPE],
		["", [JSON_TYPE], JSON_TYPE],
		["   ", [JSON_TYPE], JSON_TYPE],
		[";;;garbage;;;", [JSON_TYPE], JSON_TYPE],
		["*/html, text", [JSON_TYPE, HTML], JSON_TYPE],
		[undefined, [], null],
		["*/*", [], null],
	])("Accept %j over %j answers the first supported type, null when there is none", (accept, supported, expected) => {
		expect(accepts(req(accept), supported)).toBe(expected)
	})
})

describe("accepts: ranges and the server's order", () => {
	// v0: 37251f6ca7
	// v0: 8fd894bda8
	// v0: 674d7b8a61
	// v0: 128b1aa103
	// v0: fa4fad38be
	// v0: 2194071680
	// v0: ae9a452f9f
	// v0: c54b9c6184
	// v0: b47925d898
	// v0: a4bb72f6f5
	// v0: 1029741b09
	// v0: 8db09e49ae
	// v0: fa5ecafe1e
	it.each<[string, string[], string]>([
		[JSON_TYPE, [JSON_TYPE, HTML], JSON_TYPE],
		[HTML, [JSON_TYPE, HTML], HTML],
		[CSV, [JSON_TYPE, CSV], CSV],
		["*/*", [HTML, JSON_TYPE], HTML],
		["*/*", [JSON_TYPE, CSV], JSON_TYPE],
		["text/*", [CSV, JSON_TYPE], CSV],
		["text/*", [JSON_TYPE, HTML], HTML],
		["text/html, application/json", [JSON_TYPE, HTML], JSON_TYPE],
		["text/csv, application/json", [JSON_TYPE, CSV], JSON_TYPE],
		["  text/html  ,  application/json  ", [JSON_TYPE], JSON_TYPE],
	])("Accept %j over %j answers %j: an equal weight goes to the server's first", (accept, supported, expected) => {
		expect(accepts(req(accept), supported)).toBe(expected)
	})

	// v0: 0b7c144cf0
	// v0: 6b41f26f4f
	// v0: 6cb561b68c
	it.each([HTML, "application/xml", "image/png"])("Accept %j that no supported type matches answers null", (accept) => {
		expect(accepts(req(accept), [JSON_TYPE, ...(accept === HTML ? [] : [HTML])])).toBeNull()
	})
})

describe("accepts: weights", () => {
	// v0: b836a0491f
	// v0: 33e6dc46cf
	// v0: 53ee1d0ed4
	// v0: 241c446a60
	// v0: 49fb3c0972
	// v0: f795555f3b
	// v0: 1c8557f8da
	it.each<[string, string[], string]>([
		["text/csv;q=1.0, application/json;q=0.9", [JSON_TYPE, CSV], CSV],
		["text/html;q=0.1, application/json;q=0.5, text/csv;q=0.9", [HTML, JSON_TYPE, CSV], CSV],
		["text/html;q=0.5, application/json;q=0.9", [HTML, JSON_TYPE], JSON_TYPE],
		["text/html;q=0.1, application/json;q=0.8, text/plain;q=0.5", [HTML, "text/plain", JSON_TYPE], JSON_TYPE],
		["text/html;q=1.0, application/json;q=0.5", [JSON_TYPE, HTML], HTML],
		["TEXT/CSV;q=1.0, application/json;q=0.5", [JSON_TYPE, CSV], CSV],
		["text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8", [JSON_TYPE, HTML], HTML],
	])("Accept %j over %j answers %j: the higher weight wins over the server's order", (accept, supported, expected) => {
		expect(accepts(req(accept), supported)).toBe(expected)
	})

	// v0: 16d3ede2b8
	it("a type takes the weight of its most specific range, not the highest one that matches", () => {
		expect(accepts(req("*/*, application/json;q=0.9"), [JSON_TYPE, HTML])).toBe(HTML)
	})
})

describe("accepts: q=0 and the most specific range", () => {
	// v0: 886ec3742d
	// v0: 85e30ec822
	// v0: 6bc4961c4b
	// v0: 77a94438c3
	// v0: f89b233cae
	it("q=0 excludes a type, even beside */*, and the most specific matching range sets the weight", () => {
		expect([
			accepts(req("text/html;q=0, application/json"), [HTML, JSON_TYPE]),
			accepts(req("text/html;q=0, */*"), [HTML]),
			accepts(req("text/html;q=0, */*"), [HTML, JSON_TYPE]),
			accepts(req("text/*;q=0.1, text/plain;q=0.9, */*;q=0.5"), [CSV, "text/plain"]),
			accepts(req("text/*;q=0.1, */*;q=0.5"), [CSV, JSON_TYPE]),
		]).toEqual([JSON_TYPE, null, JSON_TYPE, "text/plain", JSON_TYPE])
	})

	// v0: 1ddefb0c21
	// v0: 23fbe77289
	it("a range with parameters applies only to a supported type carrying every one of them", () => {
		expect([
			accepts(req("application/json;v=2;q=0, application/json"), [JSON_TYPE]),
			accepts(req("text/html;level=1;q=0.1, text/html, application/json;q=0.5"), [JSON_TYPE, HTML]),
			accepts(req("application/json;v=2;q=0, application/json"), ["application/json;v=2"]),
			accepts(req("text/html;level=1, */*;q=0.1"), [JSON_TYPE, "text/html;level=1"]),
			accepts(req('text/html;level="1", */*;q=0.1'), [JSON_TYPE, 'text/html; Level="1"']),
		]).toEqual([JSON_TYPE, HTML, null, "text/html;level=1", 'text/html; Level="1"'])
	})
})

describe("accepts: reading the header", () => {
	// v0: c6d68f66cf
	// v0: f085eaa009
	// v0: 19b3b62908
	// v0: adcef025de
	it("matches type and subtype whatever their case, and answers the supported type as the server spelled it", () => {
		expect([
			accepts(req("Application/JSON"), [JSON_TYPE]),
			accepts(req("text/HTML"), [HTML]),
			accepts(req("text/html"), ["Text/HTML"]),
		]).toEqual([JSON_TYPE, HTML, "Text/HTML"])
	})

	// v0: 05e84e4e3a
	// v0: 185fed5dbb
	it("reads Q in any case and with spaces around =; a q out of range or malformed excludes the range", () => {
		expect([
			accepts(req("application/json;Q=0.1, text/html"), [JSON_TYPE, HTML]),
			accepts(req("application/json; q = 0.1, text/html"), [JSON_TYPE, HTML]),
			accepts(req("application/json;q=5, text/html;q=0.5"), [JSON_TYPE, HTML]),
			accepts(req("application/json;q=-1"), [JSON_TYPE]),
			accepts(req("application/json;q=abc"), [JSON_TYPE]),
			accepts(req("application/json;q=.5, text/html;q=0.4"), [HTML, JSON_TYPE]),
		]).toEqual([HTML, HTML, HTML, null, null, JSON_TYPE])
	})

	it("parameters after q are accept extensions, never matched against the supported type", () => {
		expect(accepts(req("text/html;q=0.5;level=1, application/json;q=0.4"), [JSON_TYPE, HTML])).toBe(HTML)
	})

	it("skips a parameter with no value; a supported entry that is no media type never matches", () => {
		expect([
			accepts(req("text/html;flag;q=0.2, application/json;q=0.1"), [JSON_TYPE, HTML]),
			accepts(req("*/*"), ["json", JSON_TYPE]),
		]).toEqual([HTML, JSON_TYPE])
	})

	it("answers one of the supported literals", () => {
		expectTypeOf(accepts(req(), [JSON_TYPE, CSV] as const)).toEqualTypeOf<"application/json" | "text/csv" | null>()
	})
})
