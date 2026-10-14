import { describe, expect, it } from "vitest"
import { resolveFieldName, resolveTranslation, TranslationRegistry } from "./i18n.ts"

describe("TranslationRegistry: a locale's map, loaded once", () => {
	// v0: 4b10b8434b
	// v0: 93b342e29e
	// v0: ef26ca0250
	it("a static map is there at once; an empty one is valid; an unknown locale is undefined", async () => {
		const registry = new TranslationRegistry({ empty: {}, en: { greeting: "Hello {name}" } })
		expect([await registry.get("en"), await registry.get("empty"), await registry.get("fr")]).toEqual([
			{ greeting: "Hello {name}" },
			{},
			undefined,
		])
	})
})

describe("TranslationRegistry: a loader, its failure, and a large map", () => {
	// v0: 1e31438934
	// v0: ef13670efc
	it.each([
		["a sync loader", () => ({ greeting: "Hello" })],
		["an async loader", async () => ({ greeting: "Hello" })],
	])("%s runs once; later gets are the same map", async (_name, load) => {
		let calls = 0
		const registry = new TranslationRegistry({
			en: () => {
				calls++
				return load()
			},
		})
		const [first, second] = [await registry.get("en"), await registry.get("en")]
		expect([first, first === second, calls]).toEqual([{ greeting: "Hello" }, true, 1])
	})
})

describe("TranslationRegistry: a cache per locale, a rejection per failing loader", () => {
	// v0: 43d4314fbf
	it("each locale is cached on its own", async () => {
		const registry = new TranslationRegistry({
			de: { greeting: "Hallo" },
			en: { greeting: "Hello" },
			fr: { greeting: "Bonjour" },
		})
		const [en, de, fr] = [await registry.get("en"), await registry.get("de"), await registry.get("fr")]
		expect([en, de, fr, (await registry.get("en")) === en, (await registry.get("de")) === de]).toEqual([
			{ greeting: "Hello" },
			{ greeting: "Hallo" },
			{ greeting: "Bonjour" },
			true,
			true,
		])
	})

	// v0: 996f028b3c
	// v0: 48dbb309d8
	it.each([
		[
			"a loader that throws",
			() => {
				throw new Error("load failed")
			},
			"load failed",
		],
		[
			"a loader that rejects",
			async () => {
				throw new Error("network error")
			},
			"network error",
		],
	])("%s rejects with its error", async (_name, load, message) => {
		await expect(new TranslationRegistry({ en: load }).get("en")).rejects.toThrow(message)
	})

	// v0: f8ddf338cf
	it("a large map is served whole", async () => {
		const map = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`key_${i}`, `Value ${i}`]))
		const loaded = await new TranslationRegistry({ en: map }).get("en")
		expect([loaded?.key_0, loaded?.key_999]).toEqual(["Value 0", "Value 999"])
	})
})

describe("resolveTranslation(): a key's message, interpolated for the locale", () => {
	// v0: 78203a7511
	// v0: b1d982865b
	// v0: 169cef9a23
	// v0: 5b957676dc
	it("the message with its vars; missing vars stay placeholders", async () => {
		const registry = new TranslationRegistry({
			en: {
				greeting: "Hello {name}",
				limit: "Max {max}, min {min}",
				partial: "Hello {name}, welcome to {place}",
				simple: "No variables here",
			},
		})
		const resolved = await Promise.all([
			resolveTranslation(registry, "en", "greeting", { name: "World" }),
			resolveTranslation(registry, "en", "limit", { max: 100, min: 0 }),
			resolveTranslation(registry, "en", "simple", {}),
			resolveTranslation(registry, "en", "partial", { name: "Alice" }),
		])
		expect(resolved).toEqual(["Hello World", "Max 100, min 0", "No variables here", "Hello Alice, welcome to {place}"])
	})

	// v0: 8d66500840
	// v0: 40c1f80756
	it("an unknown key or locale is the key itself", async () => {
		const registry = new TranslationRegistry({ en: {} })
		expect([
			await resolveTranslation(registry, "en", "unknown_key", {}),
			await resolveTranslation(registry, "fr", "greeting", {}),
		]).toEqual(["unknown_key", "greeting"])
	})

	// v0: 90ac7e02e2
	it("the locale reaches the plural rules", async () => {
		const registry = new TranslationRegistry({
			cs: { files: "{n, plural, one{# file} few{# soubory} many{# souboru} other{# souborů}}" },
		})
		expect(await resolveTranslation(registry, "cs", "files", { n: 4 })).toBe("4 soubory")
	})
})

describe("resolveTranslation(): keys from data, and the registry's formatter", () => {
	// v0: a1e4a30be8
	it("a key or a locale named like a prototype member misses", async () => {
		const registry = new TranslationRegistry({ en: { hello: "Hi" } })
		expect([
			await resolveTranslation(registry, "en", "constructor", {}),
			await resolveTranslation(registry, "constructor", "hello", {}),
		]).toEqual(["constructor", "hello"])
	})

	it("a registry keeps its plural rules between translations", async () => {
		const Real = Intl.PluralRules
		let built = 0
		Object.defineProperty(Intl, "PluralRules", {
			configurable: true,
			value: class extends Real {
				constructor(...args: ConstructorParameters<typeof Real>) {
					super(...args)
					built++
				}
			},
			writable: true,
		})
		try {
			const registry = new TranslationRegistry({ en: { items: "{n, plural, one {# item} other {# items}}" } })
			const out = [
				await resolveTranslation(registry, "en", "items", { n: 1 }),
				await resolveTranslation(registry, "en", "items", { n: 2 }),
			]
			expect([out, built]).toEqual([["1 item", "2 items"], 1])
		} finally {
			Object.defineProperty(Intl, "PluralRules", { configurable: true, value: Real, writable: true })
		}
	})
})

describe("resolveFieldName(): a field path's display name", () => {
	// v0: 43c7bb7541
	// v0: 9a1de4fe39
	// v0: 26c22be854
	// v0: efdb30a27e
	// v0: 25138d22bb
	// v0: a32dca5c31
	it.each([
		["email", { email: "Email address" }, "en", "Email address"],
		["json.address.billing.zip", { "json.address.billing.zip": "Billing ZIP Code" }, "en", "Billing ZIP Code"],
		["json.items[0].name", { "json.items[0].name": "First Item Name" }, "en", "First Item Name"],
		["", { "": "Root" }, "en", "Root"],
		["json.email", {}, "en", "json.email"],
		["json.email", { "json.email": "Email" }, "fr", "json.email"],
	])("%j with %j in %s → %j", async (path, names, locale, expected) => {
		expect(await resolveFieldName(new TranslationRegistry({ en: names }), locale, path)).toBe(expected)
	})
})
