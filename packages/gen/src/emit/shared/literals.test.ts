import { describe, expect, it } from "vitest"
import { literalType, quoteKey } from "./literals.ts"

describe("literals: TypeScript text for JSON values", () => {
	it("writes a property key bare when it is an identifier, a string literal otherwise", () => {
		expect(["id", "_x", "$y", "a1", "2d", "x-y", "", "class", 'q"\n'].map(quoteKey)).toEqual([
			"id",
			"_x",
			"$y",
			"a1",
			'"2d"',
			'"x-y"',
			'""',
			"class",
			'"q\\"\\n"',
		])
	})

	it("writes a literal type for a value, widening what has none", () => {
		expect(
			["a\u2028", 1.5, -0, Number.NaN, Number.POSITIVE_INFINITY, true, null, undefined, 10n, [1], {}].map(literalType),
		).toEqual(['"a\\u2028"', "1.5", "0", "number", "number", "true", "null", "undefined", "10n", "unknown", "unknown"])
	})
})
