import { describe, expect, it } from "vitest"
import { compareCodeUnits, pascalWords, words } from "./lang.ts"

describe("lang: words and their order", () => {
	it("splits any identifier-ish text into words, and joins them PascalCase keeping inner case", () => {
		expect([words("user-id"), words("userId"), words("HTTPServer2Go"), words("__a__b"), words("")]).toEqual([
			["user", "id"],
			["user", "Id"],
			["HTTP", "Server2", "Go"],
			["a", "b"],
			[],
		])
		expect(["user-id", "getHTTP", "x.y_z", "/"].map(pascalWords)).toEqual(["UserId", "GetHTTP", "XYZ", ""])
	})

	it("orders by code unit: upper case before lower, never by locale", () => {
		expect(["b", "B", "a", "_", "é"].sort(compareCodeUnits)).toEqual(["B", "_", "a", "b", "é"])
		expect([compareCodeUnits("x", "x"), compareCodeUnits("a", "b"), compareCodeUnits("b", "a")]).toEqual([0, -1, 1])
	})
})
