import { describe, expect, it } from "vitest"
import {
	DEFAULT_ERROR_JSON_SCHEMA,
	deduplicateSchemas,
	generateSDK,
	isStandardErrEnvelope,
	jsonSchemaToTS,
	mergeSpecs,
	resolveRefs,
	scopeSpec,
} from "../../../src/codegen.ts"

/* The standard envelope as produced by generateOpenApi for a single not_found error at 404.
   Differs from DEFAULT_ERROR_JSON_SCHEMA: status and error_key are patched with enums. */
const PATCHED_404_ENVELOPE = {
	properties: {
		error_key: { enum: ["not_found"], type: "string" },
		fields: {
			additionalProperties: {
				items: {
					properties: {
						error_key: { type: "string" },
						message: { type: "string" },
						path: { type: "string" },
					},
					required: ["error_key", "message", "path"],
					type: "object",
				},
				type: "array",
			},
			type: "object",
		},
		message: { type: "string" },
		status: { enum: [404], type: "integer" },
		status_key: { type: "string" },
		success: { const: false },
	},
	required: ["error_key", "fields", "message", "status", "status_key", "success"],
	type: "object",
}

type SpecInput = {
	components?: {
		schemas?: Record<string, Record<string, unknown>>
		securitySchemes?: Record<string, unknown>
	}
	info: { title: string; version: string }
	openapi: string
	paths: Record<string, Record<string, Record<string, unknown>>>
}

function makeSpec(
	paths: Record<string, Record<string, Record<string, unknown>>>,
	components?: {
		schemas?: Record<string, Record<string, unknown>>
		securitySchemes?: Record<string, unknown>
	},
): SpecInput {
	const spec: SpecInput = {
		info: { title: "Test", version: "1.0" },
		openapi: "3.1.0",
		paths,
	}
	if (components) spec.components = components
	return spec
}

describe("characterization — current behavior", () => {
	it("generateSDK produces stable types for multi-endpoint spec with shared errors", () => {
		const errorSchema = structuredClone(PATCHED_404_ENVELOPE)
		const spec = makeSpec({
			"/items/{id}": {
				get: {
					operationId: "items.get",
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { id: { type: "string" }, title: { type: "string" } },
										required: ["id", "title"],
										type: "object",
									},
								},
							},
						},
						"404": {
							content: { "application/json": { schema: structuredClone(errorSchema) } },
						},
					},
				},
			},
			"/orgs/{id}": {
				get: {
					operationId: "orgs.get",
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { id: { type: "string" }, slug: { type: "string" } },
										required: ["id", "slug"],
										type: "object",
									},
								},
							},
						},
						"404": {
							content: { "application/json": { schema: structuredClone(errorSchema) } },
						},
					},
				},
			},
			"/users/{id}": {
				get: {
					operationId: "users.get",
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { id: { type: "string" }, name: { type: "string" } },
										required: ["id", "name"],
										type: "object",
									},
								},
							},
						},
						"404": {
							content: { "application/json": { schema: errorSchema } },
						},
					},
				},
			},
		})

		const result = generateSDK(spec)
		expect(result.files.types).toContain("users")
		expect(result.files.types).toContain("items")
		expect(result.files.types).toContain("orgs")
		/* snapshot locks the current shape — future refactor must preserve it */
		expect(result.files.types).toMatchSnapshot()
	})

	it("jsonSchemaToTS converts the patched error envelope correctly", () => {
		const ts = jsonSchemaToTS(PATCHED_404_ENVELOPE)
		/* must produce an object type string, not unknown */
		expect(ts).toContain("{")
		expect(ts).toContain("}")
		/* all required top-level keys appear */
		expect(ts).toContain("error_key")
		expect(ts).toContain("message")
		expect(ts).toContain("status")
		expect(ts).toContain("success")
		expect(ts).toContain("fields")
		expect(ts).toContain("status_key")
		/* snapshot preserves exact output for regression */
		expect(ts).toMatchSnapshot()
	})

	it("isStandardErrEnvelope returns null for DEFAULT_ERROR_JSON_SCHEMA (no enums patched)", () => {
		/* DEFAULT_ERROR_JSON_SCHEMA has no status.enum or error_key.enum — not a valid envelope */
		expect(isStandardErrEnvelope(DEFAULT_ERROR_JSON_SCHEMA)).toBeNull()
	})

	it("isStandardErrEnvelope detects the patched per-endpoint envelope", () => {
		const result = isStandardErrEnvelope(PATCHED_404_ENVELOPE)
		expect(result).not.toBeNull()
		expect(result?.status).toBe(404)
		expect(result?.keys).toEqual(["not_found"])
	})

	it("mergeSpecs preserves components.schemas", () => {
		const a = makeSpec(
			{ "/users": { get: { operationId: "users.list", responses: {} } } },
			{ schemas: { UserSchema: { properties: { id: { type: "string" } }, type: "object" } } },
		)
		const b = makeSpec(
			{ "/items": { get: { operationId: "items.list", responses: {} } } },
			{ schemas: { ItemSchema: { properties: { name: { type: "string" } }, type: "object" } } },
		)

		const merged = mergeSpecs(a, b)
		expect(merged.components?.schemas?.UserSchema).toBeDefined()
		expect(merged.components?.schemas?.ItemSchema).toBeDefined()
		expect(merged.paths["/users"]).toBeDefined()
		expect(merged.paths["/items"]).toBeDefined()
	})

	it("scopeSpec preserves all components.schemas", () => {
		const spec = makeSpec(
			{
				"/admin": { get: { operationId: "admin.get", responses: {}, tags: ["admin"] } },
				"/public": { get: { operationId: "public.get", responses: {}, tags: ["public"] } },
			},
			{ schemas: { ErrorSchema: { type: "object" } } },
		)

		const scoped = scopeSpec(spec, { tags: ["public"] })
		expect(scoped.components?.schemas?.ErrorSchema).toBeDefined()
		expect(scoped.paths["/public"]).toBeDefined()
		expect(scoped.paths["/admin"]).toBeUndefined()
	})
})

