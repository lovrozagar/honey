import { describe, expect, expectTypeOf, it } from "vitest"
import type { ExtractICUVars } from "../../../src/i18n.ts"
import {
	interpolate,
	resolveFieldName,
	resolveTranslation,
	TranslationRegistry,
} from "../../../src/i18n.ts"

describe("ExtractICUVars — type-level", () => {
	it("{field} is required → { field: string | number }", () => {
		expectTypeOf<ExtractICUVars<"{field} is required">>().toEqualTypeOf<{
			field: string | number
		}>()
	})

	it("multiple vars", () => {
		expectTypeOf<ExtractICUVars<"{field} must be at least {min}">>().toEqualTypeOf<{
			field: string | number
			min: string | number
		}>()
	})

	it("no vars → {}", () => {
		expectTypeOf<ExtractICUVars<"Something went wrong">>().toEqualTypeOf<{}>()
	})

	it("excludes cause", () => {
		expectTypeOf<ExtractICUVars<"{cause} error">>().toEqualTypeOf<{}>()
	})

	it("duplicate var → single key", () => {
		expectTypeOf<ExtractICUVars<"{x} and {x}">>().toEqualTypeOf<{
			x: string | number
		}>()
	})

	it("three vars", () => {
		expectTypeOf<ExtractICUVars<"{a} {b} {c}">>().toEqualTypeOf<{
			a: string | number
			b: string | number
			c: string | number
		}>()
	})

	it("adjacent vars {a}{b}", () => {
		expectTypeOf<ExtractICUVars<"{a}{b}">>().toEqualTypeOf<{
			a: string | number
			b: string | number
		}>()
	})

	it("var after cause → cause excluded, other kept", () => {
		expectTypeOf<ExtractICUVars<"{cause} then {field}">>().toEqualTypeOf<{
			field: string | number
		}>()
	})

	it("cause between other vars → excluded", () => {
		expectTypeOf<ExtractICUVars<"{a} {cause} {b}">>().toEqualTypeOf<{
			a: string | number
			b: string | number
		}>()
	})

	it("single char var name", () => {
		expectTypeOf<ExtractICUVars<"{x}">>().toEqualTypeOf<{ x: string | number }>()
	})
})

describe("interpolate", () => {
	it("single var replacement", () => {
		expect(interpolate("{field} is required", { field: "Email" })).toBe("Email is required")
	})

	it("multiple vars", () => {
		expect(interpolate("{field} must be at least {min} chars", { field: "Name", min: 3 })).toBe(
			"Name must be at least 3 chars",
		)
	})

	it("missing var → placeholder preserved", () => {
		expect(interpolate("{field} is required", {})).toBe("{field} is required")
	})

	it("no vars in template → returns as-is", () => {
		expect(interpolate("Something went wrong", {})).toBe("Something went wrong")
	})

	it("special chars in var value", () => {
		expect(interpolate("{x}", { x: "<script>alert(1)</script>" })).toBe("<script>alert(1)</script>")
	})

	it("empty template string", () => {
		expect(interpolate("", {})).toBe("")
	})

	it("template with only vars", () => {
		expect(interpolate("{x}", { x: "hello" })).toBe("hello")
	})

	it("double braces — treated as ICU block, not escaped literal", () => {
		/* {{x}} → outer braces wrap {x} as content, inner parsed as branch-like structure */
		const result = interpolate("{{x}}", { x: "val" })
		expect(result).toBe("{{x}}")
	})

	it("numeric var value zero", () => {
		expect(interpolate("{count} items", { count: 0 })).toBe("0 items")
	})

	it("negative numeric var value", () => {
		expect(interpolate("offset: {n}", { n: -5 })).toBe("offset: -5")
	})

	it("consecutive vars with no separator", () => {
		expect(interpolate("{a}{b}{c}", { a: "X", b: "Y", c: "Z" })).toBe("XYZ")
	})

	it("var name with digits", () => {
		expect(interpolate("{field1} and {field2}", { field1: "A", field2: "B" })).toBe("A and B")
	})

	it("var name with underscore", () => {
		expect(interpolate("{my_var}", { my_var: "ok" })).toBe("ok")
	})

	it("cause is NOT excluded at runtime (only at type level)", () => {
		expect(interpolate("{cause} happened", { cause: "timeout" })).toBe("timeout happened")
	})

	it("unicode in template text", () => {
		expect(interpolate("Fehler: {msg} \u{1F525}", { msg: "kaputt" })).toBe(
			"Fehler: kaputt \u{1F525}",
		)
	})

	it("var at very start of template", () => {
		expect(interpolate("{x} is great", { x: "Honey" })).toBe("Honey is great")
	})

	it("var at very end of template", () => {
		expect(interpolate("Hello {x}", { x: "World" })).toBe("Hello World")
	})

	it("extra vars in map are ignored", () => {
		expect(interpolate("{x}", { extra: "nope", x: "yes" })).toBe("yes")
	})

	it("var value is empty string", () => {
		expect(interpolate("[{x}]", { x: "" })).toBe("[]")
	})

	it("curly braces without var name → not replaced", () => {
		expect(interpolate("{} is empty", {})).toBe("{} is empty")
	})

	it("unclosed brace → not replaced", () => {
		expect(interpolate("{unclosed is broken", {})).toBe("{unclosed is broken")
	})

	it("three consecutive same vars", () => {
		expect(interpolate("{x}{x}{x}", { x: "a" })).toBe("aaa")
	})
})

