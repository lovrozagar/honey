/**
 * A JSON value as a TypeScript literal (bit 18 phase b): evaluated back, it is the value; a hostile string closes no
 * literal; `__proto__` is the object's own property, never its prototype; a number with no literal is refused.
 */
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { literal } from "./literal.ts"

/** `text` evaluated as an expression in a fresh context. */
const evaluate = (text: string): unknown => runInNewContext(`(${text})`)

describe("a literal (phase b)", () => {
	it("evaluates back to the value: strings, numbers, booleans, null, nested arrays and objects, keys in order", () => {
		const value = { b: [1, -2.5, true, null], a: { "x-y": "q", ok: false }, empty: {}, none: [] }
		const text = literal(value)
		expect([JSON.stringify(evaluate(text)), Object.keys(evaluate(text) as object)]).toEqual([
			JSON.stringify(value),
			["b", "a", "empty", "none"],
		])
	})

	it("closes no literal on a hostile string: quotes, backticks, ${, */, a line break and its separators", () => {
		const evil = "a\"b'c`d${1}*/\n\u2028\u2029\\e"
		expect(evaluate(literal({ [evil]: [evil] }))).toEqual({ [evil]: [evil] })
	})

	it("writes __proto__ as the object's own property, never its prototype", () => {
		const text = literal(JSON.parse('{"__proto__": {"polluted": true}}') as unknown)
		/* checked inside the context the literal ran in: its own Object.prototype */
		const seen = runInNewContext(
			`(() => { const v = (${text}); return [Object.keys(v), Object.getPrototypeOf(v) === Object.prototype, v.polluted] })()`,
		)
		expect(JSON.parse(JSON.stringify(seen))).toEqual([["__proto__"], true, null])
	})

	it("refuses a number JSON cannot hold", () => {
		expect(
			[() => literal(Number.NaN), () => literal(Number.POSITIVE_INFINITY)].map((write) =>
				(() => {
					try {
						write()
						return "written"
					} catch (error) {
						return (error as Error).message
					}
				})(),
			),
		).toEqual(["no literal for NaN", "no literal for Infinity"])
	})
})
