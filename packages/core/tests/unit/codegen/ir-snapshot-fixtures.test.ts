import { describe, expect, it } from "vitest"
import { schemaToIR, toIR } from "../../../src/codegen-ir.ts"

/* minimal full-spec wrapper for operation-level cases */
function spec(op: Record<string, unknown>): Parameters<typeof toIR>[0] {
	return {
		info: { title: "T", version: "1" },
		openapi: "3.1.0",
		paths: { "/x": { get: op } },
	} as Parameters<typeof toIR>[0]
}

/* ======================================================= */
describe("IR snapshot — schema kinds", () => {
	/* 1. Recursive object — Tree → children → Tree[] */
	it("recursive Tree", () => {
		expect(
			schemaToIR({
				properties: {
					children: { items: { $ref: "#/components/schemas/Tree" }, type: "array" },
				},
				type: "object",
			}),
		).toMatchInlineSnapshot(`
			{
			  "fields": [
			    {
			      "name": "children",
			      "required": false,
			      "schema": {
			        "items": {
			          "kind": "ref",
			          "name": "Tree",
			        },
			        "kind": "array",
			      },
			    },
			  ],
			  "kind": "object",
			}
		`)
	})

	/* 2. Mutually recursive refs — A → B → A */
	it("mutually recursive refs A→B→A", () => {
		expect(
			schemaToIR({
				properties: {
					b: { $ref: "#/components/schemas/B" },
				},
				type: "object",
			}),
		).toMatchInlineSnapshot(`
			{
			  "fields": [
			    {
			      "name": "b",
			      "required": false,
			      "schema": {
			        "kind": "ref",
			        "name": "B",
			      },
			    },
			  ],
			  "kind": "object",
			}
		`)
	})

	/* 3. oneOf with discriminator + mapping */
	it("oneOf with discriminator and mapping", () => {
		expect(
			schemaToIR({
				discriminator: {
					mapping: {
						cat: "#/components/schemas/Cat",
						dog: "#/components/schemas/Dog",
					},
					propertyName: "kind",
				},
				oneOf: [{ $ref: "#/components/schemas/Dog" }, { $ref: "#/components/schemas/Cat" }],
			}),
		).toMatchInlineSnapshot(`
			{
			  "discriminator": {
			    "mapping": {
			      "cat": "Cat",
			      "dog": "Dog",
			    },
			    "propertyName": "kind",
			  },
			  "kind": "union",
			  "variants": [
			    {
			      "kind": "ref",
			      "name": "Dog",
			    },
			    {
			      "kind": "ref",
			      "name": "Cat",
			    },
			  ],
			}
		`)
	})

	/* 4. anyOf with all-null variants stripped to single non-null */
	it("anyOf null stripped to single non-null", () => {
		expect(schemaToIR({ anyOf: [{ type: "string" }, { type: "null" }] })).toMatchInlineSnapshot(`
			{
			  "inner": {
			    "kind": "scalar",
			    "type": "string",
			  },
			  "kind": "nullable",
			}
		`)
	})

	/* 5. Deeply-nested object (4+ levels) */
	it("deeply nested object 4 levels", () => {
		expect(
			schemaToIR({
				properties: {
					a: {
						properties: {
							b: {
								properties: {
									c: {
										properties: {
											d: { type: "string" },
										},
										type: "object",
									},
								},
								type: "object",
							},
						},
						type: "object",
					},
				},
				type: "object",
			}),
		).toMatchInlineSnapshot(`
			{
			  "fields": [
			    {
			      "name": "a",
			      "required": false,
			      "schema": {
			        "fields": [
			          {
			            "name": "b",
			            "required": false,
			            "schema": {
			              "fields": [
			                {
			                  "name": "c",
			                  "required": false,
			                  "schema": {
			                    "fields": [
			                      {
			                        "name": "d",
			                        "required": false,
			                        "schema": {
			                          "kind": "scalar",
			                          "type": "string",
			                        },
			                      },
			                    ],
			                    "kind": "object",
			                  },
			                },
			              ],
			              "kind": "object",
			            },
			          },
			        ],
			        "kind": "object",
			      },
			    },
			  ],
			  "kind": "object",
			}
		`)
	})

	/* 6. Array of array of array */
	it("array of array of array", () => {
		expect(
			schemaToIR({
				items: { items: { items: { type: "string" }, type: "array" }, type: "array" },
				type: "array",
			}),
		).toMatchInlineSnapshot(`
			{
			  "items": {
			    "items": {
			      "items": {
			        "kind": "scalar",
			        "type": "string",
			      },
			      "kind": "array",
			    },
			    "kind": "array",
			  },
			  "kind": "array",
			}
		`)
	})

	/* 7. Tuple of mixed types [string, number, bool] */
	it("tuple of mixed types", () => {
		expect(
			schemaToIR({
				items: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
				type: "array",
			}),
		).toMatchInlineSnapshot(`
			{
			  "items": [
			    {
			      "kind": "scalar",
			      "type": "string",
			    },
			    {
			      "kind": "scalar",
			      "type": "number",
			    },
			    {
			      "kind": "scalar",
			      "type": "boolean",
			    },
			  ],
			  "kind": "tuple",
			}
		`)
	})

	/* 8. allOf merging 3 object schemas with overlapping keys */
	it("allOf merging 3 objects with overlapping keys", () => {
		expect(
			schemaToIR({
				allOf: [
					{ properties: { id: { type: "integer" }, name: { type: "string" } }, type: "object" },
					{ properties: { name: { type: "string" }, role: { type: "string" } }, type: "object" },
					{ properties: { active: { type: "boolean" }, name: { type: "string" } }, type: "object" },
				],
			}),
		).toMatchInlineSnapshot(`
			{
			  "kind": "allOf",
			  "parts": [
			    {
			      "fields": [
			        {
			          "name": "id",
			          "required": false,
			          "schema": {
			            "kind": "scalar",
			            "type": "integer",
			          },
			        },
			        {
			          "name": "name",
			          "required": false,
			          "schema": {
			            "kind": "scalar",
			            "type": "string",
			          },
			        },
			      ],
			      "kind": "object",
			    },
			    {
			      "fields": [
			        {
			          "name": "name",
			          "required": false,
			          "schema": {
			            "kind": "scalar",
			            "type": "string",
			          },
			        },
			        {
			          "name": "role",
			          "required": false,
			          "schema": {
			            "kind": "scalar",
			            "type": "string",
			          },
			        },
			      ],
			      "kind": "object",
			    },
			    {
			      "fields": [
			        {
			          "name": "active",
			          "required": false,
			          "schema": {
			            "kind": "scalar",
			            "type": "boolean",
			          },
			        },
			        {
			          "name": "name",
			          "required": false,
			          "schema": {
			            "kind": "scalar",
			            "type": "string",
			          },
			        },
			      ],
			      "kind": "object",
			    },
			  ],
			}
		`)
	})

	/* 9. Multi-type-no-null type: ["string","number","boolean"] */
	it("multi-type no-null union", () => {
		expect(schemaToIR({ type: ["string", "number", "boolean"] })).toMatchInlineSnapshot(`
			{
			  "kind": "union",
			  "variants": [
			    {
			      "kind": "scalar",
			      "type": "string",
			    },
			    {
			      "kind": "scalar",
			      "type": "number",
			    },
			    {
			      "kind": "scalar",
			      "type": "boolean",
			    },
			  ],
			}
		`)
	})

	/* 10. Multi-type-with-null type: ["string","integer","null"] */
	it("multi-type with null → nullable union", () => {
		expect(schemaToIR({ type: ["string", "integer", "null"] })).toMatchInlineSnapshot(`
			{
			  "inner": {
			    "kind": "union",
			    "variants": [
			      {
			        "kind": "scalar",
			        "type": "string",
			      },
			      {
			        "kind": "scalar",
			        "type": "integer",
			      },
			    ],
			  },
			  "kind": "nullable",
			}
		`)
	})

	/* 11. Const with each primitive — string, int, float, bool, null */
	it("const string primitive", () => {
		expect(schemaToIR({ const: "active" })).toMatchInlineSnapshot(`
			{
			  "kind": "const",
			  "value": "active",
			}
		`)
	})

	it("const integer primitive", () => {
		expect(schemaToIR({ const: 42 })).toMatchInlineSnapshot(`
			{
			  "kind": "const",
			  "value": 42,
			}
		`)
	})

	it("const float primitive", () => {
		expect(schemaToIR({ const: 3.14 })).toMatchInlineSnapshot(`
			{
			  "kind": "const",
			  "value": 3.14,
			}
		`)
	})

	it("const bool primitive", () => {
		expect(schemaToIR({ const: true })).toMatchInlineSnapshot(`
			{
			  "kind": "const",
			  "value": true,
			}
		`)
	})

	it("const null primitive → unknown (not a supported const type)", () => {
		/* null const is not string|number|boolean — falls through to unknown */
		expect(schemaToIR({ const: null })).toMatchInlineSnapshot(`
			{
			  "kind": "unknown",
			}
		`)
	})

	/* 12. Empty object {} (no type, no properties) */
	it("empty object schema no type no properties", () => {
		expect(schemaToIR({})).toMatchInlineSnapshot(`
			{
			  "kind": "unknown",
			}
		`)
	})

	/* 13. Object with additionalProperties: true */
	it("object with additionalProperties true", () => {
		expect(schemaToIR({ additionalProperties: true, type: "object" })).toMatchInlineSnapshot(`
			{
			  "additional": {
			    "kind": "unknown",
			  },
			  "fields": [],
			  "kind": "object",
			}
		`)
	})

	/* 14. Object with additionalProperties: { type: "string" } */
	it("object with additionalProperties string schema", () => {
		expect(schemaToIR({ additionalProperties: { type: "string" }, type: "object" })).toMatchInlineSnapshot(`
			{
			  "additional": {
			    "kind": "scalar",
			    "type": "string",
			  },
			  "fields": [],
			  "kind": "object",
			}
		`)
	})

	/* 15. Object with additionalProperties: false + properties */
	it("object with additionalProperties false and properties", () => {
		expect(
			schemaToIR({
				additionalProperties: false,
				properties: { id: { type: "integer" } },
				required: ["id"],
				type: "object",
			}),
		).toMatchInlineSnapshot(`
			{
			  "additional": false,
			  "fields": [
			    {
			      "name": "id",
			      "required": true,
			      "schema": {
			        "kind": "scalar",
			        "type": "integer",
			      },
			    },
			  ],
			  "kind": "object",
			}
		`)
	})

	/* 16. String enum with 1 value */
	it("string enum single value", () => {
		expect(schemaToIR({ enum: ["only"], type: "string" })).toMatchInlineSnapshot(`
			{
			  "enum": [
			    "only",
			  ],
			  "kind": "scalar",
			  "type": "string",
			}
		`)
	})

	/* 17. Integer enum with negative values */
	it("integer enum with negative values", () => {
		expect(schemaToIR({ enum: [-3, -1, 0, 1], type: "integer" })).toMatchInlineSnapshot(`
			{
			  "enum": [
			    -3,
			    -1,
			    0,
			    1,
			  ],
			  "kind": "scalar",
			  "type": "integer",
			}
		`)
	})

	/* 18. Mixed enum ["active", 1, true] → union of const */
	it("mixed enum union of const literals", () => {
		expect(schemaToIR({ enum: ["active", 1, true] })).toMatchInlineSnapshot(`
			{
			  "kind": "union",
			  "variants": [
			    {
			      "kind": "const",
			      "value": "active",
			    },
			    {
			      "kind": "const",
			      "value": 1,
			    },
			    {
			      "kind": "const",
			      "value": true,
			    },
			  ],
			}
		`)
	})

	/* 19. nullable: true on a union (oneOf) */
	it("nullable true on a oneOf union", () => {
		expect(
			schemaToIR({
				nullable: true,
				oneOf: [{ type: "string" }, { type: "integer" }],
			}),
		).toMatchInlineSnapshot(`
			{
			  "inner": {
			    "kind": "union",
			    "variants": [
			      {
			        "kind": "scalar",
			        "type": "string",
			      },
			      {
			        "kind": "scalar",
			        "type": "integer",
			      },
			    ],
			  },
			  "kind": "nullable",
			}
		`)
	})

	/* 20. format: binary on string */
	it("format binary on string type", () => {
		expect(schemaToIR({ format: "binary", type: "string" })).toMatchInlineSnapshot(`
			{
			  "kind": "binary",
			}
		`)
	})

	/* 21. format: binary bare (no type) */
	it("format binary bare no type", () => {
		expect(schemaToIR({ format: "binary" })).toMatchInlineSnapshot(`
			{
			  "kind": "binary",
			}
		`)
	})

	/* 22. $ref absolute (#/components/schemas/X) */
	it("ref absolute path", () => {
		expect(schemaToIR({ $ref: "#/components/schemas/User" })).toMatchInlineSnapshot(`
			{
			  "kind": "ref",
			  "name": "User",
			}
		`)
	})

	/* 23. unknown / no schema given (undefined) */
	it("undefined schema input", () => {
		expect(schemaToIR(undefined)).toMatchInlineSnapshot(`
			{
			  "kind": "unknown",
			}
		`)
	})

	/* 24. Object with reserved-word property keys (type, class, if) */
	it("object with reserved-word property keys", () => {
		expect(
			schemaToIR({
				properties: {
					class: { type: "string" },
					if: { type: "boolean" },
					type: { type: "string" },
				},
				type: "object",
			}),
		).toMatchInlineSnapshot(`
			{
			  "fields": [
			    {
			      "name": "class",
			      "required": false,
			      "schema": {
			        "kind": "scalar",
			        "type": "string",
			      },
			    },
			    {
			      "name": "if",
			      "required": false,
			      "schema": {
			        "kind": "scalar",
			        "type": "boolean",
			      },
			    },
			    {
			      "name": "type",
			      "required": false,
			      "schema": {
			        "kind": "scalar",
			        "type": "string",
			      },
			    },
			  ],
			  "kind": "object",
			}
		`)
	})
})

