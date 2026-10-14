/**
 * The ICU engine, against v0's own answers: every row is an input a v0 suite gave `interpolate` and
 * the exact string v0 returned for it (captured by running those suites unchanged), so v1 must
 * reproduce v0 byte for byte. Grouped by behavior; the stress inputs are rebuilt, not inlined.
 */
import { afterEach, describe, expect, expectTypeOf, it } from "vitest"
import { createInterpolator, type ExtractICUVars, interpolate } from "./icu.ts"

type Row = readonly [template: string, vars: Record<string, unknown>, locale: string | undefined, expected: string]

const PLURAL: readonly Row[] = [
	// v0: 113e121e61
	["{count, plural, one {# item} other {# items}}", { count: 5 }, undefined, "5 items"],
	// v0: 57a39f6a34
	["{n, plural, other {{label} #}}", { label: "item #", n: 5 }, undefined, "item # 5"],
	// v0: d924f2966d
	["{n, plural, one {one} other {other}}", { n: "abc" }, undefined, "other"],
	// v0: fdab491a50
	["{x} has # items", { x: "Bob" }, undefined, "Bob has # items"],
	// v0: 746e923700
	["{count, plural, one {# item} other {# items}}", { count: 1 }, undefined, "1 item"],
	// v0: 335f516ba8
	["{x, select, a {price: #} other {no}}", { x: "a" }, undefined, "price: #"],
	// v0: a7f7b1de33
	["{count, plural, =0 {no items} one {# item} other {# items}}", { count: 0 }, undefined, "no items"],
	// v0: f3a474ff61
	["{n, plural, one {one} other {other}}", { n: true }, undefined, "one"],
	// v0: 720be680e5
	["{count, plural, =5 {exactly five} other {# things}}", { count: 5 }, undefined, "exactly five"],
	// v0: 0a25e099d3
	["{n, plural, one {one} other {other}}", { n: false }, undefined, "other"],
	// v0: 0eb29d9c5a
	["{n, plural, other {# results found}}", { n: 42 }, undefined, "42 results found"],
	// v0: b0500646ca
	[
		"{count, plural, one {{name} has # item} other {{name} has # items}}",
		{ count: 3, name: "Alice" },
		undefined,
		"Alice has 3 items",
	],
	// v0: 14d900f099
	["{n, plural, one {single} other {multi}}", { n: "1" }, undefined, "single"],
	// v0: 9b9ac95de7
	["{count, plural, other {# items}}", { count: 1 }, undefined, "1 items"],
	// v0: 84fbc58d79
	["{n, plural, =0 {zero} other {nonzero}}", { n: "0" }, undefined, "zero"],
	// v0: 21737f046e
	["{count, plural, one {# item} other {# items}}", { count: 1000000 }, undefined, "1000000 items"],
	// v0: 64ffa68c79
	["{n, plural, one {one} other {# items}}", { n: Number.POSITIVE_INFINITY }, undefined, "Infinity items"],
	// v0: e820ce25f6
	["{n, plural, one {one} other {# items}}", { n: Number.NEGATIVE_INFINITY }, undefined, "-Infinity items"],
	// v0: 90c07a269a
	["{n, plural, =1 {one} =2 {two} =3 {three} other {many}}", { n: 1 }, undefined, "one"],
	["{n, plural, =1 {one} =2 {two} =3 {three} other {many}}", { n: 2 }, undefined, "two"],
	["{n, plural, =1 {one} =2 {two} =3 {three} other {many}}", { n: 3 }, undefined, "three"],
	["{n, plural, =1 {one} =2 {two} =3 {three} other {many}}", { n: 4 }, undefined, "many"],
	// v0: 48824a0a85
	["{n, plural, =0 {zero} other {not zero}}", { n: 0.1 }, undefined, "not zero"],
	// v0: 2942e5654c
	["{n, plural, =0.5 {half} other {not half}}", { n: 0.5 }, undefined, "half"],
	// v0: c26d11c53f
	["{n, plural, =-1 {minus one} other {other}}", { n: -1 }, undefined, "minus one"],
	// v0: 13c4b56c5c
	["{x, select, a {A} b {B}}", { x: "c" }, undefined, ""],
	// v0: b6c5a8c32c
	["{n, plural, =5 {five}}", { n: 3 }, undefined, ""],
	// v0: 544e29e078
	["{n, plural,}", { n: 1 }, undefined, ""],
	// v0: f791fbb789
	["{n, plural, one{# file} few{# soubory} many{# souboru} other{# souborů}}", { n: 1 }, "cs", "1 file"],
	["{n, plural, one{# file} few{# soubory} many{# souboru} other{# souborů}}", { n: 3 }, "cs", "3 soubory"],
	["{n, plural, one{# file} few{# soubory} many{# souboru} other{# souborů}}", { n: 7 }, "cs", "7 souborů"],
	// v0: 34504db5fb
	["{n, plural, =0 {empty}}", { n: 0 }, undefined, "empty"],
	// v0: e36e1d9ba7
	["{n, plural, =0 {empty} one {single} other {many}}", { n: 1 }, undefined, "single"],
	// v0: 6bce016ef6
	["{n, plural, =1 {exact one} one {category one} other {many}}", { n: 1 }, undefined, "exact one"],
	// v0: 700136de17
	["{n, plural, =100 {century} other {# items}}", { n: 100 }, undefined, "century"],
	// v0: a77bb67dcf
	["{n, plural, one {# item} other {# items}}", { n: -3 }, undefined, "-3 items"],
	// v0: 670527020e
	["{n, plural, one {# item} other {# items}}", { n: 1.5 }, undefined, "1.5 items"],
	// v0: 0ee10485f3
	["{n, plural, =0 {zero} one {one} other {other}}", {}, undefined, "zero"],
	// v0: 388f09d4eb
	["{n, plural, =0 {zero} other {num}}", { n: Number.NaN }, undefined, "num"],
	// v0: a6564ac6bc
	["{n, plural, other {# out of # total}}", { n: 5 }, undefined, "5 out of 5 total"],
	// v0: d57768e445
	["# is not replaced here", {}, undefined, "# is not replaced here"],
	// v0: feb144b204
	["{x}", { x: "#" }, undefined, "#"],
	// v0: 67623da2de
	["{n, plural, other {# items}}", { n: 0 }, undefined, "0 items"],
	// v0: a26ffabc23
	["{n, plural, other {# offset}}", { n: -10 }, undefined, "-10 offset"],
	// v0: 2012c95230
	["{n, plural, one{# plik} few{# pliki} many{# plików} other{# pliku}}", { n: 2 }, "pl", "2 pliki"],
	["{n, plural, one{# plik} few{# pliki} many{# plików} other{# pliku}}", { n: 5 }, "pl", "5 plików"],
	["{n, plural, one{# plik} few{# pliki} many{# plików} other{# pliku}}", { n: 1.5 }, "pl", "1,5 pliku"],
	// v0: 0810dc8eb0
	["{n, plural, other{# items}}", { n: 1234567 }, "de", "1.234.567 items"],
	["{n, plural, other{# items}}", { n: 1234567 }, undefined, "1234567 items"],
	// v0: 9902f43a02
	["{n, plural, one{one} other{other}}", { n: 1 }, undefined, "one"],
	["{n, plural, one{one} other{other}}", { n: 0 }, undefined, "other"],
]

