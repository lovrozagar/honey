import { describe, expect, it } from "vitest"
import {
	findInvalidSelectors,
	findMissingInvalidate,
	type InvalidateCheckOperation,
	invalidateLevel,
	missingInvalidateReport,
} from "./invalidate-check.ts"

const op = (
	method: string,
	path: string,
	meta: Record<string, unknown> | null = null,
	operation: Record<string, unknown> = {},
): InvalidateCheckOperation => ({ meta, method, operation, path })

const read = op("get", "/users")
const mutation = (meta: Record<string, unknown> | null, operation: Record<string, unknown> = {}) =>
	op("post", "/users", meta, operation)

describe("invalidate check", () => {
	// v0: 718e625a18
	it("a profile without x-invalidate does not make a declared mutation look undeclared", () => {
		expect(findMissingInvalidate([read, mutation({ invalidate: ["GET /users"] })], undefined)).toEqual([])
	})

	// v0: f8a19b7d07
	// v0: 2548edacaa
	it("an entity with no tagged reader falls back to path shape instead of staying silent", () => {
		const findings = findMissingInvalidate([read, mutation(null, { "x-entity": "user" })], "x-entity")
		expect(findings).toEqual([{ affects: ["GET /users"], method: "POST", path: "/users" }])
		/* without an entity key, a reader of the same entity under an unrelated path is judged by path shape: none */
		const apart = [
			op("get", "/v2/tables", null, { "x-entity": "table" }),
			op("post", "/admin/provision", null, { "x-entity": "table" }),
		]
		expect([findMissingInvalidate(apart, undefined), findMissingInvalidate(apart, "x-entity")]).toEqual([
			[],
			[{ affects: ["GET /v2/tables"], method: "POST", path: "/admin/provision" }],
		])
	})
})

describe("findMissingInvalidate", () => {
	// v0: 1abaf35bc1
	// v0: 22c9c382db
	// v0: 44c49624af
	it("flags a mutation whose own path or collection is read", () => {
		const ops = [op("get", "/tables"), op("get", "/tables/{id}"), op("delete", "/tables/{id}")]
		expect(findMissingInvalidate(ops, undefined)).toEqual([
			{ affects: ["GET /tables/{id}", "GET /tables"], method: "DELETE", path: "/tables/{id}" },
		])
		/* only a GET reads: a POST and a PUT on one path are no read surface for each other */
		expect(findMissingInvalidate([op("post", "/tables"), op("put", "/tables")], undefined)).toEqual([])
	})

	// v0: 10bbf07a20
	// v0: f5ce95c90d
	// v0: ff592f6e95
	it("stays quiet for a mutation nothing reads, or one that recorded a decision", () => {
		expect(findMissingInvalidate([op("post", "/auth/logout"), op("get", "/auth")], undefined)).toEqual([])
		expect(findMissingInvalidate([read, mutation({ invalidate: null })], undefined)).toEqual([])
		expect(findMissingInvalidate([read, mutation({ invalidate: [] })], undefined)).toEqual([])
		expect(findMissingInvalidate([read, mutation({}, { "x-invalidate": ["GET /users"] })], undefined)).toEqual([])
		expect(findMissingInvalidate([read, op("head", "/users")], undefined)).toEqual([])
	})

	// v0: c741b6ba25
	it("prefers readers tagged with the same entity over path shape", () => {
		const ops = [
			op("get", "/people", null, { "x-entity": "user" }),
			op("get", "/people/{id}", null, { "x-entity": "user" }),
			op("get", "/orgs", null, { "x-entity": null }),
			op("put", "/users/{id}", null, { "x-entity": "user" }),
		]
		expect(findMissingInvalidate(ops, "x-entity")).toEqual([
			{ affects: ["GET /people", "GET /people/{id}"], method: "PUT", path: "/users/{id}" },
		])
	})

	// v0: 6f0d8cd267
	it("reads the collection of an item path only below the root", () => {
		expect(findMissingInvalidate([op("get", "/"), op("delete", "/{id}")], undefined)).toEqual([])
	})
})

describe("missingInvalidateReport", () => {
	// v0: 4b3e43fabb
	it("summarizes every finding in one report, capped at 20 lines", () => {
		const ops = Array.from({ length: 22 }, (_, i) => [op("get", `/t${i}`), op("post", `/t${i}`)]).flat()
		const report = missingInvalidateReport(ops, undefined) as string
		expect(report.startsWith("[honey:invalidate] 22 mutation(s) declare no `invalidate`")).toBe(true)
		expect(report).toContain("  POST /t0 → GET /t0")
		expect(report).not.toContain("/t20 ")
		expect(report).toContain("… and 2 more")
		expect(report.endsWith("or `invalidate: null` to record that it refreshes nothing.")).toBe(true)
	})

	it("aligns methods and lists every finding when there are few", () => {
		const report = missingInvalidateReport([op("get", "/a"), op("put", "/a"), op("delete", "/a")], "warn") as string
		expect(report).toContain("  PUT    /a → GET /a\n  DELETE /a → GET /a\n")
		expect(report).not.toContain("more")
	})

	// v0: d5407269d5
	it("has nothing to say when the check is off or finds nothing", () => {
		expect(missingInvalidateReport([read, mutation(null)], "off")).toBeNull()
		expect(missingInvalidateReport([read], { level: "error" })).toBeNull()
		expect(missingInvalidateReport([read, mutation(null)], { entityKey: "x-entity" })).not.toBeNull()
	})
})

describe("invalidateLevel and findInvalidSelectors", () => {
	it("defaults to warn and reads a level or a config object", () => {
		expect(invalidateLevel(undefined)).toBe("warn")
		expect(invalidateLevel("error")).toBe("error")
		expect(invalidateLevel({ entityKey: "x-entity" })).toBe("warn")
		expect(invalidateLevel({ level: "off" })).toBe("off")
	})

	it("lists each selector that names no route, once", () => {
		const routes = new Set(["GET /users"])
		const ops = [
			op("post", "/users", { invalidate: ["GET /users", "GET /userz", "GET /userz", 42] }),
			op("put", "/users", { invalidate: "GET /users" }),
			op("delete", "/users"),
		]
		expect(findInvalidSelectors(ops, routes)).toEqual([
			{ method: "POST", path: "/users", selector: "GET /userz" },
			{ method: "POST", path: "/users", selector: 42 },
		])
	})
})
