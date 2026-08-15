import { describe, expect, it } from "vitest"
import { generateSDK } from "../../../src/codegen.ts"

function makeSpec(paths: Record<string, Record<string, Record<string, unknown>>>) {
	return {
		info: { title: "Test", version: "1.0" },
		openapi: "3.1.0" as const,
		paths,
	}
}

describe("generateSDK", () => {
	it("generates serviceMap from operationId", () => {
		const spec = makeSpec({
			"/users": {
				get: { operationId: "users.list", responses: { "200": {} } },
			},
		})

		const result = generateSDK(spec)
		expect(result.serviceMap.users).toBeDefined()
		expect(result.serviceMap.users.list).toBeDefined()
		expect(result.serviceMap.users.list.method).toBe("GET")
		expect(result.serviceMap.users.list.path).toBe("/users")
	})

	it("handles multiple resources", () => {
		const spec = makeSpec({
			"/items": { get: { operationId: "items.list", responses: {} } },
			"/users": { get: { operationId: "users.list", responses: {} } },
		})

		const result = generateSDK(spec)
		expect(result.serviceMap.users).toBeDefined()
		expect(result.serviceMap.items).toBeDefined()
	})

	it("handles multiple actions per resource", () => {
		const spec = makeSpec({
			"/users": {
				get: { operationId: "users.list", responses: {} },
				post: { operationId: "users.create", responses: {} },
			},
			"/users/{id}": {
				delete: { operationId: "users.delete", responses: {} },
				get: { operationId: "users.get", responses: {} },
			},
		})

		const result = generateSDK(spec)
		expect(Object.keys(result.serviceMap.users)).toEqual(
			expect.arrayContaining(["list", "create", "get", "delete"]),
		)
		expect(result.serviceMap.users.get.path).toBe("/users/{id}")
		expect(result.serviceMap.users.delete.method).toBe("DELETE")
	})

	it("extracts path params", () => {
		const spec = makeSpec({
			"/orgs/{orgId}/projects/{projectId}": {
				get: { operationId: "projects.list", responses: {} },
			},
		})

		const result = generateSDK(spec)
		expect(result.serviceMap.projects.list.params).toEqual(["orgId", "projectId"])
	})

	it("skips routes without operationId", () => {
		const spec = makeSpec({
			"/health": { get: { responses: {} } },
			"/users": { get: { operationId: "users.list", responses: {} } },
		})

		const result = generateSDK(spec)
		expect(result.serviceMap.users).toBeDefined()
		/* health has no operationId → not in serviceMap */
		expect(result.serviceMap.health).toBeUndefined()
	})

	it("flat operationId (no dot) → flat method", () => {
		const spec = makeSpec({
			"/health": { get: { operationId: "health", responses: {} } },
		})

		const result = generateSDK(spec)
		expect(result.serviceMap.health).toBeDefined()
		expect(typeof result.serviceMap.health).toBe("object")
		/* flat operationId treated as resource with no nesting — stored under _call or similar */
	})

	it("throws on duplicate operationId", () => {
		const spec = makeSpec({
			"/a": { get: { operationId: "users.list", responses: {} } },
			"/b": { get: { operationId: "users.list", responses: {} } },
		})

		expect(() => generateSDK(spec)).toThrow("Duplicate operationId")
	})

	it("generates code string with serviceMap and SDK type", () => {
		const spec = makeSpec({
			"/users": {
				get: {
					operationId: "users.list",
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										items: { properties: { id: { type: "string" } }, type: "object" },
										type: "array",
									},
								},
							},
						},
					},
				},
			},
		})

		const result = generateSDK(spec)
		expect(result.files.map).toContain("serviceMap")
		expect(result.files.types).toContain("SDK")
		expect(result.files.map).toContain("users")
		expect(result.files.map).toContain("list")
	})

	it("empty spec → empty serviceMap", () => {
		const result = generateSDK(makeSpec({}))
		expect(Object.keys(result.serviceMap)).toHaveLength(0)
	})

	it("detects SSE routes from response content-type", () => {
		const spec = makeSpec({
			"/stream": {
				get: {
					operationId: "events.stream",
					responses: {
						"200": {
							content: { "text/event-stream": { schema: { type: "string" } } },
						},
					},
				},
			},
		})

		const result = generateSDK(spec)
		expect(result.serviceMap.events.stream.sse).toBe(true)
	})
})