const SELECT: readonly Row[] = [
	// v0: 03fc4efeaa
	[
		"{role, select, admin {Administrator} user {Regular User} other {Unknown}}",
		{ role: "admin" },
		undefined,
		"Administrator",
	],
	// v0: c3f73e65ba
	["{role, select, admin {Admin} other {User}}", { role: "viewer" }, undefined, "User"],
	// v0: bbee9f760f
	["{x, select, a/b {matched} other {no}}", { x: "a/b" }, undefined, "matched"],
	// v0: 1715d28c3f
	["{x, select, 42 {answer} other {no}}", { x: 42 }, undefined, "answer"],
	// v0: ec8a30e574
	["{gender, select, male {He} female {She} other {They}}", {}, undefined, "They"],
	// v0: 74880b6e7e
	["{x, select, hello! {Hi!} other {Bye}}", { x: "hello!" }, undefined, "Hi!"],
	// v0: 33ff5add2c
	["{type, select, error {{msg} failed} other {OK}}", { msg: "Upload", type: "error" }, undefined, "Upload failed"],
	// v0: 3dc3a60607
	["{x, select, a {} other {fallback}}", { x: "a" }, undefined, ""],
	// v0: dd23160b56
	["{x, select, other {always}}", { x: "anything" }, undefined, "always"],
	// v0: e2bdc5ff48
	["{x, select, a {A} other {unknown: {x}}}", { x: "b" }, undefined, "unknown: b"],
	// v0: a0f9035f02
	["{x, select, a {A} other {default}}", {}, undefined, "default"],
	// v0: 83d81d752d
	["{x, select, a {A} other {fallback}}", { x: undefined }, undefined, "fallback"],
	// v0: 1842ec6006
	["{x, select, a {A} other {fallback}}", { x: null }, undefined, "fallback"],
	// v0: 2b908609b3
	[
		"{status, select, pending {Waiting} active {Running} done {Finished} error {Failed} other {Unknown}}",
		{ status: "pending" },
		undefined,
		"Waiting",
	],
	[
		"{status, select, pending {Waiting} active {Running} done {Finished} error {Failed} other {Unknown}}",
		{ status: "active" },
		undefined,
		"Running",
	],
	[
		"{status, select, pending {Waiting} active {Running} done {Finished} error {Failed} other {Unknown}}",
		{ status: "done" },
		undefined,
		"Finished",
	],
	[
		"{status, select, pending {Waiting} active {Running} done {Finished} error {Failed} other {Unknown}}",
		{ status: "error" },
		undefined,
		"Failed",
	],
	[
		"{status, select, pending {Waiting} active {Running} done {Finished} error {Failed} other {Unknown}}",
		{ status: "unknown_value" },
		undefined,
		"Unknown",
	],
	// v0: 9c4026a723
	["{x, select, 1 {One} 2 {Two} other {Other}}", { x: "1" }, undefined, "One"],
	// v0: dca45904b0
	["{x, select, 42 {Answer} other {Nope}}", { x: 42 }, undefined, "Answer"],
	// v0: 321eb810f6
	["{x, select, a {A} other {Empty}}", { x: "" }, undefined, "Empty"],
	// v0: e3f4f2b273
	["{x, select, yes {Yes, please!} other {No, thanks.}}", { x: "yes" }, undefined, "Yes, please!"],
	// v0: 474f787656
	["{x, select, a {A} b {B}}", { x: "c" }, undefined, ""],
]

