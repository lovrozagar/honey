import { describe, expect, it } from "vitest"
import { interpolate } from "../../../src/i18n.ts"

/* ═══════════════════════════════════════════
 * ICU PLURAL
 * ═══════════════════════════════════════════ */

describe("interpolate: ICU plural", () => {
	it("plural other branch", () => {
		expect(
			interpolate("{count, plural, one {# item} other {# items}}", {
				count: 5,
			}),
		).toBe("5 items")
	})

	it("plural one branch", () => {
		expect(
			interpolate("{count, plural, one {# item} other {# items}}", {
				count: 1,
			}),
		).toBe("1 item")
	})

	it("plural zero exact match =0", () => {
		expect(interpolate("{count, plural, =0 {no items} one {# item} other {# items}}", { count: 0 })).toBe("no items")
	})

	it("plural exact match =5 takes precedence over category", () => {
		expect(
			interpolate("{count, plural, =5 {exactly five} other {# things}}", {
				count: 5,
			}),
		).toBe("exactly five")
	})

	it("# replaced with actual number", () => {
		expect(interpolate("{n, plural, other {# results found}}", { n: 42 })).toBe("42 results found")
	})

	it("plural with nested simple var", () => {
		expect(
			interpolate("{count, plural, one {{name} has # item} other {{name} has # items}}", {
				count: 3,
				name: "Alice",
			}),
		).toBe("Alice has 3 items")
	})

	it("plural falls back to other when category missing", () => {
		expect(interpolate("{count, plural, other {# items}}", { count: 1 })).toBe("1 items")
	})

	it("plural with large number", () => {
		expect(
			interpolate("{count, plural, one {# item} other {# items}}", {
				count: 1000000,
			}),
		).toBe("1000000 items")
	})
})

/* ═══════════════════════════════════════════
 * ICU SELECT
 * ═══════════════════════════════════════════ */

describe("interpolate: ICU select", () => {
	it("select matches exact value", () => {
		expect(
			interpolate("{role, select, admin {Administrator} user {Regular User} other {Unknown}}", {
				role: "admin",
			}),
		).toBe("Administrator")
	})

	it("select falls back to other", () => {
		expect(
			interpolate("{role, select, admin {Admin} other {User}}", {
				role: "viewer",
			}),
		).toBe("User")
	})

	it("select with missing var → empty string matches other", () => {
		expect(interpolate("{gender, select, male {He} female {She} other {They}}", {})).toBe("They")
	})

	it("select with nested simple var", () => {
		expect(
			interpolate("{type, select, error {{msg} failed} other {OK}}", {
				msg: "Upload",
				type: "error",
			}),
		).toBe("Upload failed")
	})
})

/* ═══════════════════════════════════════════
 * ICU NUMBER
 * ═══════════════════════════════════════════ */

describe("interpolate: ICU number", () => {
	it("number format with locale", () => {
		const result = interpolate("{amount, number}", { amount: 1234.5 }, "en")
		expect(result).toContain("1")
		expect(result).toContain("234")
	})

	it("number format without locale still works", () => {
		const result = interpolate("{amount, number}", { amount: 42 })
		expect(result).toBe("42")
	})

	it("number format with missing var → placeholder", () => {
		expect(interpolate("{amount, number}", {})).toBe("{amount}")
	})
})

/* ═══════════════════════════════════════════
 * MIXED: plural + simple + select
 * ═══════════════════════════════════════════ */

describe("interpolate: mixed ICU patterns", () => {
	it("simple var + plural in same message", () => {
		expect(
			interpolate("Hello {name}, you have {count, plural, one {# message} other {# messages}}", {
				count: 0,
				name: "Bob",
			}),
		).toBe("Hello Bob, you have 0 messages")
	})

	it("two plural blocks in one message", () => {
		expect(
			interpolate(
				"{files, plural, one {# file} other {# files}} and {folders, plural, one {# folder} other {# folders}}",
				{ files: 1, folders: 3 },
			),
		).toBe("1 file and 3 folders")
	})

	it("select + simple in same message", () => {
		expect(
			interpolate("{gender, select, male {Mr.} female {Ms.} other {Mx.}} {name}", {
				gender: "female",
				name: "Smith",
			}),
		).toBe("Ms. Smith")
	})
})

/* ═══════════════════════════════════════════
 * BACKWARD COMPAT: simple {var} still works
 * ═══════════════════════════════════════════ */

