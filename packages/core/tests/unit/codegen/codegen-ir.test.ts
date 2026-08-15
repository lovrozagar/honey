import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { schemaToIR, toIR } from "../../../src/codegen-ir.ts"

/* ---- helpers ---- */

function fixtureDir(lang: string): string {
	return fileURLToPath(new URL(`./fixtures/${lang}`, import.meta.url))
}

function loadFixture(lang: string, name: string): Record<string, unknown> {
	const p = join(fixtureDir(lang), name)
	return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>
}

function minimalSpec(overrides: Record<string, unknown> = {}): Parameters<typeof toIR>[0] {
	return {
		info: { title: "T", version: "1" },
		openapi: "3.0.0",
		paths: {},
		...overrides,
	} as Parameters<typeof toIR>[0]
}

function specWithOp(path: string, method: string, op: Record<string, unknown>): Parameters<typeof toIR>[0] {
	return minimalSpec({ paths: { [path]: { [method]: op } } })
}

/* ======================================================= */
describe("schemaToIR", () => {
	/* ---- scalars ---- */
	it("scalar string", () => {
		expect(schemaToIR({ type: "string" })).toEqual({ kind: "scalar", type: "string" })
	})

	it("scalar string with format", () => {
		expect(schemaToIR({ format: "uuid", type: "string" })).toEqual({
			format: "uuid",
			kind: "scalar",
			type: "string",
		})
	})

	it("scalar string format date-time", () => {
		expect(schemaToIR({ format: "date-time", type: "string" })).toEqual({
			format: "date-time",
			kind: "scalar",
			type: "string",
		})
	})

	it("scalar integer", () => {
		expect(schemaToIR({ type: "integer" })).toEqual({ kind: "scalar", type: "integer" })
	})

	it("scalar number", () => {
		expect(schemaToIR({ type: "number" })).toEqual({ kind: "scalar", type: "number" })
	})

	it("scalar boolean", () => {
		expect(schemaToIR({ type: "boolean" })).toEqual({ kind: "scalar", type: "boolean" })
	})

	it("explicit null leaf", () => {
		expect(schemaToIR({ type: "null" })).toEqual({ kind: "scalar", type: "null" })
	})

	/* ---- enums ---- */
	it("string enum", () => {
		expect(schemaToIR({ enum: ["a", "b"], type: "string" })).toEqual({
			enum: ["a", "b"],
			kind: "scalar",
			type: "string",
		})
	})

	it("integer enum", () => {
		expect(schemaToIR({ enum: [1, 2, 3], type: "integer" })).toEqual({
			enum: [1, 2, 3],
			kind: "scalar",
			type: "integer",
		})
	})

	it("enum without type, all strings", () => {
		expect(schemaToIR({ enum: ["x", "y"] })).toEqual({
			enum: ["x", "y"],
			kind: "scalar",
			type: "string",
		})
	})

	it("enum without type, all ints", () => {
		expect(schemaToIR({ enum: [1, 2] })).toEqual({
			enum: [1, 2],
			kind: "scalar",
			type: "integer",
		})
	})

	/* ---- const ---- */
	it("const string", () => {
		expect(schemaToIR({ const: "dog" })).toEqual({ kind: "const", value: "dog" })
	})

	it("const boolean false", () => {
		expect(schemaToIR({ const: false })).toEqual({ kind: "const", value: false })
	})

	it("const integer", () => {
		expect(schemaToIR({ const: 42 })).toEqual({ kind: "const", value: 42 })
	})

	it("const with explicit type", () => {
		expect(schemaToIR({ const: "x", type: "string" })).toEqual({ kind: "const", value: "x" })
	})

	/* ---- object ---- */
	it("empty object", () => {
		expect(schemaToIR({ type: "object" })).toEqual({ fields: [], kind: "object" })
	})

	it("object with required field", () => {
		const result = schemaToIR({
			properties: { n: { type: "integer" } },
			required: ["n"],
			type: "object",
		})
		expect(result).toEqual({
			fields: [{ name: "n", required: true, schema: { kind: "scalar", type: "integer" } }],
			kind: "object",
		})
	})

	it("object optional field", () => {
		const result = schemaToIR({
			properties: { x: { type: "string" } },
			type: "object",
		})
		expect(result).toMatchObject({
			fields: [expect.objectContaining({ name: "x", required: false })],
			kind: "object",
		})
	})

	it("object with additionalProperties: true", () => {
		expect(schemaToIR({ additionalProperties: true, type: "object" })).toEqual({
			additional: { kind: "unknown" },
			fields: [],
			kind: "object",
		})
	})

	it("object with additionalProperties: false", () => {
		expect(schemaToIR({ additionalProperties: false, type: "object" })).toEqual({
			additional: false,
			fields: [],
			kind: "object",
		})
	})

	it("object with additionalProperties: schema", () => {
		expect(schemaToIR({ additionalProperties: { type: "string" }, type: "object" })).toEqual({
			additional: { kind: "scalar", type: "string" },
			fields: [],
			kind: "object",
		})
	})

	it("object + props + additionalProperties", () => {
		const result = schemaToIR({
			additionalProperties: { type: "string" },
			properties: { id: { type: "integer" } },
			required: ["id"],
			type: "object",
		})
		expect(result).toEqual({
			additional: { kind: "scalar", type: "string" },
			fields: [{ name: "id", required: true, schema: { kind: "scalar", type: "integer" } }],
			kind: "object",
		})
	})

	it("object preserves non-identifier key", () => {
		const result = schemaToIR({
			properties: { "weird-key": { type: "string" } },
			type: "object",
		})
		expect(result).toMatchObject({
			fields: [expect.objectContaining({ name: "weird-key" })],
			kind: "object",
		})
	})

	it("object preserves spec-iteration order", () => {
		/* intentionally out of alphabetical order to verify insertion order preserved */
		const result = schemaToIR({
			/* oxlint-disable-next-line sort-keys */
			properties: { z: { type: "string" }, a: { type: "integer" }, m: { type: "boolean" } },
			type: "object",
		}) as Extract<ReturnType<typeof schemaToIR>, { kind: "object" }>
		expect(result.fields.map((f) => f.name)).toEqual(["z", "a", "m"])
	})

	/* ---- array / tuple ---- */
	it("array of scalar", () => {
		expect(schemaToIR({ items: { type: "number" }, type: "array" })).toEqual({
			items: { kind: "scalar", type: "number" },
			kind: "array",
		})
	})

	it("array of refs", () => {
		expect(schemaToIR({ items: { $ref: "#/components/schemas/Foo" }, type: "array" })).toEqual({
			items: { kind: "ref", name: "Foo" },
			kind: "array",
		})
	})

	it("tuple", () => {
		expect(schemaToIR({ items: [{ type: "string" }, { type: "integer" }], type: "array" })).toEqual({
			items: [
				{ kind: "scalar", type: "string" },
				{ kind: "scalar", type: "integer" },
			],
			kind: "tuple",
		})
	})

	/* ---- nullable ---- */
	it("nullable: true", () => {
		expect(schemaToIR({ nullable: true, type: "string" })).toEqual({
			inner: { kind: "scalar", type: "string" },
			kind: "nullable",
		})
	})

	it("type: [X, null]", () => {
		expect(schemaToIR({ type: ["string", "null"] })).toEqual({
			inner: { kind: "scalar", type: "string" },
			kind: "nullable",
		})
	})

	it("anyOf with null variant, single non-null", () => {
		expect(schemaToIR({ anyOf: [{ type: "string" }, { type: "null" }] })).toEqual({
			inner: { kind: "scalar", type: "string" },
			kind: "nullable",
		})
	})

	it("anyOf with null variant, multiple non-null", () => {
		const result = schemaToIR({
			anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }],
		})
		expect(result).toEqual({
			inner: {
				kind: "union",
				variants: [
					{ kind: "scalar", type: "string" },
					{ kind: "scalar", type: "integer" },
				],
			},
			kind: "nullable",
		})
	})

	it("nested nullable is idempotent", () => {
		const result = schemaToIR({
			anyOf: [{ type: "string" }, { type: "null" }],
			nullable: true,
		})
		expect(result.kind).toBe("nullable")
		if (result.kind === "nullable") {
			expect(result.inner.kind).not.toBe("nullable")
		}
	})

	/* ---- union ---- */
	it("oneOf without discriminator", () => {
		expect(schemaToIR({ oneOf: [{ type: "string" }, { type: "integer" }] })).toEqual({
			kind: "union",
			variants: [
				{ kind: "scalar", type: "string" },
				{ kind: "scalar", type: "integer" },
			],
		})
	})

	it("oneOf with discriminator", () => {
		const result = schemaToIR({
			discriminator: {
				mapping: {
					cat: "#/components/schemas/Cat",
					dog: "#/components/schemas/Dog",
				},
				propertyName: "kind",
			},
			oneOf: [{ $ref: "#/components/schemas/Dog" }, { $ref: "#/components/schemas/Cat" }],
		})
		expect(result).toEqual({
			discriminator: {
				mapping: { cat: "Cat", dog: "Dog" },
				propertyName: "kind",
			},
			kind: "union",
			variants: [
				{ kind: "ref", name: "Dog" },
				{ kind: "ref", name: "Cat" },
			],
		})
	})

	it("anyOf without null variant", () => {
		expect(schemaToIR({ anyOf: [{ type: "string" }, { type: "integer" }] })).toEqual({
			kind: "union",
			variants: [
				{ kind: "scalar", type: "string" },
				{ kind: "scalar", type: "integer" },
			],
		})
	})

	/* ---- allOf ---- */
	it("allOf with $refs only", () => {
		expect(
			schemaToIR({
				allOf: [{ $ref: "#/components/schemas/A" }, { $ref: "#/components/schemas/B" }],
			}),
		).toEqual({
			kind: "allOf",
			parts: [
				{ kind: "ref", name: "A" },
				{ kind: "ref", name: "B" },
			],
		})
	})

	it("allOf with inline object parts", () => {
		const result = schemaToIR({
			allOf: [
				{ properties: { a: { type: "string" } }, type: "object" },
				{ properties: { b: { type: "integer" } }, type: "object" },
			],
		})
		expect(result.kind).toBe("allOf")
		if (result.kind === "allOf") {
			expect(result.parts).toHaveLength(2)
			expect(result.parts[0].kind).toBe("object")
			expect(result.parts[1].kind).toBe("object")
		}
	})

	it("allOf mixed ref + inline preserves order", () => {
		const result = schemaToIR({
			allOf: [{ $ref: "#/components/schemas/Base" }, { properties: { extra: { type: "string" } }, type: "object" }],
		})
		expect(result.kind).toBe("allOf")
		if (result.kind === "allOf") {
			expect(result.parts[0]).toEqual({ kind: "ref", name: "Base" })
			expect(result.parts[1].kind).toBe("object")
		}
	})

	/* ---- ref ---- */
	it("$ref to component", () => {
		expect(schemaToIR({ $ref: "#/components/schemas/Foo" })).toEqual({
			kind: "ref",
			name: "Foo",
		})
	})

	it("$ref deep path extracts last segment", () => {
		expect(schemaToIR({ $ref: "#/components/schemas/nested/Deep" })).toEqual({
			kind: "ref",
			name: "Deep",
		})
	})

	it("recursive ref terminates", () => {
		const result = schemaToIR({ $ref: "#/components/schemas/Tree" })
		expect(result).toEqual({ kind: "ref", name: "Tree" })
	})

	/* ---- binary & unknown ---- */
	it("binary format", () => {
		expect(schemaToIR({ format: "binary", type: "string" })).toEqual({ kind: "binary" })
	})

	it("empty schema", () => {
		expect(schemaToIR({})).toEqual({ kind: "unknown" })
	})

	it("unsupported type", () => {
		expect(schemaToIR({ type: "xyz" })).toEqual({ kind: "unknown" })
	})

	it("undefined input", () => {
		expect(schemaToIR(undefined)).toEqual({ kind: "unknown" })
	})
})

