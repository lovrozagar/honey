import { describe, expect, it } from "vitest"
import { interpolate } from "../../../src/i18n.ts"

/* ═══════════════════════════════════════════
 * VAR NAME EDGE CASES
 * ═══════════════════════════════════════════ */

describe("interpolate: var name edge cases", () => {
	it("var name with spaces", () => {
		expect(interpolate("{my var}", { "my var": "works" })).toBe("works")
	})

	it("var name with dot", () => {
		expect(interpolate("{a.b}", { "a.b": "dotted" })).toBe("dotted")
	})

	it("var name with hyphen", () => {
		expect(interpolate("{my-var}", { "my-var": "hyphen" })).toBe("hyphen")
	})

	it("var name is a single digit", () => {
		expect(interpolate("{0}", { "0": "zero" })).toBe("zero")
	})

	it("var name is empty → treated as empty-name var", () => {
		expect(interpolate("{}", {})).toBe("{}")
	})

	it("var value is null → placeholder preserved", () => {
		expect(interpolate("{x}", { x: null as unknown as string })).toBe("{x}")
	})

	it("var value is undefined → placeholder preserved", () => {
		expect(interpolate("{x}", { x: undefined as unknown as string })).toBe("{x}")
	})

	it("var value is false → 'false'", () => {
		expect(interpolate("{x}", { x: false as unknown as string })).toBe("false")
	})

	it("var value is 0 → '0'", () => {
		expect(interpolate("{x}", { x: 0 })).toBe("0")
	})

	it("var value is empty string → empty string (not placeholder)", () => {
		expect(interpolate("{x}", { x: "" })).toBe("")
	})
})

/* ═══════════════════════════════════════════
 * PLURAL: type coercion edge cases
 * ═══════════════════════════════════════════ */

describe("interpolate: plural type coercion", () => {
	it("string var in plural → coerced to NaN → falls to other", () => {
		expect(interpolate("{n, plural, one {one} other {other}}", { n: "abc" })).toBe("other")
	})

	it("boolean true in plural → coerced to 1 → matches one", () => {
		expect(
			interpolate("{n, plural, one {one} other {other}}", { n: true as unknown as number }),
		).toBe("one")
	})

	it("boolean false in plural → coerced to 0 → matches other", () => {
		expect(
			interpolate("{n, plural, one {one} other {other}}", { n: false as unknown as number }),
		).toBe("other")
	})

	it("string '1' in plural → coerced to 1 → matches one", () => {
		expect(interpolate("{n, plural, one {single} other {multi}}", { n: "1" })).toBe("single")
	})

	it("string '0' in plural → coerced to 0 → matches =0 or other", () => {
		expect(interpolate("{n, plural, =0 {zero} other {nonzero}}", { n: "0" })).toBe("zero")
	})

	it("Infinity in plural → other category", () => {
		expect(interpolate("{n, plural, one {one} other {# items}}", { n: Infinity })).toBe(
			"Infinity items",
		)
	})

	it("-Infinity in plural → other category", () => {
		expect(interpolate("{n, plural, one {one} other {# items}}", { n: -Infinity })).toBe(
			"-Infinity items",
		)
	})
})

/* ═══════════════════════════════════════════
 * PLURAL: multiple exact matches
 * ═══════════════════════════════════════════ */

describe("interpolate: plural exact matches", () => {
	it("=1 =2 =3 exact match series", () => {
		const tpl = "{n, plural, =1 {one} =2 {two} =3 {three} other {many}}"
		expect(interpolate(tpl, { n: 1 })).toBe("one")
		expect(interpolate(tpl, { n: 2 })).toBe("two")
		expect(interpolate(tpl, { n: 3 })).toBe("three")
		expect(interpolate(tpl, { n: 4 })).toBe("many")
	})

	it("=0 with fractional → doesn't match =0", () => {
		expect(interpolate("{n, plural, =0 {zero} other {not zero}}", { n: 0.1 })).toBe("not zero")
	})

	it("=0.5 exact match on half", () => {
		expect(interpolate("{n, plural, =0.5 {half} other {not half}}", { n: 0.5 })).toBe("half")
	})

	it("negative exact match =-1", () => {
		expect(interpolate("{n, plural, =-1 {minus one} other {other}}", { n: -1 })).toBe("minus one")
	})
})

/* ═══════════════════════════════════════════
 * SELECT: value edge cases
 * ═══════════════════════════════════════════ */