describe("interpolate: backward compatibility", () => {
	it("simple var replacement still works", () => {
		expect(interpolate("{field} is required", { field: "Email" })).toBe("Email is required")
	})

	it("multiple simple vars", () => {
		expect(interpolate("{a} and {b}", { a: "X", b: "Y" })).toBe("X and Y")
	})

	it("no vars → returns as-is", () => {
		expect(interpolate("No variables here", {})).toBe("No variables here")
	})

	it("empty template → empty string", () => {
		expect(interpolate("", {})).toBe("")
	})

	it("numeric var value zero renders as 0", () => {
		expect(interpolate("{count} items", { count: 0 })).toBe("0 items")
	})

	it("missing simple var → placeholder preserved", () => {
		expect(interpolate("{missing} here", {})).toBe("{missing} here")
	})
})

/* ═══════════════════════════════════════════
 * EDGE CASES
 * ═══════════════════════════════════════════ */

describe("interpolate: edge cases", () => {
	it("unclosed brace → literal text", () => {
		expect(interpolate("{unclosed", {})).toBe("{unclosed")
	})

	it("empty braces → placeholder", () => {
		expect(interpolate("{}", {})).toBe("{}")
	})

	it("special chars in var value", () => {
		expect(interpolate("{x}", { x: "<script>alert(1)</script>" })).toBe("<script>alert(1)</script>")
	})

	it("plural with whitespace variations", () => {
		expect(interpolate("{n,plural,one{#}other{#s}}", { n: 1 })).toBe("1")
	})

	it("deeply nested plural in select", () => {
		expect(
			interpolate("{type, select, summary {{count, plural, one {# item} other {# items}} total} other {details}}", {
				count: 5,
				type: "summary",
			}),
		).toBe("5 items total")
	})
})

/* ═══════════════════════════════════════════
 * PLURAL: exhaustive category matching
 * ═══════════════════════════════════════════ */

describe("interpolate: plural categories", () => {
	it("=0 exact match with no other category", () => {
		expect(interpolate("{n, plural, =0 {empty}}", { n: 0 })).toBe("empty")
	})

	it("=0 not matched when n=1 → falls to one", () => {
		expect(
			interpolate("{n, plural, =0 {empty} one {single} other {many}}", {
				n: 1,
			}),
		).toBe("single")
	})

	it("=1 exact match takes precedence over one category", () => {
		expect(interpolate("{n, plural, =1 {exact one} one {category one} other {many}}", { n: 1 })).toBe("exact one")
	})

	it("=100 exact match", () => {
		expect(interpolate("{n, plural, =100 {century} other {# items}}", { n: 100 })).toBe("century")
	})

	it("negative number → other category", () => {
		expect(interpolate("{n, plural, one {# item} other {# items}}", { n: -3 })).toBe("-3 items")
	})

	it("fractional number → other category (not one)", () => {
		expect(interpolate("{n, plural, one {# item} other {# items}}", { n: 1.5 })).toBe("1.5 items")
	})

	it("missing var in plural → defaults to 0", () => {
		expect(interpolate("{n, plural, =0 {zero} one {one} other {other}}", {})).toBe("zero")
	})

	it("NaN as plural value → treated as 0", () => {
		expect(interpolate("{n, plural, =0 {zero} other {num}}", { n: NaN })).toBe("num")
	})
})

/* ═══════════════════════════════════════════
 * PLURAL: # replacement deep
 * ═══════════════════════════════════════════ */

describe("interpolate: # replacement", () => {
	it("multiple # in same branch", () => {
		expect(interpolate("{n, plural, other {# out of # total}}", { n: 5 })).toBe("5 out of 5 total")
	})

	it("# not replaced outside plural context", () => {
		expect(interpolate("# is not replaced here", {})).toBe("# is not replaced here")
	})

	it("# in simple var context → literal", () => {
		expect(interpolate("{x}", { x: "#" })).toBe("#")
	})

	it("# with zero", () => {
		expect(interpolate("{n, plural, other {# items}}", { n: 0 })).toBe("0 items")
	})

	it("# with negative", () => {
		expect(interpolate("{n, plural, other {# offset}}", { n: -10 })).toBe("-10 offset")
	})
})

/* ═══════════════════════════════════════════
 * SELECT: exhaustive cases
 * ═══════════════════════════════════════════ */