/* ======================================================= */
describe("toIR", () => {
	/* ---- path params ---- */
	it("path params back-filled from template when not declared", () => {
		const spec = specWithOp("/users/{id}", "get", { operationId: "getUser", responses: {} })
		const ir = toIR(spec)
		const op = ir.operations[0]
		expect(op.params.path).toEqual([{ name: "id", schema: { kind: "scalar", type: "string" } }])
	})

	it("path params use declared schema when present", () => {
		const spec = specWithOp("/users/{id}", "get", {
			operationId: "getUser",
			parameters: [{ in: "path", name: "id", schema: { type: "integer" } }],
			responses: {},
		})
		const ir = toIR(spec)
		const op = ir.operations[0]
		expect(op.params.path[0].schema).toEqual({ kind: "scalar", type: "integer" })
	})

	it("query params bucketed correctly", () => {
		const spec = specWithOp("/search", "get", {
			operationId: "search",
			parameters: [{ in: "query", name: "q", schema: { type: "string" } }],
			responses: {},
		})
		const ir = toIR(spec)
		expect(ir.operations[0].params.query).toHaveLength(1)
		expect(ir.operations[0].params.query[0].name).toBe("q")
	})

	it("header params bucketed correctly", () => {
		const spec = specWithOp("/items", "get", {
			operationId: "listItems",
			parameters: [{ in: "header", name: "X-Api-Key", schema: { type: "string" } }],
			responses: {},
		})
		const ir = toIR(spec)
		expect(ir.operations[0].params.header[0].name).toBe("X-Api-Key")
	})

	it("cookie params are ignored", () => {
		const spec = specWithOp("/items", "get", {
			operationId: "listItems",
			parameters: [{ in: "cookie", name: "session", schema: { type: "string" } }],
			responses: {},
		})
		const ir = toIR(spec)
		const op = ir.operations[0]
		expect(op.params.header).toHaveLength(0)
		expect(op.params.path).toHaveLength(0)
		expect(op.params.query).toHaveLength(0)
	})

	/* ---- body ---- */
	it("body JSON → kind raw", () => {
		const spec = specWithOp("/items", "post", {
			operationId: "createItem",
			requestBody: {
				content: { "application/json": { schema: { type: "object" } } },
				required: true,
			},
			responses: {},
		})
		const ir = toIR(spec)
		expect(ir.operations[0].body).toMatchObject({
			contentType: "application/json",
			kind: "raw",
			required: true,
			schema: { kind: "object" },
		})
	})

	it("body form-url-encoded → kind raw", () => {
		const spec = specWithOp("/submit", "post", {
			operationId: "submit",
			requestBody: {
				content: { "application/x-www-form-urlencoded": { schema: { type: "object" } } },
			},
			responses: {},
		})
		const ir = toIR(spec)
		const body = ir.operations[0].body
		expect(body?.kind).toBe("raw")
		expect(body?.contentType).toBe("application/x-www-form-urlencoded")
	})

	it("body multipart text-only → kind raw", () => {
		/* bare {type:"object"} has no binary properties → stays raw, not stream-multipart */
		const spec = specWithOp("/upload", "post", {
			operationId: "upload",
			requestBody: {
				content: { "multipart/form-data": { schema: { type: "object" } } },
			},
			responses: {},
		})
		const ir = toIR(spec)
		const body = ir.operations[0].body
		expect(body?.kind).toBe("raw")
		expect(body?.contentType).toBe("multipart/form-data")
	})

	it("body multipart with binary part → kind multipart", () => {
		const spec = specWithOp("/upload", "post", {
			operationId: "upload",
			requestBody: {
				content: {
					"multipart/form-data": {
						schema: {
							properties: { file: { format: "binary", type: "string" } },
							type: "object",
						},
					},
				},
			},
			responses: {},
		})
		const ir = toIR(spec)
		const body = ir.operations[0].body
		expect(body).toMatchObject({
			contentType: "multipart/form-data",
			kind: "multipart",
			required: false,
		})
		if (body?.kind === "multipart") {
			expect(body.parts).toEqual([{ name: "file", schema: { kind: "binary" }, type: "file" }])
		}
	})

	it("body multipart with array-of-binary part → kind multipart", () => {
		const spec = specWithOp("/upload", "post", {
			operationId: "uploadMany",
			requestBody: {
				content: {
					"multipart/form-data": {
						schema: {
							properties: {
								files: {
									items: { format: "binary", type: "string" },
									type: "array",
								},
							},
							type: "object",
						},
					},
				},
			},
			responses: {},
		})
		const ir = toIR(spec)
		const body = ir.operations[0].body
		expect(body?.kind).toBe("multipart")
		if (body?.kind === "multipart") {
			expect(body.parts[0]).toMatchObject({ name: "files", type: "file" })
		}
	})

	it("body octet-stream → kind stream", () => {
		const spec = specWithOp("/file", "post", {
			operationId: "uploadFile",
			requestBody: {
				content: {
					"application/octet-stream": { schema: { format: "binary", type: "string" } },
				},
				required: true,
			},
			responses: {},
		})
		const ir = toIR(spec)
		expect(ir.operations[0].body).toEqual({
			contentType: "application/octet-stream",
			kind: "stream",
			required: true,
		})
	})

	it("body required defaults false (raw)", () => {
		const spec = specWithOp("/items", "post", {
			operationId: "createItem",
			requestBody: { content: { "application/json": { schema: { type: "object" } } } },
			responses: {},
		})
		const ir = toIR(spec)
		expect(ir.operations[0].body?.required).toBe(false)
	})

	it("body absent", () => {
		const spec = specWithOp("/items", "get", { operationId: "listItems", responses: {} })
		const ir = toIR(spec)
		expect(ir.operations[0].body).toBeUndefined()
	})

	/* ---- responses ---- */
	it("responses preserve status keys as strings", () => {
		const spec = specWithOp("/items", "get", {
			operationId: "listItems",
			responses: {
				"200": { content: { "application/json": { schema: { items: { type: "string" }, type: "array" } } } },
				"204": {},
				"400": { content: { "application/json": { schema: { type: "object" } } } },
				default: { content: { "application/json": { schema: { type: "object" } } } },
			},
		})
		const ir = toIR(spec)
		const keys = Object.keys(ir.operations[0].responses)
		expect(keys).toContain("200")
		expect(keys).toContain("204")
		expect(keys).toContain("400")
		expect(keys).toContain("default")
	})

	it("response 204 has no schema or contentType", () => {
		const spec = specWithOp("/items/{id}", "delete", {
			operationId: "deleteItem",
			responses: { "204": {} },
		})
		const ir = toIR(spec)
		const resp = ir.operations[0].responses["204"]
		expect(resp.contentType).toBeUndefined()
		expect(resp.schema).toBeUndefined()
	})

	it("response JSON schema extracted", () => {
		const spec = specWithOp("/items", "get", {
			operationId: "listItems",
			responses: {
				"200": { content: { "application/json": { schema: { type: "string" } } } },
			},
		})
		const ir = toIR(spec)
		expect(ir.operations[0].responses["200"].schema).toEqual({ kind: "scalar", type: "string" })
	})

	it("response SSE detected", () => {
		const spec = specWithOp("/events", "get", {
			operationId: "streamEvents",
			responses: {
				"200": { content: { "text/event-stream": { schema: { type: "string" } } } },
			},
		})
		const ir = toIR(spec)
		expect(ir.operations[0].extensions.sse).toBe(true)
	})

	/* ---- extensions ---- */
	it("x-websocket extension", () => {
		const spec = specWithOp("/ws", "get", {
			operationId: "wsConnect",
			responses: {},
			"x-websocket": true,
		})
		const ir = toIR(spec)
		expect(ir.operations[0].extensions.websocket).toBe(true)
	})

	it("x-realtime extension", () => {
		const spec = specWithOp("/rt", "get", {
			operationId: "rtConnect",
			responses: {},
			"x-realtime": true,
		})
		const ir = toIR(spec)
		expect(ir.operations[0].extensions.realtime).toBe(true)
	})

	it("x-invalidate parses array", () => {
		const spec = specWithOp("/items", "post", {
			operationId: "createItem",
			responses: {},
			"x-invalidate": ["GET /items", "/other"],
		})
		const ir = toIR(spec)
		expect(ir.operations[0].extensions.invalidates).toEqual(["GET /items", "/other"])
	})

	it("x-deprecated extension", () => {
		const spec = specWithOp("/old", "get", {
			operationId: "oldEndpoint",
			responses: {},
			"x-deprecated": true,
		})
		const ir = toIR(spec)
		expect(ir.operations[0].extensions.deprecated).toBe(true)
	})

	it("x-idempotency-key extension", () => {
		const spec = specWithOp("/items", "post", {
			operationId: "createItem",
			responses: {},
			"x-idempotency-key": true,
		})
		const ir = toIR(spec)
		expect(ir.operations[0].extensions.idempotencyKey).toBe(true)
	})

	it("x-idempotency-key absent → idempotencyKey undefined", () => {
		const spec = specWithOp("/items", "post", {
			operationId: "createItem",
			responses: {},
		})
		const ir = toIR(spec)
		expect(ir.operations[0].extensions.idempotencyKey).toBeUndefined()
	})

	it("x-idempotency-key non-true values ignored (false / string / object)", () => {
		for (const value of [false, "yes", {}, 1]) {
			const spec = specWithOp("/items", "post", {
				operationId: "createItem",
				responses: {},
				"x-idempotency-key": value,
			})
			const ir = toIR(spec)
			expect(ir.operations[0].extensions.idempotencyKey).toBeUndefined()
		}
	})

	/* T1.1 — x-mcp extension */
	it("T1.1 x-mcp extension", () => {
		const spec = specWithOp("/items", "post", {
			operationId: "createItem",
			responses: {},
			"x-mcp": true,
		})
		const ir = toIR(spec)
		expect(ir.operations[0].extensions.mcp).toBe(true)
	})

	/* T1.2 — x-mcp absent → mcp undefined */
	it("T1.2 x-mcp absent → mcp undefined", () => {
		const spec = specWithOp("/items", "post", {
			operationId: "createItem",
			responses: {},
		})
		const ir = toIR(spec)
		expect(ir.operations[0].extensions.mcp).toBeUndefined()
	})

	/* T1.3 — x-mcp non-true values ignored */
	it("T1.3 x-mcp non-true values ignored (false / string / object / number)", () => {
		for (const value of [false, "yes", {}, 1]) {
			const spec = specWithOp("/items", "post", {
				operationId: "createItem",
				responses: {},
				"x-mcp": value,
			})
			const ir = toIR(spec)
			expect(ir.operations[0].extensions.mcp).toBeUndefined()
		}
	})

	it("operation without operationId is skipped", () => {
		const spec = minimalSpec({
			paths: {
				"/items": {
					get: { responses: {} } /* no operationId */,
					post: { operationId: "createItem", responses: {} },
				},
			},
		})
		const ir = toIR(spec)
		expect(ir.operations).toHaveLength(1)
		expect(ir.operations[0].id).toBe("createItem")
	})

	it("duplicate operationId throws", () => {
		const spec = minimalSpec({
			paths: {
				"/a": { get: { operationId: "same", responses: {} } },
				"/b": { get: { operationId: "same", responses: {} } },
			},
		})
		expect(() => toIR(spec)).toThrow(/Duplicate operationId/)
	})

	/* ---- multi-type arrays (IR amendment) ---- */
	it("multi-type array → union of scalars", () => {
		expect(schemaToIR({ type: ["string", "number"] })).toEqual({
			kind: "union",
			variants: [
				{ kind: "scalar", type: "string" },
				{ kind: "scalar", type: "number" },
			],
		})
	})

	it("multi-type with null → nullable(union of non-null types)", () => {
		/* nullable path strips null first, then multi-type branch fires on remaining [string, number] */
		expect(schemaToIR({ type: ["string", "number", "null"] })).toEqual({
			inner: {
				kind: "union",
				variants: [
					{ kind: "scalar", type: "string" },
					{ kind: "scalar", type: "number" },
				],
			},
			kind: "nullable",
		})
	})
})

