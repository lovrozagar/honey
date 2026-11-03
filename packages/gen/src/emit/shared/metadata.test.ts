/**
 * The package metadata grammars every target shares: what each accepts and refuses, the refusal naming the option and
 * the value, and a `Name <email>` split at its last ` <`.
 */
import { describe, expect, it } from "vitest"
import {
	authorName,
	checked,
	checkedMetadata,
	HTTPS_URL,
	METADATA_FIELDS,
	PERSON,
	personOf,
	SPDX_EXPRESSION,
	SPDX_ID,
	TEXT,
} from "./metadata.ts"

const GRAMMARS = { HTTPS_URL, PERSON, SPDX_EXPRESSION, SPDX_ID, TEXT }

describe("the package metadata grammars", () => {
	it.each<[keyof typeof GRAMMARS, string, boolean]>([
		["TEXT", "Shop's <API> client: $(x) 100%", true],
		["TEXT", "x".repeat(4000), true],
		["TEXT", "", false],
		["TEXT", "x".repeat(4001), false],
		["TEXT", "two\nlines", false],
		["HTTPS_URL", "https://shop.example.com", true],
		["HTTPS_URL", "https://shop.example.com:8443/a/b", true],
		["HTTPS_URL", "https://shop.example.com/a?b=c", false],
		["HTTPS_URL", "http://shop.example.com", false],
		["HTTPS_URL", "https://", false],
		["HTTPS_URL", "https://shop.example.com/a b", false],
		["SPDX_EXPRESSION", "MIT", true],
		["SPDX_EXPRESSION", "Apache-2.0 OR MIT", true],
		["SPDX_EXPRESSION", "GPL-2.0-only WITH Classpath-exception-2.0", true],
		["SPDX_EXPRESSION", "MIT or Apache-2.0", false],
		["SPDX_EXPRESSION", "(MIT)", false],
		["SPDX_ID", "Apache-2.0", true],
		["SPDX_ID", "GPL-3.0+", true],
		["SPDX_ID", "MIT OR Apache-2.0", false],
		["SPDX_ID", "LicenseRef-Acme", false],
		["SPDX_ID", "-MIT", false],
		["PERSON", "Ada O'Brien <ada@example.com>", true],
		["PERSON", "Ada", false],
		["PERSON", "<ada@example.com>", false],
		["PERSON", "Ada <ada>", false],
		["PERSON", "Ada <a@b.c> x", false],
	])("%s on %j is %s", (grammar, value, accepted) => {
		expect(GRAMMARS[grammar].test(value)).toBe(accepted)
	})

	it("passes a value its grammar accepts and an absent one, and refuses another naming the option", () => {
		expect([checked("license", "MIT", SPDX_ID), checked("license", undefined, SPDX_ID)]).toEqual(["MIT", undefined])
		expect(() => checked("license", "MIT;x", SPDX_ID)).toThrow('Invalid license: "MIT;x"')
	})

	it("splits a person into its name and email", () => {
		expect(personOf("Ada O'Brien <ada@example.com>")).toEqual({ email: "ada@example.com", name: "Ada O'Brien" })
	})
})

describe("the package metadata block (plan 39 8.2)", () => {
	const full = {
		authors: ["Acme Inc <oss@acme.dev>", "Bo"],
		changelog: "https://acme.dev/changelog",
		copyright: "© 2026 Acme Inc",
		description: "The Shop API's client",
		documentation: "https://docs.acme.dev",
		homepage: "https://acme.dev",
		icon: "assets/icon.png",
		keywords: ["shop", "api-client"],
		license: "MIT OR Apache-2.0",
		licenseFile: "LICENSE",
		readme: "README.md",
		repository: "https://github.com/acme/shop",
	} as const

	it("names every field a block can hold, and accepts a block with each one set", () => {
		expect([...METADATA_FIELDS].sort()).toEqual(Object.keys(full).sort())
		expect(checkedMetadata(full)).toEqual(full)
		expect(checkedMetadata({})).toEqual({})
	})

	it.each<[string, unknown, string]>([
		["description", "two\nlines", 'Invalid metadata.description: "two\\nlines"'],
		["homepage", "http://acme.dev", 'Invalid metadata.homepage: "http://acme.dev"'],
		["repository", "github.com/acme/shop", 'Invalid metadata.repository: "github.com/acme/shop"'],
		["documentation", "https://", 'Invalid metadata.documentation: "https://"'],
		["changelog", "ftp://acme.dev", 'Invalid metadata.changelog: "ftp://acme.dev"'],
		["license", "MIT or Apache-2.0", 'Invalid metadata.license: "MIT or Apache-2.0"'],
		["copyright", "", 'Invalid metadata.copyright: ""'],
		["authors", ["Ada <ada>"], 'Invalid metadata.authors: "Ada <ada>"'],
		["authors", ["Doe, Jo"], 'Invalid metadata.authors: "Doe, Jo"'],
		["authors", "Ada", 'Invalid metadata.authors: "Ada"'],
		["authors", [], "Invalid metadata.authors: []"],
		["keywords", ["api client"], 'Invalid metadata.keywords: "api client"'],
		["keywords", ["a,b"], 'Invalid metadata.keywords: "a,b"'],
		["keywords", [7], "Invalid metadata.keywords: 7"],
		["readme", 7, "Invalid metadata.readme: 7"],
	])("refuses %s = %j, naming metadata.<field> and the value", (field, value, message) => {
		expect(() => checkedMetadata({ [field]: value })).toThrow(message)
	})

	it("refuses a field it does not know, and a block that is not an object", () => {
		expect(() => checkedMetadata({ licence: "MIT" })).toThrow(
			`Invalid metadata: unknown field "licence", want one of ${METADATA_FIELDS.join(", ")}`,
		)
		for (const value of [null, "MIT", ["MIT"]])
			expect(() => checkedMetadata(value)).toThrow("Invalid metadata: want an object of fields")
	})

	it("reads an author's name with or without an email", () => {
		expect(["Acme Inc <oss@acme.dev>", "Bo"].map(authorName)).toEqual(["Acme Inc", "Bo"])
	})
})