/* ======================================================= */
describe("IR snapshot — operation extensions", () => {
	/* 25. Operation with x-websocket extension */
	it("x-websocket extension", () => {
		expect(toIR(spec({ operationId: "wsOp", responses: {}, "x-websocket": true })).operations[0])
			.toMatchInlineSnapshot(`
			{
			  "extensions": {
			    "websocket": true,
			  },
			  "id": "wsOp",
			  "method": "GET",
			  "params": {
			    "header": [],
			    "path": [],
			    "query": [],
			  },
			  "path": "/x",
			  "responses": {},
			}
		`)
	})

	/* 26. Operation with x-realtime extension */
	it("x-realtime extension", () => {
		expect(toIR(spec({ operationId: "rtOp", responses: {}, "x-realtime": true })).operations[0]).toMatchInlineSnapshot(`
			{
			  "extensions": {
			    "realtime": true,
			  },
			  "id": "rtOp",
			  "method": "GET",
			  "params": {
			    "header": [],
			    "path": [],
			    "query": [],
			  },
			  "path": "/x",
			  "responses": {},
			}
		`)
	})

	/* 27. Operation with x-invalidate (3+ targets) */
	it("x-invalidate with 3 targets", () => {
		expect(
			toIR(
				spec({
					operationId: "createOp",
					responses: {},
					"x-invalidate": ["GET /items", "GET /users", "GET /tags"],
				}),
			).operations[0],
		).toMatchInlineSnapshot(`
			{
			  "extensions": {
			    "invalidates": [
			      "GET /items",
			      "GET /users",
			      "GET /tags",
			    ],
			  },
			  "id": "createOp",
			  "method": "GET",
			  "params": {
			    "header": [],
			    "path": [],
			    "query": [],
			  },
			  "path": "/x",
			  "responses": {},
			}
		`)
	})

	/* 27b. Operation with x-idempotency-key extension */
	it("x-idempotency-key extension", () => {
		expect(toIR(spec({ operationId: "idemOp", responses: {}, "x-idempotency-key": true })).operations[0])
			.toMatchInlineSnapshot(`
			{
			  "extensions": {
			    "idempotencyKey": true,
			  },
			  "id": "idemOp",
			  "method": "GET",
			  "params": {
			    "header": [],
			    "path": [],
			    "query": [],
			  },
			  "path": "/x",
			  "responses": {},
			}
		`)
	})

	/* 28. text/event-stream response → sse auto-detected */
	it("text/event-stream response auto-detects sse extension", () => {
		expect(
			toIR(
				spec({
					operationId: "streamOp",
					responses: {
						"200": { content: { "text/event-stream": { schema: { type: "string" } } } },
					},
				}),
			).operations[0],
		).toMatchInlineSnapshot(`
			{
			  "extensions": {
			    "sse": true,
			  },
			  "id": "streamOp",
			  "method": "GET",
			  "params": {
			    "header": [],
			    "path": [],
			    "query": [],
			  },
			  "path": "/x",
			  "responses": {
			    "200": {
			      "contentType": "text/event-stream",
			      "schema": {
			        "kind": "scalar",
			        "type": "string",
			      },
			      "status": "200",
			    },
			  },
			}
		`)
	})

	/* 29. Operation with multipart/form-data body (binary file part → stream-multipart variant) */
	it("multipart form-data body with binary + text parts", () => {
		const multipartSpec: Parameters<typeof toIR>[0] = {
			info: { title: "T", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/upload": {
					post: {
						operationId: "uploadOp",
						requestBody: {
							content: {
								"multipart/form-data": {
									schema: {
										properties: {
											description: { type: "string" },
											file: { format: "binary", type: "string" },
										},
										type: "object",
									},
								},
							},
							required: true,
						},
						responses: {},
					},
				},
			},
		} as Parameters<typeof toIR>[0]
		expect(toIR(multipartSpec).operations[0]).toMatchInlineSnapshot(`
			{
			  "body": {
			    "contentType": "multipart/form-data",
			    "kind": "multipart",
			    "parts": [
			      {
			        "name": "description",
			        "schema": {
			          "kind": "scalar",
			          "type": "string",
			        },
			        "type": "text",
			      },
			      {
			        "name": "file",
			        "schema": {
			          "kind": "binary",
			        },
			        "type": "file",
			      },
			    ],
			    "required": true,
			  },
			  "extensions": {},
			  "id": "uploadOp",
			  "method": "POST",
			  "params": {
			    "header": [],
			    "path": [],
			    "query": [],
			  },
			  "path": "/upload",
			  "responses": {},
			}
		`)
	})

	/* 29b. Pure octet-stream body → stream variant */
	it("application/octet-stream body → stream IRBody", () => {
		const streamSpec: Parameters<typeof toIR>[0] = {
			info: { title: "T", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/raw-upload": {
					post: {
						operationId: "rawUploadOp",
						requestBody: {
							content: {
								"application/octet-stream": {
									schema: { format: "binary", type: "string" },
								},
							},
							required: true,
						},
						responses: {},
					},
				},
			},
		} as Parameters<typeof toIR>[0]
		expect(toIR(streamSpec).operations[0]).toMatchInlineSnapshot(`
			{
			  "body": {
			    "contentType": "application/octet-stream",
			    "kind": "stream",
			    "required": true,
			  },
			  "extensions": {},
			  "id": "rawUploadOp",
			  "method": "POST",
			  "params": {
			    "header": [],
			    "path": [],
			    "query": [],
			  },
			  "path": "/raw-upload",
			  "responses": {},
			}
		`)
	})

	/* 29c. Multipart with only text parts (no binary) → stays raw */
	it("multipart form-data with only text parts stays raw", () => {
		const textOnlySpec: Parameters<typeof toIR>[0] = {
			info: { title: "T", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/form": {
					post: {
						operationId: "formOp",
						requestBody: {
							content: {
								"multipart/form-data": {
									schema: {
										properties: { name: { type: "string" } },
										type: "object",
									},
								},
							},
							required: false,
						},
						responses: {},
					},
				},
			},
		} as Parameters<typeof toIR>[0]
		expect(toIR(textOnlySpec).operations[0].body).toMatchInlineSnapshot(`
			{
			  "contentType": "multipart/form-data",
			  "kind": "raw",
			  "required": false,
			  "schema": {
			    "fields": [
			      {
			        "name": "name",
			        "required": false,
			        "schema": {
			          "kind": "scalar",
			          "type": "string",
			        },
			      },
			    ],
			    "kind": "object",
			  },
			}
		`)
	})

	/* 30. Operation skipped without operationId */
	it("operation without operationId is skipped", () => {
		const twoOpSpec: Parameters<typeof toIR>[0] = {
			info: { title: "T", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/x": {
					/* no operationId — should be skipped */
					get: { responses: {} },
					post: { operationId: "namedOp", responses: {} },
				},
			},
		} as Parameters<typeof toIR>[0]
		const ir = toIR(twoOpSpec)
		expect(ir.operations).toHaveLength(1)
		expect(ir.operations[0]).toMatchInlineSnapshot(`
			{
			  "extensions": {},
			  "id": "namedOp",
			  "method": "POST",
			  "params": {
			    "header": [],
			    "path": [],
			    "query": [],
			  },
			  "path": "/x",
			  "responses": {},
			}
		`)
	})

	/* 31. Duplicate operationId throws */
	it("duplicate operationId throws", () => {
		const dupSpec: Parameters<typeof toIR>[0] = {
			info: { title: "T", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/a": { get: { operationId: "same", responses: {} } },
				"/b": { get: { operationId: "same", responses: {} } },
			},
		} as Parameters<typeof toIR>[0]
		expect(() => toIR(dupSpec)).toThrow(/Duplicate operationId/)
	})
})
