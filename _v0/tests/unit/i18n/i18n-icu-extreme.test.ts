import { describe, expect, it } from "vitest"
import { interpolate } from "../../../src/i18n.ts"

/* ═══════════════════════════════════════════
 * ICU KEYWORD COLLISION
 * ═══════════════════════════════════════════ */

describe("interpolate: ICU keyword as var name", () => {
	it("{plural} as simple var → not treated as ICU", () => {
		expect(interpolate("{plural}", { plural: "just-a-value" })).toBe("just-a-value")
	})

	it("{select} as simple var → not treated as ICU", () => {
		expect(interpolate("{select}", { select: "just-a-value" })).toBe("just-a-value")
	})

	it("{number} as simple var → not treated as ICU", () => {
		expect(interpolate("{number}", { number: "just-a-value" })).toBe("just-a-value")
	})

	it("{other} as simple var → not treated as ICU", () => {
		expect(interpolate("{other}", { other: "just-a-value" })).toBe("just-a-value")
	})

	it("{one} as simple var → not treated as ICU", () => {
		expect(interpolate("{one}", { one: "just-a-value" })).toBe("just-a-value")
	})

	it("select branch value that looks like ICU keyword", () => {
		expect(interpolate("{x, select, plural {matched plural} other {nope}}", { x: "plural" })).toBe("matched plural")
	})
})

/* ═══════════════════════════════════════════
 * RECURSIVE SELF-REFERENCE
 * ═══════════════════════════════════════════ */

describe("interpolate: recursive var reference", () => {
	it("plural in plural with same var name", () => {
		expect(
			interpolate(
				"{n, plural, one {# of {n, plural, one {# kind} other {# kinds}}} other {# of {n, plural, one {# kind} other {# kinds}}}}",
				{ n: 1 },
			),
		).toBe("1 of 1 kind")
	})

	it("plural in plural with same var name (other branch)", () => {
		expect(
			interpolate(
				"{n, plural, one {# of {n, plural, one {# kind} other {# kinds}}} other {# of {n, plural, one {# kind} other {# kinds}}}}",
				{ n: 5 },
			),
		).toBe("5 of 5 kinds")
	})

	it("select with same var referenced in branch", () => {
		expect(interpolate("{x, select, a {{x, select, a {{x}} other {no}}} other {no}}", { x: "a" })).toBe("a")
	})
})

/* ═══════════════════════════════════════════
 * # IN NESTED VAR VALUES
 * ═══════════════════════════════════════════ */

describe("interpolate: # interaction with nested vars", () => {
	it("nested var value containing # → # in value preserved as literal", () => {
		expect(interpolate("{n, plural, other {{label} #}}", { label: "item #", n: 5 })).toBe("item # 5")
	})

	it("# only replaced in plural branch, not in simple var", () => {
		expect(interpolate("{x} has # items", { x: "Bob" })).toBe("Bob has # items")
	})

	it("# in select branch → literal (not replaced)", () => {
		expect(interpolate("{x, select, a {price: #} other {no}}", { x: "a" })).toBe("price: #")
	})
})

/* ═══════════════════════════════════════════
 * BRANCH CONTENT EDGE CASES
 * ═══════════════════════════════════════════ */

describe("interpolate: branch content edge cases", () => {
	it("branch with only whitespace", () => {
		expect(interpolate("{x, select, a {   } other {b}}", { x: "a" })).toBe("   ")
	})

	it("branch with only #", () => {
		expect(interpolate("{n, plural, other {#}}", { n: 99 })).toBe("99")
	})

	it("empty branch", () => {
		expect(interpolate("{x, select, a {} other {fallback}}", { x: "a" })).toBe("")
	})

	it("branch with special chars (parens, brackets, etc.)", () => {
		expect(interpolate("{x, select, a {[value] (ok) <done>} other {no}}", { x: "a" })).toBe("[value] (ok) <done>")
	})

	it("branch with URL", () => {
		expect(
			interpolate("{x, select, link {https://example.com/path?q=1&r=2} other {no}}", {
				x: "link",
			}),
		).toBe("https://example.com/path?q=1&r=2")
	})

	it("branch with JSON-like content", () => {
		expect(interpolate('{x, select, json {value: "test"} other {no}}', { x: "json" })).toBe('value: "test"')
	})

	it("branch with emoji", () => {
		expect(interpolate("{x, select, fire {\u{1F525}\u{1F525}\u{1F525}} other {meh}}", { x: "fire" })).toBe(
			"\u{1F525}\u{1F525}\u{1F525}",
		)
	})
})

/* ═══════════════════════════════════════════
 * LARGE / STRESS
 * ═══════════════════════════════════════════ */

describe("interpolate: stress tests", () => {
	it("10000 char branch content", () => {
		const longContent = "A".repeat(10000)
		const result = interpolate(`{x, select, a {${longContent}} other {B}}`, { x: "a" })
		expect(result).toBe(longContent)
		expect(result.length).toBe(10000)
	})

	it("100 simple vars in one message", () => {
		const vars: Record<string, string | number> = {}
		const parts: string[] = []
		for (let i = 0; i < 100; i++) {
			vars[`v${i}`] = `val${i}`
			parts.push(`{v${i}}`)
		}
		const result = interpolate(parts.join(","), vars)
		expect(result).toContain("val0")
		expect(result).toContain("val99")
		expect(result.split(",").length).toBe(100)
	})

	it("20 plural blocks in one message", () => {
		const vars: Record<string, string | number> = {}
		const parts: string[] = []
		for (let i = 0; i < 20; i++) {
			vars[`n${i}`] = i
			parts.push(`{n${i}, plural, one {#} other {#s}}`)
		}
		const result = interpolate(parts.join(" "), vars)
		expect(result).toContain("0s")
		expect(result).toContain("1 ")
		expect(result).toContain("19s")
	})

	it("deeply nested braces do not crash", () => {
		expect(interpolate("{{{{}}}}", {})).toBe("{{{{}}}}")
	})
})

