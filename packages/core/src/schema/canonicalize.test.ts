import { describe, expect, it } from "vitest"
import { canonicalizeSchema, compareCodeUnits } from "./canonicalize.ts"

describe("compareCodeUnits: the same order on every machine", () => {
	it("orders by UTF-16 code unit, never by locale: upper case first, accents after z", () => {
		const words = ["é", "b", "B", "a", "Z", "_", "aa"]
		expect([...words].sort(compareCodeUnits)).toEqual(["B", "Z", "_", "a", "aa", "b", "é"])
		expect([compareCodeUnits("x", "x"), compareCodeUnits("a", "b"), compareCodeUnits("b", "a")]).toEqual([0, -1, 1])
	})
})

describe("canonicalizeSchema: one text per schema, whatever its key order", () => {
	it("sorts every object's keys at every depth and keeps array order", () => {
		const a = { type: "object", properties: { b: { type: "string" }, a: { enum: ["z", "y"] } }, required: ["b", "a"] }
		const b = { required: ["b", "a"], properties: { a: { enum: ["z", "y"] }, b: { type: "string" } }, type: "object" }
		expect(canonicalizeSchema(a)).toBe(canonicalizeSchema(b))
		expect(canonicalizeSchema(a)).toBe(
			'{"properties":{"a":{"enum":["z","y"]},"b":{"type":"string"}},"required":["b","a"],"type":"object"}',
		)
	})

	it("keeps a property named __proto__ as a property, polluting nothing", () => {
		const schema = JSON.parse('{"properties":{"__proto__":{"type":"string"}},"type":"object"}') as Record<
			string,
			unknown
		>
		expect(canonicalizeSchema(schema)).toBe('{"properties":{"__proto__":{"type":"string"}},"type":"object"}')
		expect(({} as Record<string, unknown>).type).toBeUndefined()
	})
})