describe("deduplication behavior", () => {
	it("deduplicateSchemas extracts shared error envelopes with Err{status}* names", () => {
		/* Amendment 2: shared error envelopes → Tier 2 naming (Err404NotFound).
		 * Old behavior expected Schema_ names; new behavior emits human-readable names. */
		const errorSchema = structuredClone(PATCHED_404_ENVELOPE)
		const spec = makeSpec({
			"/a": {
				get: { responses: { "404": { content: { "application/json": { schema: structuredClone(errorSchema) } } } } },
			},
			"/b": {
				get: { responses: { "404": { content: { "application/json": { schema: structuredClone(errorSchema) } } } } },
			},
			"/c": {
				get: { responses: { "404": { content: { "application/json": { schema: structuredClone(errorSchema) } } } } },
			},
		})

		const result = deduplicateSchemas(spec as Parameters<typeof deduplicateSchemas>[0])
		expect(result.components?.schemas).toBeDefined()

		/* Tier 2: error envelope → Err404NotFound; hoisted fields child may also appear */
		const schemaNames = Object.keys(result.components?.schemas ?? {})
		expect(schemaNames).toContain("Err404NotFound")

		/* all 3 endpoints must $ref the envelope component */
		for (const path of ["/a", "/b", "/c"]) {
			const op = result.paths[path].get as Record<string, unknown>
			const responses = op.responses as Record<string, Record<string, unknown>>
			const content = responses["404"].content as Record<string, Record<string, unknown>>
			const schema = content["application/json"].schema as Record<string, unknown>
			expect(schema.$ref).toBe("#/components/schemas/Err404NotFound")
		}
	})

	it("deduplicateSchemas extracts all object schemas with operation-derived names (Tier 1)", () => {
		/* Amendment 2: ALL unique object schemas get Tier 1 operation-derived names.
		 * Old behavior: unique schemas stayed inline. New: every schema becomes a $ref. */
		const spec = makeSpec({
			"/a": {
				get: {
					responses: {
						"200": {
							content: { "application/json": { schema: { properties: { id: { type: "string" } }, type: "object" } } },
						},
					},
				},
			},
			"/b": {
				get: {
					responses: {
						"200": {
							content: { "application/json": { schema: { properties: { name: { type: "string" } }, type: "object" } } },
						},
					},
				},
			},
			"/c": {
				get: {
					responses: {
						"200": {
							content: { "application/json": { schema: { properties: { slug: { type: "string" } }, type: "object" } } },
						},
					},
				},
			},
		})

		const result = deduplicateSchemas(spec as Parameters<typeof deduplicateSchemas>[0])
		/* all 3 unique schemas get operation-derived names */
		const schemas = result.components?.schemas
		expect(schemas).toBeDefined()
		expect(Object.keys(schemas ?? {})).toHaveLength(3)

		/* each route's schema replaced with $ref */
		for (const path of ["/a", "/b", "/c"]) {
			const op = result.paths[path].get as Record<string, unknown>
			const responses = op.responses as Record<string, Record<string, unknown>>
			const content = responses["200"].content as Record<string, Record<string, unknown>>
			const schema = content["application/json"].schema as Record<string, unknown>
			expect(schema.$ref, `${path} schema should be a $ref`).toBeDefined()
		}
	})

	it("deduplicateSchemas uses deterministic content-hash names", () => {
		const errorSchema = structuredClone(PATCHED_404_ENVELOPE)
		const makeTestSpec = () =>
			makeSpec({
				"/a": {
					get: { responses: { "404": { content: { "application/json": { schema: structuredClone(errorSchema) } } } } },
				},
				"/b": {
					get: { responses: { "404": { content: { "application/json": { schema: structuredClone(errorSchema) } } } } },
				},
			})

		const result1 = deduplicateSchemas(makeTestSpec() as Parameters<typeof deduplicateSchemas>[0])
		const result2 = deduplicateSchemas(makeTestSpec() as Parameters<typeof deduplicateSchemas>[0])

		const keys1 = Object.keys(result1.components?.schemas ?? {})
		const keys2 = Object.keys(result2.components?.schemas ?? {})
		expect(keys1).toEqual(keys2)
	})

	it("deduplicateSchemas handles oneOf schemas — outer schema extracted, inner oneOf stays inline", () => {
		/* Amendment 2: outer schema is unique per route → Tier 1 name, becomes $ref.
		 * Nested oneOf members are not walked for hoisting (only `properties` fields are).
		 * So the $ref is at the top-level response, not inside the oneOf array. */
		const sharedSub = {
			properties: { code: { type: "string" }, msg: { type: "string" } },
			required: ["code", "msg"],
			type: "object",
		}
		const spec = makeSpec({
			"/a": {
				get: {
					responses: {
						"400": {
							content: {
								"application/json": {
									schema: {
										oneOf: [structuredClone(sharedSub), { properties: { x: { type: "number" } }, type: "object" }],
									},
								},
							},
						},
					},
				},
			},
			"/b": {
				get: {
					responses: {
						"400": {
							content: {
								"application/json": {
									schema: {
										oneOf: [structuredClone(sharedSub), { properties: { y: { type: "number" } }, type: "object" }],
									},
								},
							},
						},
					},
				},
			},
		})

		const result = deduplicateSchemas(spec as Parameters<typeof deduplicateSchemas>[0])
		expect(result.components?.schemas).toBeDefined()

		/* outer response schema extracted to named component → $ref at response level */
		for (const path of ["/a", "/b"]) {
			const op = result.paths[path].get as Record<string, unknown>
			const responses = op.responses as Record<string, Record<string, unknown>>
			const content = responses["400"].content as Record<string, Record<string, unknown>>
			const schema = content["application/json"].schema as Record<string, unknown>
			expect(schema.$ref, `${path} outer schema should be a $ref`).toBeDefined()
		}
	})

	it("deduplicateSchemas preserves existing components.securitySchemes", () => {
		const errorSchema = structuredClone(PATCHED_404_ENVELOPE)
		const spec = {
			components: { securitySchemes: { bearerAuth: { scheme: "bearer", type: "http" } } },
			info: { title: "Test", version: "1.0" },
			openapi: "3.1.0",
			paths: {
				"/a": {
					get: { responses: { "404": { content: { "application/json": { schema: structuredClone(errorSchema) } } } } },
				},
				"/b": {
					get: { responses: { "404": { content: { "application/json": { schema: structuredClone(errorSchema) } } } } },
				},
			},
		} as Parameters<typeof deduplicateSchemas>[0]

		const result = deduplicateSchemas(spec)
		expect(result.components?.securitySchemes).toBeDefined()
		expect(result.components?.securitySchemes?.bearerAuth).toBeDefined()
		expect(result.components?.schemas).toBeDefined()
	})

	it("deduplicateSchemas handles empty spec", () => {
		const spec = makeSpec({}) as Parameters<typeof deduplicateSchemas>[0]
		const result = deduplicateSchemas(spec)
		expect(Object.keys(result.paths)).toHaveLength(0)
	})

	it("resolveRefs expands $ref to inline", () => {
		const storedSchema = structuredClone(PATCHED_404_ENVELOPE)
		const spec = makeSpec(
			{
				"/a": {
					get: {
						responses: {
							"404": { content: { "application/json": { schema: { $ref: "#/components/schemas/Schema_abc" } } } },
						},
					},
				},
				"/b": {
					get: {
						responses: {
							"404": { content: { "application/json": { schema: { $ref: "#/components/schemas/Schema_abc" } } } },
						},
					},
				},
			},
			{ schemas: { Schema_abc: storedSchema } },
		)

		const result = resolveRefs(spec)

		/* $ref should be expanded */
		for (const path of ["/a", "/b"]) {
			const op = result.paths[path].get as Record<string, unknown>
			const responses = op.responses as Record<string, Record<string, unknown>>
			const content = responses["404"].content as Record<string, Record<string, unknown>>
			const schema = content["application/json"].schema as Record<string, unknown>
			expect(schema.$ref).toBeUndefined()
			expect(schema.type).toBe("object")
			expect((schema.properties as Record<string, unknown>).error_key).toBeDefined()
		}

		/* components.schemas should be stripped */
		expect(result.components?.schemas).toBeUndefined()
	})

	it("resolveRefs is no-op on spec without components", () => {
		const spec = makeSpec({
			"/a": { get: { responses: { "200": { content: { "application/json": { schema: { type: "string" } } } } } } },
		})

		const result = resolveRefs(spec)
		expect(result).toBe(spec)
	})

	it("generateSDK end-to-end produces valid types after dedup", () => {
		/* Amendment 2: dedup emits $refs for all schemas. generateSDK processes $refs differently
		 * from inline schemas (envelope detection uses shape, not ref name), so byte-identical
		 * output is not guaranteed. Assert structural completeness instead. */
		const errorSchema = structuredClone(PATCHED_404_ENVELOPE)
		const inlineSpec = makeSpec({
			"/items/{id}": {
				get: {
					operationId: "items.get",
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { id: { type: "string" }, title: { type: "string" } },
										required: ["id", "title"],
										type: "object",
									},
								},
							},
						},
						"404": { content: { "application/json": { schema: structuredClone(errorSchema) } } },
					},
				},
			},
			"/users/{id}": {
				get: {
					operationId: "users.get",
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { id: { type: "string" }, name: { type: "string" } },
										required: ["id", "name"],
										type: "object",
									},
								},
							},
						},
						"404": { content: { "application/json": { schema: structuredClone(errorSchema) } } },
					},
				},
			},
		})

		const deduped = deduplicateSchemas(inlineSpec as Parameters<typeof deduplicateSchemas>[0])
		expect(deduped.components?.schemas).toBeDefined()
		expect(deduped.components?.schemas?.["Err404NotFound"]).toBeDefined()

		const dedupedTypes = generateSDK(deduped).files.types
		expect(dedupedTypes).toContain("users")
		expect(dedupedTypes).toContain("items")
		expect(dedupedTypes).toContain("status")
		expect(dedupedTypes).toContain("error_key")
	})

	it("deduplicateSchemas handles schemas with different property order", () => {
		const schemaA = {
			properties: { age: { type: "number" }, name: { type: "string" } },
			required: ["name", "age"],
			type: "object",
		}
		/* intentionally unsorted keys to test canonicalization */
		const schemaB: Record<string, unknown> = {}
		schemaB.required = ["name", "age"]
		schemaB.type = "object"
		const propsB: Record<string, unknown> = {}
		propsB.name = { type: "string" }
		propsB.age = { type: "number" }
		schemaB.properties = propsB

		const spec = makeSpec({
			"/a": { get: { responses: { "200": { content: { "application/json": { schema: schemaA } } } } } },
			"/b": { get: { responses: { "200": { content: { "application/json": { schema: schemaB } } } } } },
		})

		const result = deduplicateSchemas(spec as Parameters<typeof deduplicateSchemas>[0])
		/* different key order but identical content → should collapse to 1 component */
		expect(result.components?.schemas).toBeDefined()
		expect(Object.keys(result.components?.schemas ?? {})).toHaveLength(1)
	})

	it("mergeSpecs throws on duplicate component schema names with different content", () => {
		const a = makeSpec(
			{ "/a": { get: { responses: {} } } },
			{ schemas: { Conflict: { properties: { id: { type: "string" } }, type: "object" } } },
		)
		const b = makeSpec(
			{ "/b": { get: { responses: {} } } },
			{ schemas: { Conflict: { properties: { name: { type: "string" } }, type: "object" } } },
		)

		expect(() => mergeSpecs(a, b)).toThrow("duplicate component schema")
	})

	it("mergeSpecs allows identical component schema names", () => {
		const schema = { properties: { id: { type: "string" } }, type: "object" }
		const a = makeSpec({ "/a": { get: { responses: {} } } }, { schemas: { Shared: structuredClone(schema) } })
		const b = makeSpec({ "/b": { get: { responses: {} } } }, { schemas: { Shared: structuredClone(schema) } })

		const merged = mergeSpecs(a, b)
		expect(merged.components?.schemas?.Shared).toBeDefined()
		expect(Object.keys(merged.components?.schemas ?? {})).toHaveLength(1)
	})
})