describe("TranslationRegistry", () => {
	it("static source loads immediately", async () => {
		const registry = new TranslationRegistry({
			en: { greeting: "Hello {name}" },
		})
		const result = await registry.get("en")
		expect(result).toEqual({ greeting: "Hello {name}" })
	})

	it("sync function source called once, result cached", async () => {
		let calls = 0
		const registry = new TranslationRegistry({
			en: () => {
				calls++
				return { greeting: "Hello" }
			},
		})
		await registry.get("en")
		await registry.get("en")
		expect(calls).toBe(1)
	})

	it("async function source awaited, cached", async () => {
		let calls = 0
		const registry = new TranslationRegistry({
			en: async () => {
				calls++
				return { greeting: "Hello" }
			},
		})
		const first = await registry.get("en")
		const second = await registry.get("en")
		expect(first).toEqual({ greeting: "Hello" })
		expect(first).toBe(second)
		expect(calls).toBe(1)
	})

	it("unknown locale → returns undefined", async () => {
		const registry = new TranslationRegistry({})
		expect(await registry.get("fr")).toBeUndefined()
	})

	it("multiple locales independently cached", async () => {
		const registry = new TranslationRegistry({
			de: { greeting: "Hallo" },
			en: { greeting: "Hello" },
			fr: { greeting: "Bonjour" },
		})
		const en = await registry.get("en")
		const de = await registry.get("de")
		const fr = await registry.get("fr")
		expect(en).toEqual({ greeting: "Hello" })
		expect(de).toEqual({ greeting: "Hallo" })
		expect(fr).toEqual({ greeting: "Bonjour" })
		/* cached — same reference on second access */
		expect(await registry.get("en")).toBe(en)
		expect(await registry.get("de")).toBe(de)
	})

	it("source function that throws → rejects", async () => {
		const registry = new TranslationRegistry({
			en: () => {
				throw new Error("load failed")
			},
		})
		await expect(registry.get("en")).rejects.toThrow("load failed")
	})

	it("async source function that rejects → rejects", async () => {
		const registry = new TranslationRegistry({
			en: async () => {
				throw new Error("network error")
			},
		})
		await expect(registry.get("en")).rejects.toThrow("network error")
	})

	it("empty translation map is valid", async () => {
		const registry = new TranslationRegistry({ en: {} })
		const result = await registry.get("en")
		expect(result).toEqual({})
	})

	it("source returning large map", async () => {
		const bigMap: Record<string, string> = {}
		for (let i = 0; i < 1000; i++) {
			bigMap[`key_${i}`] = `Value ${i}`
		}
		const registry = new TranslationRegistry({ en: bigMap })
		const result = await registry.get("en")
		expect(result?.key_0).toBe("Value 0")
		expect(result?.key_999).toBe("Value 999")
	})
})

describe("resolveTranslation", () => {
	it("known key → interpolated string", async () => {
		const registry = new TranslationRegistry({
			en: { greeting: "Hello {name}" },
		})
		const result = await resolveTranslation(registry, "en", "greeting", { name: "World" })
		expect(result).toBe("Hello World")
	})

	it("unknown key → returns key as-is", async () => {
		const registry = new TranslationRegistry({ en: {} })
		expect(await resolveTranslation(registry, "en", "unknown_key", {})).toBe("unknown_key")
	})

	it("unknown locale → returns key as-is", async () => {
		const registry = new TranslationRegistry({})
		expect(await resolveTranslation(registry, "fr", "greeting", {})).toBe("greeting")
	})

	it("numeric vars interpolated correctly", async () => {
		const registry = new TranslationRegistry({
			en: { limit: "Max {max}, min {min}" },
		})
		const result = await resolveTranslation(registry, "en", "limit", { max: 100, min: 0 })
		expect(result).toBe("Max 100, min 0")
	})

	it("empty vars object with var-free template", async () => {
		const registry = new TranslationRegistry({
			en: { simple: "No variables here" },
		})
		const result = await resolveTranslation(registry, "en", "simple", {})
		expect(result).toBe("No variables here")
	})

	it("template with missing vars → placeholders preserved", async () => {
		const registry = new TranslationRegistry({
			en: { greeting: "Hello {name}, welcome to {place}" },
		})
		const result = await resolveTranslation(registry, "en", "greeting", { name: "Alice" })
		expect(result).toBe("Hello Alice, welcome to {place}")
	})
})

describe("resolveFieldName", () => {
	it("known field → translated name", async () => {
		const registry = new TranslationRegistry({
			en: { email: "Email address" },
		})
		expect(await resolveFieldName(registry, "en", "email")).toBe("Email address")
	})

	it("unknown field → raw path returned", async () => {
		const registry = new TranslationRegistry({ en: {} })
		expect(await resolveFieldName(registry, "en", "json.email")).toBe("json.email")
	})

	it("deeply nested field path", async () => {
		const registry = new TranslationRegistry({
			en: { "json.address.billing.zip": "Billing ZIP Code" },
		})
		expect(await resolveFieldName(registry, "en", "json.address.billing.zip")).toBe(
			"Billing ZIP Code",
		)
	})

	it("unknown locale → raw field path", async () => {
		const registry = new TranslationRegistry({
			en: { "json.email": "Email" },
		})
		expect(await resolveFieldName(registry, "fr", "json.email")).toBe("json.email")
	})

	it("empty string field path", async () => {
		const registry = new TranslationRegistry({ en: { "": "Root" } })
		expect(await resolveFieldName(registry, "en", "")).toBe("Root")
	})

	it("field path with special characters", async () => {
		const registry = new TranslationRegistry({
			en: { "json.items[0].name": "First Item Name" },
		})
		expect(await resolveFieldName(registry, "en", "json.items[0].name")).toBe("First Item Name")
	})
})