const NUMBER: readonly Row[] = [
	// v0: 9b3c8e546c
	["{n, number}", { n: 1234567 }, "en-US", "1,234,567"],
	// v0: 73c96b3009
	["{amount, number}", { amount: 1234.5 }, "en", "1,234.5"],
	// v0: 50d3a5a0b0
	["{n, number}", { n: 1234567 }, "de-DE", "1.234.567"],
	// v0: f1bb84d67f
	["{n, number}", { n: 0 }, "en", "0"],
	// v0: 983ea6204e
	["{amount, number}", { amount: 42 }, undefined, "42"],
	// v0: 253354dcd7
	["{n, number}", { n: -42 }, "en", "-42"],
	// v0: 40febc29b4
	["{amount, number}", {}, undefined, "{amount}"],
	// v0: b7524600b5
	["{n, number}", { n: 999999999999 }, "en", "999,999,999,999"],
	// v0: f65305abba
	["{n, number}", { n: 3.14 }, "en", "3.14"],
	// v0: ef4659b7ea
	["{n, number}", { n: -0 }, "en", "-0"],
	// v0: 59203d8abc
	["{n, number}", { n: "42.5" }, "en", "42.5"],
	// v0: a533a9fe9a
	["{n, number}", { n: "abc" }, "en", "NaN"],
	// v0: a0eaee5459
	["{n, number}", {}, "en", "{n}"],
	// v0: da18e41b5e
	["{n, number}", { n: null }, "en", "{n}"],
	// v0: 4fc354815b
	["{n, number}", { n: 1234567 }, "en", "1,234,567"],
	// v0: 5ec7ae6192
	["{n, number}", { n: Math.PI }, "en", "3.142"],
	// v0: 52ef69e29f
	["{n, number}", { n: 0 }, "en", "0"],
	// v0: 562c3144cb
	["{n, number}", { n: -42 }, "en", "-42"],
	// v0: 2c261fe2ed
	["{n, number}", { n: "999" }, "en", "999"],
]