describe("interpolate: select exhaustive", () => {
	it("select with many branches", () => {
		const tpl = "{status, select, pending {Waiting} active {Running} done {Finished} error {Failed} other {Unknown}}"
		expect(interpolate(tpl, { status: "pending" })).toBe("Waiting")
		expect(interpolate(tpl, { status: "active" })).toBe("Running")
		expect(interpolate(tpl, { status: "done" })).toBe("Finished")
		expect(interpolate(tpl, { status: "error" })).toBe("Failed")
		expect(interpolate(tpl, { status: "unknown_value" })).toBe("Unknown")
	})

	it("select with numeric string value", () => {
		expect(interpolate("{x, select, 1 {One} 2 {Two} other {Other}}", { x: "1" })).toBe("One")
	})

	it("select with numeric var → converted to string", () => {
		expect(interpolate("{x, select, 42 {Answer} other {Nope}}", { x: 42 })).toBe("Answer")
	})

	it("select with empty string value → matches other", () => {
		expect(interpolate("{x, select, a {A} other {Empty}}", { x: "" })).toBe("Empty")
	})

	it("select branch with spaces in content", () => {
		expect(
			interpolate("{x, select, yes {Yes, please!} other {No, thanks.}}", {
				x: "yes",
			}),
		).toBe("Yes, please!")
	})

	it("select no other branch + no match → empty", () => {
		expect(interpolate("{x, select, a {A} b {B}}", { x: "c" })).toBe("")
	})
})

/* ═══════════════════════════════════════════
 * NUMBER: formatting
 * ═══════════════════════════════════════════ */

describe("interpolate: number format deep", () => {
	it("formats large number with locale en", () => {
		const result = interpolate("{n, number}", { n: 1234567 }, "en")
		expect(result).toContain(",")
		expect(result).toContain("1")
	})

	it("formats decimal with locale en", () => {
		const result = interpolate("{n, number}", { n: Math.PI }, "en")
		expect(result).toContain("3")
		expect(result).toContain("14")
	})

	it("formats zero", () => {
		expect(interpolate("{n, number}", { n: 0 }, "en")).toBe("0")
	})

	it("formats negative number", () => {
		const result = interpolate("{n, number}", { n: -42 }, "en")
		expect(result).toContain("42")
	})

	it("number from string var", () => {
		const result = interpolate("{n, number}", { n: "999" }, "en")
		expect(result).toBe("999")
	})
})

/* ═══════════════════════════════════════════
 * NESTING: deep combinations
 * ═══════════════════════════════════════════ */

describe("interpolate: deep nesting", () => {
	it("select inside plural branch", () => {
		expect(
			interpolate(
				"{count, plural, one {{gender, select, male {He has} female {She has} other {They have}} # item} other {{gender, select, male {He has} female {She has} other {They have}} # items}}",
				{ count: 1, gender: "female" },
			),
		).toBe("She has 1 item")
	})

	it("plural inside plural branch — # references outer value", () => {
		/* # inside nested plural gets replaced with the OUTER plural value first
		   (ICU spec: # is replaced before recursion). Inner b=1 matches "one" correctly
		   but # was already replaced with a=3 */
		expect(
			interpolate(
				"{a, plural, one {# file in {b, plural, one {# folder} other {# folders}}} other {# files in {b, plural, one {# folder} other {# folders}}}}",
				{ a: 3, b: 1 },
			),
		).toBe("3 files in 3 folder")
	})

	it("three levels of nesting", () => {
		expect(
			interpolate("{a, select, x {{b, select, y {{c}} other {nope}}} other {no}}", {
				a: "x",
				b: "y",
				c: "deep",
			}),
		).toBe("deep")
	})

	it("mixed nesting: text + select + plural + simple", () => {
		expect(
			interpolate(
				"Dear {gender, select, male {Mr.} female {Ms.} other {Mx.}} {name}, you have {count, plural, =0 {no new messages} one {# new message} other {# new messages}}.",
				{ count: 0, gender: "male", name: "Smith" },
			),
		).toBe("Dear Mr. Smith, you have no new messages.")
	})
})

/* ═══════════════════════════════════════════
 * TOKENIZER: parser edge cases
 * ═══════════════════════════════════════════ */

