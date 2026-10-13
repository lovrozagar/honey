import { describe, expect, it } from "vitest"
import { scopeSpec } from "../../../src/codegen.ts"

function makeSpec(paths: Record<string, Record<string, Record<string, unknown>>>) {
	return {
		info: { title: "Test", version: "1.0" },
		openapi: "3.1.0" as const,
		paths,
	}
}

describe("scopeSpec", () => {
	it("filters by tags — includes matching", () => {
		const spec = makeSpec({
			"/admin": { get: { tags: ["admin"] } },
			"/users": { get: { tags: ["public"] } },
		})

		const scoped = scopeSpec(spec, { tags: ["public"] })
		expect(scoped.paths["/users"]).toBeDefined()
		expect(scoped.paths["/admin"]).toBeUndefined()
	})

	it("filters by tags — multiple tags", () => {
		const spec = makeSpec({
			"/billing": { get: { tags: ["billing"] } },
			"/internal": { get: { tags: ["internal"] } },
			"/users": { get: { tags: ["public"] } },
		})

		const scoped = scopeSpec(spec, { tags: ["public", "billing"] })
		expect(scoped.paths["/users"]).toBeDefined()
		expect(scoped.paths["/billing"]).toBeDefined()
		expect(scoped.paths["/internal"]).toBeUndefined()
	})

	it("filters by excludeTags", () => {
		const spec = makeSpec({
			"/admin": { get: { tags: ["admin"] } },
			"/public": { get: { tags: ["public"] } },
		})

		const scoped = scopeSpec(spec, { excludeTags: ["admin"] })
		expect(scoped.paths["/public"]).toBeDefined()
		expect(scoped.paths["/admin"]).toBeUndefined()
	})

	it("filters by pathPrefix", () => {
		const spec = makeSpec({
			"/api/v1/users": { get: { responses: {} } },
			"/api/v2/users": { get: { responses: {} } },
			"/health": { get: { responses: {} } },
		})

		const scoped = scopeSpec(spec, { pathPrefix: "/api/v1" })
		expect(scoped.paths["/api/v1/users"]).toBeDefined()
		expect(scoped.paths["/api/v2/users"]).toBeUndefined()
		expect(scoped.paths["/health"]).toBeUndefined()
	})

	it("filters by operationIds", () => {
		const spec = makeSpec({
			"/items": { get: { operationId: "items.list" } },
			"/users": { get: { operationId: "users.list" }, post: { operationId: "users.create" } },
		})

		const scoped = scopeSpec(spec, { operationIds: ["users.list"] })
		expect(scoped.paths["/users"]).toBeDefined()
		expect(scoped.paths["/users"].get).toBeDefined()
		expect(scoped.paths["/users"].post).toBeUndefined()
		expect(scoped.paths["/items"]).toBeUndefined()
	})

	it("preserves spec metadata", () => {
		const spec = makeSpec({ "/x": { get: { tags: ["ok"] } } })
		const scoped = scopeSpec(spec, { tags: ["ok"] })
		expect(scoped.openapi).toBe("3.1.0")
		expect(scoped.info.title).toBe("Test")
	})

	it("empty result when no matches", () => {
		const spec = makeSpec({ "/x": { get: { tags: ["nope"] } } })
		const scoped = scopeSpec(spec, { tags: ["missing"] })
		expect(Object.keys(scoped.paths)).toHaveLength(0)
	})

	it("no filter → returns all", () => {
		const spec = makeSpec({
			"/a": { get: { responses: {} } },
			"/b": { post: { responses: {} } },
		})
		const scoped = scopeSpec(spec, {})
		expect(Object.keys(scoped.paths)).toHaveLength(2)
	})

	it("filters methods within same path independently", () => {
		const spec = makeSpec({
			"/items": {
				get: { operationId: "items.list", tags: ["public"] },
				post: { operationId: "items.create", tags: ["admin"] },
			},
		})

		const scoped = scopeSpec(spec, { tags: ["public"] })
		expect(scoped.paths["/items"]).toBeDefined()
		expect(scoped.paths["/items"].get).toBeDefined()
		expect(scoped.paths["/items"].post).toBeUndefined()
	})
})