describe("interpolate: select value edge cases", () => {
	it("value with slash", () => {
		expect(interpolate("{x, select, a/b {matched} other {no}}", { x: "a/b" })).toBe("matched")
	})

	it("numeric value matched as string", () => {
		expect(interpolate("{x, select, 42 {answer} other {no}}", { x: 42 })).toBe("answer")
	})

	it("value with special chars", () => {
		expect(interpolate("{x, select, hello! {Hi!} other {Bye}}", { x: "hello!" })).toBe("Hi!")
	})

	it("empty branch content → empty string", () => {
		expect(interpolate("{x, select, a {} other {fallback}}", { x: "a" })).toBe("")
	})

	it("only other branch, any value", () => {
		expect(interpolate("{x, select, other {always}}", { x: "anything" })).toBe("always")
	})

	it("select referencing same var in branch", () => {
		expect(interpolate("{x, select, a {A} other {unknown: {x}}}", { x: "b" })).toBe("unknown: b")
	})
})

/* ═══════════════════════════════════════════
 * NUMBER: locale-specific formatting
 * ═══════════════════════════════════════════ */

describe("interpolate: number locale formatting", () => {
	it("en-US formats with comma grouping", () => {
		const result = interpolate("{n, number}", { n: 1234567 }, "en-US")
		expect(result).toBe("1,234,567")
	})

	it("de-DE formats with dot grouping", () => {
		const result = interpolate("{n, number}", { n: 1234567 }, "de-DE")
		expect(result).toContain(".")
		expect(result).toContain("1")
		expect(result).toContain("234")
	})

	it("number zero", () => {
		expect(interpolate("{n, number}", { n: 0 }, "en")).toBe("0")
	})

	it("negative number", () => {
		const result = interpolate("{n, number}", { n: -42 }, "en")
		expect(result).toContain("42")
		expect(result).toContain("-")
	})

	it("very large number", () => {
		const result = interpolate("{n, number}", { n: 999999999999 }, "en")
		expect(result).toContain(",")
	})

	it("decimal number", () => {
		const result = interpolate("{n, number}", { n: 3.14 }, "en")
		expect(result).toContain("3")
		expect(result).toContain("14")
	})
})

/* ═══════════════════════════════════════════
 * NESTING: 4 levels deep
 * ═══════════════════════════════════════════ */

describe("interpolate: 4 levels of nesting", () => {
	it("select 4 levels deep", () => {
		expect(
			interpolate(
				"{a, select, x {{b, select, y {{c, select, z {{d}} other {?}}} other {?}}} other {?}}",
				{ a: "x", b: "y", c: "z", d: "DEEP" },
			),
		).toBe("DEEP")
	})

	it("4 levels with wrong inner value → falls to other", () => {
		expect(
			interpolate(
				"{a, select, x {{b, select, y {{c, select, z {{d}} other {fallback}}} other {?}}} other {?}}",
				{ a: "x", b: "y", c: "wrong", d: "DEEP" },
			),
		).toBe("fallback")
	})
})

/* ═══════════════════════════════════════════
 * WHITESPACE: in ICU syntax
 * ═══════════════════════════════════════════ */

describe("interpolate: whitespace handling", () => {
	it("no spaces around commas in plural", () => {
		expect(interpolate("{n,plural,one{#}other{#s}}", { n: 1 })).toBe("1")
	})

	it("extra spaces around commas", () => {
		expect(interpolate("{  n  ,  plural  ,  one  {single}  other  {multi}  }", { n: 1 })).toBe(
			"single",
		)
	})

	it("newlines in branch content", () => {
		expect(interpolate("{x, select, a {line1\nline2} other {no}}", { x: "a" })).toBe("line1\nline2")
	})

	it("tabs in branch content", () => {
		expect(interpolate("{x, select, a {\tindented} other {no}}", { x: "a" })).toBe("\tindented")
	})

	it("leading/trailing spaces in var name trimmed", () => {
		expect(interpolate("{  name  }", { name: "trimmed" })).toBe("trimmed")
	})
})

/* ═══════════════════════════════════════════
 * TEMPLATE STRUCTURE EDGE CASES
 * ═══════════════════════════════════════════ */

