/**
 * The package metadata grammars every target shares: what each accepts and refuses, the refusal naming the option and
 * the value, and a `Name <email>` split at its last ` <`.
 */
import { describe, expect, it } from "vitest"
import { checked, HTTPS_URL, PERSON, personOf, SPDX_EXPRESSION, SPDX_ID, TEXT } from "./metadata.ts"

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