/* ═══════════════════════════════════════════
 * CONSECUTIVE / MIXED FORMAT TYPES
 * ═══════════════════════════════════════════ */

describe("interpolate: consecutive mixed format types", () => {
	it("simple + number + plural consecutive", () => {
		expect(interpolate("{a}{b, number}{c, plural, one {#} other {#s}}", { a: "X", b: 1000, c: 2 }, "en")).toBe(
			"X1,0002s",
		)
	})

	it("number + select + plural", () => {
		expect(
			interpolate(
				"Price: {price, number} — {status, select, sale {ON SALE} other {regular}} — {stock, plural, =0 {out of stock} one {# left} other {# left}}",
				{ price: 29.99, status: "sale", stock: 3 },
				"en",
			),
		).toBe("Price: 29.99 — ON SALE — 3 left")
	})

	it("all three formats with text between", () => {
		expect(
			interpolate(
				"User {name} spent {amount, number} on {items, plural, one {# item} other {# items}}",
				{ amount: 1500, items: 1, name: "Alice" },
				"en",
			),
		).toBe("User Alice spent 1,500 on 1 item")
	})
})

/* ═══════════════════════════════════════════
 * NUMBER: negative zero, string coercion
 * ═══════════════════════════════════════════ */

describe("interpolate: number format edge cases", () => {
	it("negative zero", () => {
		const result = interpolate("{n, number}", { n: -0 }, "en")
		expect(result).toBe("-0")
	})

	it("string coerced to number", () => {
		expect(interpolate("{n, number}", { n: "42.5" }, "en")).toBe("42.5")
	})

	it("non-numeric string → NaN formatted", () => {
		const result = interpolate("{n, number}", { n: "abc" }, "en")
		expect(result).toBe("NaN")
	})

	it("number missing var → placeholder", () => {
		expect(interpolate("{n, number}", {}, "en")).toBe("{n}")
	})

	it("number with null → placeholder", () => {
		expect(interpolate("{n, number}", { n: null as unknown as number }, "en")).toBe("{n}")
	})
})

/* ═══════════════════════════════════════════
 * MISSING OTHER BRANCH
 * ═══════════════════════════════════════════ */

describe("interpolate: missing other branch", () => {
	it("select with no other + no match → empty", () => {
		expect(interpolate("{x, select, a {A} b {B}}", { x: "c" })).toBe("")
	})

	it("plural with no other + no category match → empty", () => {
		expect(interpolate("{n, plural, =5 {five}}", { n: 3 })).toBe("")
	})

	it("plural with no branches at all → empty", () => {
		expect(interpolate("{n, plural,}", { n: 1 })).toBe("")
	})
})

/* ═══════════════════════════════════════════
 * REAL-WORLD MULTILINGUAL
 * ═══════════════════════════════════════════ */

describe("interpolate: multilingual messages", () => {
	it("French with plural", () => {
		expect(
			interpolate("{count, plural, one {# résultat trouvé} other {# résultats trouvés}}", {
				count: 1,
			}),
		).toBe("1 résultat trouvé")
	})

	it("Spanish with select + plural", () => {
		expect(
			interpolate(
				"{gender, select, male {Estimado} female {Estimada} other {Estimado/a}} {name}, tiene {count, plural, one {# mensaje nuevo} other {# mensajes nuevos}}",
				{ count: 5, gender: "female", name: "María" },
			),
		).toBe("Estimada María, tiene 5 mensajes nuevos")
	})

	it("Arabic numeral (RTL text, LTR numbers)", () => {
		expect(interpolate("{count, plural, other {# عنصر}}", { count: 42 })).toBe("42 عنصر")
	})

	it("Chinese with plural (no distinction)", () => {
		expect(interpolate("{count, plural, other {{count}个错误}}已修复", { count: 3 })).toBe("3个错误已修复")
	})

	it("Korean with select", () => {
		expect(
			interpolate("{role, select, admin {관리자} member {회원} other {방문자}}님 환영합니다", {
				role: "admin",
			}),
		).toBe("관리자님 환영합니다")
	})

	it("German compound error", () => {
		expect(
			interpolate("{count, plural, one {# Validierungsfehler} other {# Validierungsfehler}} in {field}", {
				count: 3,
				field: "E-Mail-Adresse",
			}),
		).toBe("3 Validierungsfehler in E-Mail-Adresse")
	})
})

/* ═══════════════════════════════════════════
 * SELECT + MISSING VAR FALLBACK
 * ═══════════════════════════════════════════ */

describe("interpolate: select missing var fallback", () => {
	it("select with missing var → empty string → matches other", () => {
		expect(interpolate("{x, select, a {A} other {default}}", {})).toBe("default")
	})

	it("select with undefined var → matches other", () => {
		expect(
			interpolate("{x, select, a {A} other {fallback}}", {
				x: undefined as unknown as string,
			}),
		).toBe("fallback")
	})

	it("select with null var → matches other", () => {
		expect(
			interpolate("{x, select, a {A} other {fallback}}", {
				x: null as unknown as string,
			}),
		).toBe("fallback")
	})
})