const BASICS: readonly Row[] = [
	// v0: 6903ccce32
	// v0: b3aad7f675
	["{field} is required", { field: "Email" }, undefined, "Email is required"],
	// v0: fae748139c
	["{field} must be at least {min} chars", { field: "Name", min: 3 }, undefined, "Name must be at least 3 chars"],
	// v0: 458cdff331
	// v0: 8885841770
	["{field} is required", {}, undefined, "{field} is required"],
	// v0: 7bc72b5800
	// v0: b79ac6f32a
	["Something went wrong", {}, undefined, "Something went wrong"],
	// v0: 05d421daea
	["{x}", { x: "<script>alert(1)</script>" }, undefined, "<script>alert(1)</script>"],
	// v0: 034cbd7e91
	["", {}, undefined, ""],
	// v0: 7e007eb581
	["{x}", { x: "hello" }, undefined, "hello"],
	// v0: a4b41019a7
	["{{x}}", { x: "val" }, undefined, "{{x}}"],
	// v0: 162a1ea923
	// v0: d019100ed7
	["{count} items", { count: 0 }, undefined, "0 items"],
	// v0: 9afb1d8a5f
	["offset: {n}", { n: -5 }, undefined, "offset: -5"],
	// v0: 44a2d5f489
	["{x} and {x}", { x: "val" }, undefined, "val and val"],
	// v0: 7986a8032f
	["{a}{b}{c}", { a: "X", b: "Y", c: "Z" }, undefined, "XYZ"],
	// v0: 3752c99b87
	["{field1} and {field2}", { field1: "A", field2: "B" }, undefined, "A and B"],
	// v0: 11836fe14c
	["{my_var}", { my_var: "ok" }, undefined, "ok"],
	// v0: 4d70d36a68
	["{cause} happened", { cause: "timeout" }, undefined, "timeout happened"],
	// v0: d6e7e93ec0
	["Fehler: {msg} 🔥", { msg: "kaputt" }, undefined, "Fehler: kaputt 🔥"],
	// v0: b245b17d9b
	["{x} is great", { x: "Honey" }, undefined, "Honey is great"],
	// v0: d077d63778
	["Hello {x}", { x: "World" }, undefined, "Hello World"],
	// v0: 0d919d937c
	["{x}", { extra: "nope", x: "yes" }, undefined, "yes"],
	// v0: 328a1a3b61
	["[{x}]", { x: "" }, undefined, "[]"],
	// v0: 387b3c2533
	["{} is empty", {}, undefined, "{} is empty"],
	// v0: 2b88dcd1d6
	["{unclosed is broken", {}, undefined, "{unclosed is broken"],
	// v0: 95f2e6bc82
	["{x}{x}{x}", { x: "a" }, undefined, "aaa"],
]