/* ======================================================= */
describe("toIR (spec-level)", () => {
	it("IR.schemas populated from components.schemas", () => {
		const spec = minimalSpec({
			components: {
				schemas: {
					Bar: { type: "string" },
					Foo: { type: "object" },
				},
			},
		})
		const ir = toIR(spec)
		expect(Object.keys(ir.schemas)).toContain("Foo")
		expect(Object.keys(ir.schemas)).toContain("Bar")
		expect(ir.schemas["Foo"]).toEqual({ fields: [], kind: "object" })
	})

	it("IR.schemas empty when no components", () => {
		const ir = toIR(minimalSpec())
		expect(ir.schemas).toEqual({})
	})

	it("IR.operations in insertion order of path x method", () => {
		const spec = minimalSpec({
			paths: {
				"/a": {
					get: { operationId: "getA", responses: {} },
					post: { operationId: "postA", responses: {} },
				},
				"/b": { get: { operationId: "getB", responses: {} } },
			},
		})
		const ir = toIR(spec)
		expect(ir.operations.map((o) => o.id)).toEqual(["getA", "postA", "getB"])
	})

	it("toIR is pure — same input same output", () => {
		const spec = minimalSpec({
			paths: {
				"/items": { get: { operationId: "listItems", responses: {} } },
			},
		})
		const a = toIR(spec)
		const b = toIR(spec)
		expect(a).toEqual(b)
	})

	it("toIR does not mutate frozen input", () => {
		const spec = Object.freeze(
			minimalSpec({
				paths: {
					"/items": { get: { operationId: "listItems", responses: {} } },
				},
			}),
		)
		expect(() => toIR(spec as Parameters<typeof toIR>[0])).not.toThrow()
	})
})

