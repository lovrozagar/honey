import { describe, expect, it } from "vitest"
import { interpolate, resolveTranslation, TranslationRegistry } from "../../../src/i18n.ts"

const msg = "{n, plural, one{# file} few{# soubory} many{# souboru} other{# souborů}}"

describe("i18n — CLDR plural rules", () => {
	it("uses the locale's categories (Czech one/few/other)", () => {
		expect(interpolate(msg, { n: 1 }, "cs")).toBe("1 file")
		expect(interpolate(msg, { n: 3 }, "cs")).toBe("3 soubory")
		expect(interpolate(msg, { n: 7 }, "cs")).toBe("7 souborů")
	})

	it("uses few/many for Polish", () => {
		const pl = "{n, plural, one{# plik} few{# pliki} many{# plików} other{# pliku}}"
		expect(interpolate(pl, { n: 2 }, "pl")).toBe("2 pliki")
		expect(interpolate(pl, { n: 5 }, "pl")).toBe("5 plików")
		expect(interpolate(pl, { n: 1.5 }, "pl")).toBe("1,5 pliku")
	})

	it("formats # for the locale when one is given", () => {
		expect(interpolate("{n, plural, other{# items}}", { n: 1234567 }, "de")).toBe("1.234.567 items")
		expect(interpolate("{n, plural, other{# items}}", { n: 1234567 })).toBe("1234567 items")
	})

	it("defaults to English rules without a locale", () => {
		expect(interpolate("{n, plural, one{one} other{other}}", { n: 1 })).toBe("one")
		expect(interpolate("{n, plural, one{one} other{other}}", { n: 0 })).toBe("other")
	})

	it("resolveTranslation passes the locale through", async () => {
		const registry = new TranslationRegistry({ cs: { files: msg } })
		expect(await resolveTranslation(registry, "cs", "files", { n: 4 })).toBe("4 soubory")
	})
})

describe("i18n — keys from data never hit Object.prototype", () => {
	it("a select value named like a prototype member falls back to other", () => {
		const select = "{role, select, admin{Admin} other{User}}"
		for (const role of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
			expect(interpolate(select, { role })).toBe("User")
		}
	})

	it("a select branch named constructor still works", () => {
		expect(interpolate("{k, select, constructor{ctor} other{x}}", { k: "constructor" })).toBe("ctor")
	})

	it("variables named like prototype members are not resolved from the prototype", () => {
		expect(interpolate("{constructor} {toString}", {})).toBe("{constructor} {toString}")
	})

	it("translation keys and locales named like prototype members miss", async () => {
		const registry = new TranslationRegistry({ en: { hello: "Hi" } })
		expect(await resolveTranslation(registry, "en", "constructor", {})).toBe("constructor")
		expect(await resolveTranslation(registry, "constructor", "hello", {})).toBe("hello")
	})
})