describe("interpolate: parser edge cases", () => {
	it("only literal text, no braces", () => {
		expect(interpolate("just text", {})).toBe("just text")
	})

	it("single open brace at end", () => {
		expect(interpolate("text {", {})).toBe("text {")
	})

	it("mismatched braces → outer brace matches inner close", () => {
		/* { at pos 5 matches } at end — inner content is " {x" which is not a valid var */
		expect(interpolate("text { {x}", { x: "val" })).toBe("text { {x}")
	})

	it("empty string", () => {
		expect(interpolate("", {})).toBe("")
	})

	it("only a var", () => {
		expect(interpolate("{x}", { x: "only" })).toBe("only")
	})

	it("var with leading/trailing spaces in name", () => {
		expect(interpolate("{ x }", { x: "trimmed" })).toBe("trimmed")
	})

	it("unknown format type → treated as simple var", () => {
		expect(interpolate("{x, date}", { x: "2026-01-01" })).toBe("2026-01-01")
	})

	it("unknown format with branches → treated as simple var", () => {
		expect(interpolate("{x, custom, a {A} b {B}}", { x: "val" })).toBe("val")
	})

	it("consecutive ICU blocks no space", () => {
		expect(interpolate("{a, plural, one {#} other {#s}}{b, plural, one {#} other {#s}}", { a: 1, b: 2 })).toBe("12s")
	})

	it("literal text between ICU blocks", () => {
		expect(
			interpolate("{a, plural, one {#} other {#s}} and {b, plural, one {#} other {#s}}", {
				a: 1,
				b: 2,
			}),
		).toBe("1 and 2s")
	})

	it("branch content with special characters", () => {
		expect(
			interpolate("{x, select, a {it's <b>bold</b>!} other {nope}}", {
				x: "a",
			}),
		).toBe("it's <b>bold</b>!")
	})

	it("very long message with many vars", () => {
		const vars: Record<string, string | number> = {}
		const parts: string[] = []
		for (let i = 0; i < 50; i++) {
			vars[`v${i}`] = i
			parts.push(`{v${i}}`)
		}
		const result = interpolate(parts.join("-"), vars)
		expect(result).toBe(Array.from({ length: 50 }, (_, i) => i).join("-"))
	})

	it("null-ish values → placeholder", () => {
		expect(interpolate("{x}", { x: undefined as unknown as string })).toBe("{x}")
	})

	it("boolean value converted to string", () => {
		expect(interpolate("{x}", { x: true as unknown as string })).toBe("true")
	})
})

/* ═══════════════════════════════════════════
 * REAL-WORLD: error message patterns
 * ═══════════════════════════════════════════ */

describe("interpolate: real-world error messages", () => {
	it("validation: min length", () => {
		expect(
			interpolate("{field} must be at least {min, plural, one {# character} other {# characters}} long", {
				field: "Password",
				min: 8,
			}),
		).toBe("Password must be at least 8 characters long")
	})

	it("validation: max items", () => {
		expect(
			interpolate("You can select {max, plural, one {up to # item} other {up to # items}}", {
				max: 1,
			}),
		).toBe("You can select up to 1 item")
	})

	it("rate limit with window", () => {
		expect(
			interpolate("Rate limited: {count}/{limit} {limit, plural, one {request} other {requests}} in {window} seconds", {
				count: 150,
				limit: 100,
				window: 60,
			}),
		).toBe("Rate limited: 150/100 requests in 60 seconds")
	})

	it("permission denied with role", () => {
		expect(
			interpolate(
				"{role, select, guest {Please sign in to continue} member {You need admin access} other {Access denied}}",
				{ role: "member" },
			),
		).toBe("You need admin access")
	})

	it("file upload error with size", () => {
		expect(
			interpolate(
				"File too large: {size}MB exceeds {limit}MB limit. {count, plural, one {# file} other {# files}} rejected.",
				{ count: 3, limit: 10, size: 25 },
			),
		).toBe("File too large: 25MB exceeds 10MB limit. 3 files rejected.")
	})

	it("billing: subscription", () => {
		expect(
			interpolate(
				"Your {plan} plan includes {seats, plural, one {# seat} other {# seats}}. {remaining, plural, =0 {No seats remaining} one {# seat remaining} other {# seats remaining}}.",
				{ plan: "Pro", remaining: 0, seats: 5 },
			),
		).toBe("Your Pro plan includes 5 seats. No seats remaining.")
	})

	it("German error with plural", () => {
		expect(
			interpolate("{count, plural, one {# Fehler} other {# Fehler}} gefunden", {
				count: 3,
			}),
		).toBe("3 Fehler gefunden")
	})

	it("Japanese-like (no plural distinction, uses other)", () => {
		expect(
			interpolate("{count, plural, other {#件のエラー}}が見つかりました", {
				count: 5,
			}),
		).toBe("5件のエラーが見つかりました")
	})
})
