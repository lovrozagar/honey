import { describe, expect, it } from "vitest"
import { mergeSpecs } from "../../../src/codegen.ts"

function makeSpec(
	paths: Record<string, Record<string, Record<string, unknown>>>,
	info?: { title: string; version: string },
) {
	return {
		info: info ?? { title: "Test", version: "1.0" },
		openapi: "3.1.0",
		paths,
	}
}

describe("mergeSpecs", () => {
	it("merges two specs with non-overlapping paths", () => {
		const a = makeSpec({ "/users": { get: { responses: {} } } })
		const b = makeSpec({ "/items": { get: { responses: {} } } })

		const merged = mergeSpecs(a, b)
		expect(merged.paths["/users"]).toBeDefined()
		expect(merged.paths["/items"]).toBeDefined()
	})

	it("merges different methods on same path", () => {
		const a = makeSpec({ "/users": { get: { responses: {} } } })
		const b = makeSpec({ "/users": { post: { responses: {} } } })

		const merged = mergeSpecs(a, b)
		expect(merged.paths["/users"].get).toBeDefined()
		expect(merged.paths["/users"].post).toBeDefined()
	})

	it("throws on duplicate path + method", () => {
		const a = makeSpec({ "/users": { get: { responses: {} } } })
		const b = makeSpec({ "/users": { get: { responses: {} } } })

		expect(() => mergeSpecs(a, b)).toThrow()
	})

	it("preserves info from first spec", () => {
		const a = makeSpec({}, { title: "First", version: "1.0" })
		const b = makeSpec({}, { title: "Second", version: "2.0" })

		const merged = mergeSpecs(a, b)
		expect(merged.info.title).toBe("First")
	})

	it("preserves openapi version", () => {
		const merged = mergeSpecs(makeSpec({}), makeSpec({}))
		expect(merged.openapi).toBe("3.1.0")
	})

	it("merges three specs", () => {
		const a = makeSpec({ "/a": { get: { responses: {} } } })
		const b = makeSpec({ "/b": { get: { responses: {} } } })
		const c = makeSpec({ "/c": { post: { responses: {} } } })

		const merged = mergeSpecs(a, b, c)
		expect(Object.keys(merged.paths)).toHaveLength(3)
	})

	it("single spec → returns copy", () => {
		const a = makeSpec({ "/x": { get: { responses: {} } } })
		const merged = mergeSpecs(a)
		expect(merged.paths["/x"]).toBeDefined()
		expect(merged).not.toBe(a)
	})

	it("empty specs → empty paths", () => {
		const merged = mergeSpecs(makeSpec({}), makeSpec({}))
		expect(Object.keys(merged.paths)).toHaveLength(0)
	})
})