/* ======================================================= */
describe("toIR (fixture round-trip)", () => {
	function countOpsWithId(spec: Record<string, unknown>): number {
		const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"]
		const paths = (spec.paths ?? {}) as Record<string, Record<string, Record<string, unknown>>>
		let count = 0
		for (const pathItem of Object.values(paths)) {
			for (const method of HTTP_METHODS) {
				const op = pathItem[method]
				if (op && typeof op.operationId === "string") count++
			}
		}
		return count
	}

	function countComponents(spec: Record<string, unknown>): number {
		const schemas = (spec as { components?: { schemas?: Record<string, unknown> } }).components?.schemas
		return schemas ? Object.keys(schemas).length : 0
	}

	for (const lang of ["python", "go", "rust"] as const) {
		const dir = fixtureDir(lang)
		const files = readdirSync(dir).filter((f) => f.endsWith(".json"))

		for (const file of files) {
			it(`${lang}/${file} round-trip`, () => {
				const spec = loadFixture(lang, file)
				const ir = toIR(spec as Parameters<typeof toIR>[0])
				const expectedOps = countOpsWithId(spec)
				const expectedSchemas = countComponents(spec)
				expect(ir.operations).toHaveLength(expectedOps)
				expect(Object.keys(ir.schemas)).toHaveLength(expectedSchemas)
			})
		}
	}
})
