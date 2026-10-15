import { describe, expect, it } from "vitest"
import { InternPool } from "./route-tree-intern.ts"

/** A sealed pool that saw each value of `counted` once and forced each of `forced`. */
function pool(counted: readonly unknown[], forced: readonly [unknown, "M" | "P"][] = []): InternPool {
	const out = new InternPool()
	for (const value of counted) out.count(value)
	for (const [value, prefix] of forced) out.force(value, prefix)
	out.seal()
	return out
}

describe("InternPool: what is shared by name", () => {
	// v0: 3cfa28ffd0
	// v0: 66ec2e8636
	it("inlines what appears once and names an object that repeats, reusing its name inside parents", () => {
		const once = pool(["ok", { type: "boolean" }])
		expect([once.emitConstLines(), once.expr("ok"), once.expr({ type: "boolean" })]).toEqual([
			[],
			'"ok"',
			'{"type":"boolean"}',
		])
		const shared = pool([{ properties: { a: { type: "string" } } }, { properties: { b: { type: "string" } } }])
		expect([shared.expr({ type: "string" }), shared.expr({ properties: { a: { type: "string" } } })]).toEqual([
			"J0",
			'{"properties":{"a":J0}}',
		])
		expect(shared.emitConstLines()).toEqual(['const J0 = {"type":"string"}'])
	})

	// v0: af5b38df5e
	it("names a repeated long string and number, declared before the objects holding them", () => {
		const value = { maximum: 9007199254740991, pattern: "internal_server_error" }
		expect(pool([value, { ...value }]).emitConstLines()).toEqual([
			"const U0 = 9007199254740991",
			'const T0 = "internal_server_error"',
			'const J0 = {"maximum":U0,"pattern":T0}',
		])
	})

	// v0: f86b0a7ba5
	// v0: 71c9af1e70
	it("names a forced value even when unique, by its prefix, once however often it is sealed", () => {
		const meta = { auth: "required" }
		const forced = pool(
			[meta],
			[
				[meta, "M"],
				["GET /orgs", "P"],
				["GET /orgs", "M"],
			],
		)
		forced.seal()
		expect([forced.expr(meta), forced.expr("GET /orgs"), forced.id(meta), forced.id(undefined)]).toEqual([
			"M0",
			"P0",
			"M0",
			undefined,
		])
		expect(forced.emitConstLines()).toEqual(['const P0 = "GET /orgs"', 'const M0 = {"auth":"required"}'])
	})
})

describe("InternPool: what is never shared", () => {
	// v0: dd922d3f48
	// v0: 1e80af980a
	// v0: 58a178c621
	it("leaves empty arrays, unique arrays, booleans, null, undefined and short strings inline", () => {
		const skipped = pool(
			[[], [], ["email_taken"], true, null, undefined, "ab", "ab", 42, 42, Number.NaN],
			[
				[null, "M"],
				[undefined, "P"],
			],
		)
		expect(skipped.emitConstLines()).toEqual([])
		expect([[], ["email_taken"], null, undefined, true, false, 42].map((value) => skipped.expr(value))).toEqual([
			"[]",
			'["email_taken"]',
			"null",
			"undefined",
			"true",
			"false",
			"42",
		])
		expect(
			pool([
				["a_key", "b_key"],
				["a_key", "b_key"],
			]).expr(["a_key", "b_key"]),
		).toBe("A0")
	})

	// v0: facc53aa4f
	// v0: 8843143c7d
	it("prints an own __proto__ key as a computed key, and leaves an undefined key out", () => {
		const own = JSON.parse('{"__proto__":{"polluted":true},"a":1}') as Record<string, unknown>
		const [line] = pool([], [[own, "M"]]).emitConstLines()
		expect(line).toBe('const M0 = {["__proto__"]:{"polluted":true},"a":1}')
		const value = new Function(`${line}; return M0`)() as Record<string, unknown>
		expect([Object.getPrototypeOf(value), Object.keys(value)]).toEqual([Object.prototype, ["__proto__", "a"]])
		expect(pool([{ a: "long enough", b: undefined }]).emitConstLines()).toEqual([])
		expect(pool([], [[{ a: 1, b: undefined, c: [undefined] }, "M"]]).emitConstLines()).toEqual([
			'const M0 = {"a":1,"c":[undefined]}',
		])
	})
})