describe("interpolate: template structure", () => {
	it("template is just a number", () => {
		expect(interpolate("42", {})).toBe("42")
	})

	it("template with no braces at all", () => {
		expect(interpolate("Hello World!", {})).toBe("Hello World!")
	})

	it("template with only whitespace", () => {
		expect(interpolate("   ", {})).toBe("   ")
	})

	it("template with unicode", () => {
		expect(interpolate("{name}\u{1F525}", { name: "fire" })).toBe("fire\u{1F525}")
	})

	it("template with HTML-like content", () => {
		expect(interpolate("<b>{x}</b>", { x: "bold" })).toBe("<b>bold</b>")
	})

	it("consecutive ICU blocks no space between", () => {
		expect(
			interpolate("{a, plural, one {#} other {#s}}{b, plural, one {#} other {#s}}", { a: 1, b: 2 }),
		).toBe("12s")
	})

	it("trailing text after ICU block", () => {
		expect(interpolate("{n, plural, other {#}} items", { n: 3 })).toBe("3 items")
	})

	it("leading text before ICU block", () => {
		expect(interpolate("total: {n, plural, other {#}}", { n: 7 })).toBe("total: 7")
	})

	it("surrounding quotes around var", () => {
		expect(interpolate("'{x}'", { x: "val" })).toBe("'val'")
	})
})

/* ═══════════════════════════════════════════
 * COMPLEX REAL-WORLD MESSAGES
 * ═══════════════════════════════════════════ */

describe("interpolate: complex real-world messages", () => {
	it("multi-entity deletion confirmation", () => {
		expect(
			interpolate(
				"Are you sure you want to delete {count, plural, one {this {type}} other {these # {type}s}}?",
				{ count: 5, type: "document" },
			),
		).toBe("Are you sure you want to delete these 5 documents?")
	})

	it("multi-entity deletion singular", () => {
		expect(
			interpolate(
				"Are you sure you want to delete {count, plural, one {this {type}} other {these # {type}s}}?",
				{ count: 1, type: "file" },
			),
		).toBe("Are you sure you want to delete this file?")
	})

	it("time-based greeting with select", () => {
		expect(
			interpolate(
				"{time, select, morning {Good morning} afternoon {Good afternoon} evening {Good evening} other {Hello}}, {name}!",
				{ name: "Alice", time: "afternoon" },
			),
		).toBe("Good afternoon, Alice!")
	})

	it("form validation summary", () => {
		expect(
			interpolate(
				"{count, plural, one {# field needs} other {# fields need}} correction. Please review {count, plural, one {it} other {them}}.",
				{ count: 3 },
			),
		).toBe("3 fields need correction. Please review them.")
	})

	it("form validation summary singular", () => {
		expect(
			interpolate(
				"{count, plural, one {# field needs} other {# fields need}} correction. Please review {count, plural, one {it} other {them}}.",
				{ count: 1 },
			),
		).toBe("1 field needs correction. Please review it.")
	})

	it("storage quota message", () => {
		expect(
			interpolate(
				"You have used {used, number} of {total, number} GB. {remaining, plural, =0 {Storage full!} one {# GB remaining.} other {# GB remaining.}}",
				{ remaining: 0, total: 100, used: 100 },
				"en",
			),
		).toBe("You have used 100 of 100 GB. Storage full!")
	})

	it("notification with sender and count", () => {
		expect(
			interpolate("{sender} sent you {count, plural, one {a message} other {# messages}}", {
				count: 7,
				sender: "Bob",
			}),
		).toBe("Bob sent you 7 messages")
	})

	it("error with code and retry", () => {
		expect(
			interpolate(
				"Error {code}: {action, select, retry {Please try again in {seconds, plural, one {# second} other {# seconds}}} contact {Contact support at {email}} other {An error occurred}}",
				{ action: "retry", code: "E429", email: "help@test.com", seconds: 30 },
			),
		).toBe("Error E429: Please try again in 30 seconds")
	})

	it("permission with role and resource", () => {
		expect(
			interpolate(
				"{role, select, admin {You can {action} all {resource, plural, one {# {type}} other {# {type}s}}} member {You can {action} your own {type}s} other {Access denied}}",
				{ action: "edit", resource: 5, role: "admin", type: "project" },
			),
		).toBe("You can edit all 5 projects")
	})
})

/* ═══════════════════════════════════════════
 * CONCURRENT SAFETY
 * ═══════════════════════════════════════════ */

describe("interpolate: concurrent calls (no shared state)", () => {
	it("parallel calls with different vars don't interfere", () => {
		const tpl = "{n, plural, one {# item for {name}} other {# items for {name}}}"
		const results = Array.from({ length: 100 }, (_, i) =>
			interpolate(tpl, { n: i, name: `user${i}` }),
		)
		for (let i = 0; i < 100; i++) {
			if (i === 1) {
				expect(results[i]).toBe("1 item for user1")
			} else {
				expect(results[i]).toBe(`${i} items for user${i}`)
			}
		}
	})
})