describe("interpolate(): simple vars, as the first i18n suite pinned them", () => {
	it.each(BASICS)("%j with %j in %s", (template, vars, locale, expected) => {
		expect(interpolate(template, vars, locale)).toBe(expected)
	})
})

describe("ExtractICUVars: a message literal's vars as a type", () => {
	// v0: 32b2e07d5b
	// v0: 0a6b5e035a
	// v0: b8f222025e
	// v0: 5839823181
	// v0: 2526e75f76
	// v0: 5cb845ef1e
	it("each {var} a key of string or number, a repeated one once", () => {
		expectTypeOf<ExtractICUVars<"{field} is required">>().toEqualTypeOf<{ field: number | string }>()
		expectTypeOf<ExtractICUVars<"{field} must be at least {min}">>().toEqualTypeOf<{
			field: number | string
			min: number | string
		}>()
		expectTypeOf<ExtractICUVars<"{a} {b} {c}">>().toEqualTypeOf<{
			a: number | string
			b: number | string
			c: number | string
		}>()
		expectTypeOf<ExtractICUVars<"{a}{b}">>().toEqualTypeOf<{ a: number | string; b: number | string }>()
		expectTypeOf<ExtractICUVars<"{x}">>().toEqualTypeOf<{ x: number | string }>()
		expectTypeOf<ExtractICUVars<"{x} and {x}">>().toEqualTypeOf<{ x: number | string }>()
	})

	// v0: 35d48dd6ae
	// v0: 4b273795b1
	// v0: b3f90f168f
	// v0: 145647891a
	it("no vars is {}, so vars can be left out; cause is HoneyError's own, never a var", () => {
		expectTypeOf<ExtractICUVars<"Something went wrong">>().toEqualTypeOf<{}>()
		expectTypeOf<ExtractICUVars<"{cause} error">>().toEqualTypeOf<{}>()
		expectTypeOf<ExtractICUVars<"{cause} then {field}">>().toEqualTypeOf<{ field: number | string }>()
		expectTypeOf<ExtractICUVars<"{a} {cause} {b}">>().toEqualTypeOf<{ a: number | string; b: number | string }>()
	})
})

describe("interpolate(): plural: CLDR categories, exact matches, # and its locale", () => {
	it.each(PLURAL)("%j with %j in %s", (template, vars, locale, expected) => {
		expect(interpolate(template, vars, locale)).toBe(expected)
	})
})

describe("interpolate(): select: the matching branch, else other", () => {
	it.each(SELECT)("%j with %j in %s", (template, vars, locale, expected) => {
		expect(interpolate(template, vars, locale)).toBe(expected)
	})
})

describe("interpolate(): number: formatted for the locale, plain digits without one", () => {
	it.each(NUMBER)("%j with %j in %s", (template, vars, locale, expected) => {
		expect(interpolate(template, vars, locale)).toBe(expected)
	})
})

/** `{ v0: value(0), v1: value(1), … }` for `n` vars. */
function manyVars(n: number, value: (i: number) => number | string): Record<string, number | string> {
	return Object.fromEntries(Array.from({ length: n }, (_, i) => [`v${i}`, value(i)]))
}

/** `{v0}<separator>{v1}…` for `n` vars. */
function manyVarsTemplate(n: number, separator: string): string {
	return Array.from({ length: n }, (_, i) => `{v${i}}`).join(separator)
}

describe("interpolate(): stress, rebuilt rather than inlined", () => {
	// v0: 7e102b2d27
	it("a 10 000 character branch comes back whole", () => {
		const long = "A".repeat(10_000)
		expect(interpolate(`{x, select, a {${long}} other {B}}`, { x: "a" })).toBe(long)
	})

	// v0: 1be141e4af
	// v0: e2985b3029
	it("100 and 50 simple vars in one message", () => {
		expect([
			interpolate(
				manyVarsTemplate(100, ","),
				manyVars(100, (i) => `val${i}`),
			),
			interpolate(
				manyVarsTemplate(50, "-"),
				manyVars(50, (i) => i),
			),
		]).toEqual([
			Array.from({ length: 100 }, (_, i) => `val${i}`).join(","),
			Array.from({ length: 50 }, (_, i) => i).join("-"),
		])
	})

	// v0: 0879fc9679
	it("20 plural blocks in one message", () => {
		const vars = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`n${i}`, i]))
		const template = Array.from({ length: 20 }, (_, i) => `{n${i}, plural, one {#} other {#s}}`).join(" ")
		expect(interpolate(template, vars)).toBe(Array.from({ length: 20 }, (_, i) => (i === 1 ? "1" : `${i}s`)).join(" "))
	})

	// v0: 5ec07084f0
	it("a hundred calls with their own vars never share state", () => {
		const template = "{n, plural, one {# item for {name}} other {# items for {name}}}"
		const results = Array.from({ length: 100 }, (_, i) => interpolate(template, { n: i, name: `user${i}` }))
		expect(results).toEqual(
			Array.from({ length: 100 }, (_, i) => (i === 1 ? "1 item for user1" : `${i} items for user${i}`)),
		)
	})
})

type Counted = "NumberFormat" | "PluralRules"

/** Count `new Intl[name]`: a counting subclass stands in for the constructor until `restore`. */
function counting(name: Counted): { readonly count: number; restore(): void } {
	const Real = Intl[name] as unknown as new (...args: unknown[]) => object
	const counter = {
		count: 0,
		restore: () => Object.defineProperty(Intl, name, { configurable: true, value: Real, writable: true }),
	}
	class Counting extends Real {
		constructor(...args: unknown[]) {
			super(...args)
			counter.count++
		}
	}
	Object.defineProperty(Intl, name, { configurable: true, value: Counting, writable: true })
	return counter
}

describe("interpolate(): plural rules and number formats are built once per formatter", () => {
	const counters: { restore(): void }[] = []
	const count = (name: Counted) => {
		const counter = counting(name)
		counters.push(counter)
		return counter
	}

	afterEach(() => {
		for (const counter of counters.splice(0)) counter.restore()
	})

	const MESSAGE = "{n, plural, one {# item} other {# items}} for {total, number}"

	it("an interpolator builds each locale's rules and format once, however many calls", () => {
		const [plurals, numbers] = [count("PluralRules"), count("NumberFormat")]
		const { interpolate: format } = createInterpolator()
		const out = [1, 2, 3].map((n) => format(MESSAGE, { n, total: n * 1000 }, "en"))
		expect([out, plurals.count, numbers.count]).toEqual([
			["1 item for 1,000", "2 items for 2,000", "3 items for 3,000"],
			1,
			1,
		])
	})

	it("the free interpolate builds them per call, once per locale within it, and keeps nothing after", () => {
		const plurals = count("PluralRules")
		interpolate("{a, plural, one {#} other {#}} {b, plural, one {#} other {#}}", { a: 1, b: 2 }, "en")
		interpolate("{a, plural, one {#} other {#}}", { a: 1 }, "en")
		expect(plurals.count).toBe(2)
	})

	it("a locale Intl does not know: English plural rules, plain digits, never a throw", () => {
		expect(interpolate("{n, plural, one {# one} other {# many}} {n, number}", { n: 1 }, "x-not a locale!")).toBe(
			"1 one 1",
		)
	})

	it("past 256 locales it remembers no more, so request data cannot grow it", () => {
		const plurals = count("PluralRules")
		const { interpolate: format } = createInterpolator()
		const locales = Array.from({ length: 300 }, (_, i) => `en-x-${i.toString(36).padStart(3, "0")}`)
		for (const locale of locales) format("{n, plural, other {#}}", { n: 1 }, locale)
		const built = plurals.count
		format("{n, plural, other {#}}", { n: 1 }, locales[0])
		format("{n, plural, other {#}}", { n: 1 }, locales[299])
		expect([built, plurals.count]).toEqual([300, 301])
	})
})
