import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { generateOpenApi } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"
import { resolveSchema } from "./_resolve-schema.ts"

/**
 * Helper: create honey app with valibot schema as JSON input,
 * generate OpenAPI, return the JSON Schema from the request body.
 */
async function inputSchema(schema: v.GenericSchema): Promise<unknown> {
	const h = honey<{}>()
	h.post("/test")
		.input({ json: schema })
		.handler((ctx) => ctx.res.text("ok", "ok"))

	const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
	const op = spec.paths["/test"]?.post as Record<string, unknown>
	const body = op.requestBody as Record<string, unknown>
	const content = body.content as Record<string, Record<string, unknown>>
	return resolveSchema(spec, content["application/json"].schema as Record<string, unknown>)
}

/**
 * Helper: create honey app with valibot schema as JSON output,
 * generate OpenAPI, return the JSON Schema from the 200 response.
 */
async function outputSchema(schema: v.GenericSchema): Promise<unknown> {
	const h = honey<{}>()
	h.get("/test")
		.output({ "application/json": { ok: schema } })
		.handler((ctx) => ctx.res.json("ok", {}))

	const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
	const op = spec.paths["/test"]?.get as Record<string, unknown>
	const responses = op.responses as Record<string, Record<string, unknown>>
	const content = responses["200"].content as Record<string, Record<string, unknown>>
	return resolveSchema(spec, content["application/json"].schema as Record<string, unknown>)
}

/* ---- Primitive types ---- */

describe("valibot → JSON Schema: primitives", () => {
	it("string → {type: 'string'}", async () => {
		expect(await inputSchema(v.string())).toEqual({ type: "string" })
	})

	it("number → {type: 'number'}", async () => {
		expect(await inputSchema(v.number())).toEqual({ type: "number" })
	})

	it("boolean → {type: 'boolean'}", async () => {
		expect(await inputSchema(v.boolean())).toEqual({ type: "boolean" })
	})

	it("bigint → {type: 'integer'}", async () => {
		expect(await inputSchema(v.bigint())).toEqual({ format: "int64", type: "integer" })
	})

	it("date → {type: 'string', format: 'date-time'}", async () => {
		expect(await inputSchema(v.date())).toEqual({ format: "date-time", type: "string" })
	})
})

/* ---- null ---- */

describe("valibot → JSON Schema: null", () => {
	it("null_ → {type: 'null'}", async () => {
		expect(await inputSchema(v.null_())).toEqual({ type: "null" })
	})
})

/* ---- literal ---- */

describe("valibot → JSON Schema: literal", () => {
	it("literal string → {const: 'hello'}", async () => {
		expect(await inputSchema(v.literal("hello"))).toEqual({ const: "hello" })
	})

	it("literal number → {const: 42}", async () => {
		expect(await inputSchema(v.literal(42))).toEqual({ const: 42 })
	})

	it("literal boolean → {const: true}", async () => {
		expect(await inputSchema(v.literal(true))).toEqual({ const: true })
	})
})

/* ---- object ---- */

describe("valibot → JSON Schema: object", () => {
	it("object with required fields", async () => {
		const schema = v.object({ age: v.number(), name: v.string() })
		expect(await inputSchema(schema)).toEqual({
			properties: {
				age: { type: "number" },
				name: { type: "string" },
			},
			required: ["age", "name"],
			type: "object",
		})
	})

	it("object with optional fields → NOT in required array", async () => {
		const schema = v.object({
			bio: v.optional(v.string()),
			name: v.string(),
		})
		const result = (await inputSchema(schema)) as Record<string, unknown>
		expect(result.type).toBe("object")
		expect(result.properties).toEqual({
			bio: { type: "string" },
			name: { type: "string" },
		})
		expect(result.required).toEqual(["name"])
	})

	it("object with all optional fields → no required key", async () => {
		const schema = v.object({
			a: v.optional(v.string()),
			b: v.optional(v.number()),
		})
		const result = (await inputSchema(schema)) as Record<string, unknown>
		expect(result.type).toBe("object")
		expect(result.properties).toEqual({
			a: { type: "string" },
			b: { type: "number" },
		})
		expect(result.required).toBeUndefined()
	})

	it("nested objects", async () => {
		const schema = v.object({
			address: v.object({
				city: v.string(),
				zip: v.string(),
			}),
			name: v.string(),
		})
		expect(await inputSchema(schema)).toEqual({
			properties: {
				address: {
					properties: {
						city: { type: "string" },
						zip: { type: "string" },
					},
					required: ["city", "zip"],
					type: "object",
				},
				name: { type: "string" },
			},
			required: ["address", "name"],
			type: "object",
		})
	})

	it("empty object → {type: 'object'}", async () => {
		expect(await inputSchema(v.object({}))).toEqual({ type: "object" })
	})
})

/* ---- array ---- */

describe("valibot → JSON Schema: array", () => {
	it("array of strings", async () => {
		expect(await inputSchema(v.array(v.string()))).toEqual({
			items: { type: "string" },
			type: "array",
		})
	})

	it("array of objects", async () => {
		const schema = v.array(v.object({ id: v.number() }))
		expect(await inputSchema(schema)).toEqual({
			items: {
				properties: { id: { type: "number" } },
				required: ["id"],
				type: "object",
			},
			type: "array",
		})
	})
})

/* ---- optional (standalone) ---- */

describe("valibot → JSON Schema: optional", () => {
	it("optional unwraps to inner schema", async () => {
		expect(await inputSchema(v.optional(v.string()))).toEqual({ type: "string" })
	})

	it("optional number unwraps to {type: 'number'}", async () => {
		expect(await inputSchema(v.optional(v.number()))).toEqual({ type: "number" })
	})
})

/* ---- nullable ---- */

describe("valibot → JSON Schema: nullable", () => {
	it("nullable string → anyOf with null", async () => {
		expect(await inputSchema(v.nullable(v.string()))).toEqual({
			anyOf: [{ type: "string" }, { type: "null" }],
		})
	})

	it("nullable object → anyOf with null", async () => {
		const schema = v.nullable(v.object({ id: v.string() }))
		expect(await inputSchema(schema)).toEqual({
			anyOf: [
				{
					properties: { id: { type: "string" } },
					required: ["id"],
					type: "object",
				},
				{ type: "null" },
			],
		})
	})
})

/* ---- nullish ---- */

describe("valibot → JSON Schema: nullish", () => {
	it("nullish string → anyOf with null", async () => {
		expect(await inputSchema(v.nullish(v.string()))).toEqual({
			anyOf: [{ type: "string" }, { type: "null" }],
		})
	})

	it("nullish number → anyOf with null", async () => {
		expect(await inputSchema(v.nullish(v.number()))).toEqual({
			anyOf: [{ type: "number" }, { type: "null" }],
		})
	})
})

/* ---- union ---- */

describe("valibot → JSON Schema: union", () => {
	it("union of string | number → anyOf", async () => {
		const schema = v.union([v.string(), v.number()])
		expect(await inputSchema(schema)).toEqual({
			anyOf: [{ type: "string" }, { type: "number" }],
		})
	})

	it("union of three types", async () => {
		const schema = v.union([v.string(), v.number(), v.boolean()])
		expect(await inputSchema(schema)).toEqual({
			anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
		})
	})
})

/* ---- intersect ---- */

describe("valibot → JSON Schema: intersect", () => {
	it("intersect of two objects → allOf", async () => {
		const schema = v.intersect([v.object({ a: v.string() }), v.object({ b: v.number() })])
		expect(await inputSchema(schema)).toEqual({
			allOf: [
				{
					properties: { a: { type: "string" } },
					required: ["a"],
					type: "object",
				},
				{
					properties: { b: { type: "number" } },
					required: ["b"],
					type: "object",
				},
			],
		})
	})
})

/* ---- picklist ---- */

describe("valibot → JSON Schema: picklist", () => {
	it("picklist → {enum: [...]}", async () => {
		const schema = v.picklist(["active", "inactive", "pending"])
		expect(await inputSchema(schema)).toEqual({
			enum: ["active", "inactive", "pending"],
		})
	})
})

/* ---- enum_ ---- */

describe("valibot → JSON Schema: enum_", () => {
	it("enum_ → {enum: [...values]}", async () => {
		const MyEnum = { Admin: "admin", User: "user" } as const
		const schema = v.enum_(MyEnum)
		expect(await inputSchema(schema)).toEqual({
			enum: ["admin", "user"],
		})
	})
})

/* ---- record ---- */

describe("valibot → JSON Schema: record", () => {
	it("record with number values → additionalProperties", async () => {
		const schema = v.record(v.string(), v.number())
		expect(await inputSchema(schema)).toEqual({
			additionalProperties: { type: "number" },
			type: "object",
		})
	})

	it("record with object values", async () => {
		const schema = v.record(v.string(), v.object({ name: v.string() }))
		expect(await inputSchema(schema)).toEqual({
			additionalProperties: {
				properties: { name: { type: "string" } },
				required: ["name"],
				type: "object",
			},
			type: "object",
		})
	})
})

/* ---- tuple ---- */

describe("valibot → JSON Schema: tuple", () => {
	it("tuple [string, number] → fixed array", async () => {
		const schema = v.tuple([v.string(), v.number()])
		expect(await inputSchema(schema)).toEqual({
			items: false,
			maxItems: 2,
			minItems: 2,
			prefixItems: [{ type: "string" }, { type: "number" }],
			type: "array",
		})
	})

	it("single-element tuple", async () => {
		const schema = v.tuple([v.boolean()])
		expect(await inputSchema(schema)).toEqual({
			items: false,
			maxItems: 1,
			minItems: 1,
			prefixItems: [{ type: "boolean" }],
			type: "array",
		})
	})
})

/* ---- pipe ---- */

describe("valibot → JSON Schema: pipe", () => {
	it("pipe(string, minLength) → minLength", async () => {
		const schema = v.pipe(v.string(), v.minLength(1))
		expect(await inputSchema(schema)).toEqual({ minLength: 1, type: "string" })
	})

	it("pipe(number, minValue) → minimum", async () => {
		const schema = v.pipe(v.number(), v.minValue(0))
		expect(await inputSchema(schema)).toEqual({ minimum: 0, type: "number" })
	})

	it("pipe(string, email) and pipe(number, integer) keep their meaning", async () => {
		expect(await inputSchema(v.pipe(v.string(), v.email()))).toEqual({ format: "email", type: "string" })
		expect(await inputSchema(v.pipe(v.number(), v.integer()))).toEqual({ type: "integer" })
	})
})

/* ---- node kinds the converter used to drop ---- */

describe("valibot → JSON Schema: object variants, wrappers, lazy, binary", () => {
	it("nullish and exactOptional entries are optional", async () => {
		const schema = v.object({ a: v.nullish(v.string()), b: v.exactOptional(v.string()), c: v.string() })
		expect(await inputSchema(schema)).toEqual({
			properties: {
				a: { anyOf: [{ type: "string" }, { type: "null" }] },
				b: { type: "string" },
				c: { type: "string" },
			},
			required: ["c"],
			type: "object",
		})
	})

	it("strictObject forbids extra keys; looseObject and objectWithRest describe them", async () => {
		expect(await inputSchema(v.strictObject({ a: v.string() }))).toEqual({
			additionalProperties: false,
			properties: { a: { type: "string" } },
			required: ["a"],
			type: "object",
		})
		expect(await inputSchema(v.looseObject({ a: v.string() }))).toEqual({
			properties: { a: { type: "string" } },
			required: ["a"],
			type: "object",
		})
		expect(await inputSchema(v.objectWithRest({ a: v.string() }, v.number()))).toEqual({
			additionalProperties: { type: "number" },
			properties: { a: { type: "string" } },
			required: ["a"],
			type: "object",
		})
	})

	it("variant is a union; lazy resolves; file and blob are binary", async () => {
		const schema = v.object({
			f: v.file(),
			l: v.lazy(() => v.string()),
			u: v.variant("k", [v.object({ k: v.literal("a") }), v.object({ k: v.literal("b") })]),
		})
		const out = (await inputSchema(schema)) as { properties: Record<string, unknown> }
		expect(out.properties.f).toEqual({ contentEncoding: "binary", format: "binary", type: "string" })
		expect(out.properties.l).toEqual({ type: "string" })
		expect(out.properties.u).toEqual({
			anyOf: [
				{ properties: { k: { const: "a" } }, required: ["k"], type: "object" },
				{ properties: { k: { const: "b" } }, required: ["k"], type: "object" },
			],
		})
	})

	it("a recursive lazy schema terminates", async () => {
		type Node = { children: Node[] }
		const node: v.GenericSchema<Node> = v.object({ children: v.array(v.lazy(() => node)) })
		const out = await inputSchema(node)
		expect(out).toMatchObject({ properties: { children: { type: "array" } }, type: "object" })
	})
})

/* ---- output path ---- */

describe("valibot → JSON Schema: output path", () => {
	it("output schema produces correct JSON Schema in response", async () => {
		const schema = v.object({
			count: v.number(),
			items: v.array(v.object({ id: v.string(), name: v.string() })),
		})
		expect(await outputSchema(schema)).toEqual({
			properties: {
				count: { type: "number" },
				items: {
					items: {
						properties: {
							id: { type: "string" },
							name: { type: "string" },
						},
						required: ["id", "name"],
						type: "object",
					},
					type: "array",
				},
			},
			required: ["count", "items"],
			type: "object",
		})
	})

	it("nullable output field produces correct schema", async () => {
		const schema = v.object({
			data: v.nullable(v.string()),
		})
		expect(await outputSchema(schema)).toEqual({
			properties: {
				data: {
					anyOf: [{ type: "string" }, { type: "null" }],
				},
			},
			required: ["data"],
			type: "object",
		})
	})
})

/* ---- search input decomposition ---- */

describe("valibot → JSON Schema: search input decomposition", () => {
	it("search object decomposes into query parameters", async () => {
		const h = honey<{}>()
		h.get("/test")
			.input({ search: v.object({ limit: v.number(), page: v.number() }) })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/test"]?.get as Record<string, unknown>
		const params = op.parameters as Array<Record<string, unknown>>

		const pageParam = params.find((p) => p.name === "page")
		expect(pageParam?.in).toBe("query")
		expect(pageParam?.required).toBe(true)
		expect(pageParam?.schema).toEqual({ type: "number" })

		const limitParam = params.find((p) => p.name === "limit")
		expect(limitParam?.in).toBe("query")
		expect(limitParam?.required).toBe(true)
		expect(limitParam?.schema).toEqual({ type: "number" })
	})

	it("search with optional field → required=false on that param", async () => {
		const h = honey<{}>()
		h.get("/test")
			.input({
				search: v.object({
					filter: v.optional(v.string()),
					page: v.number(),
				}),
			})
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/test"]?.get as Record<string, unknown>
		const params = op.parameters as Array<Record<string, unknown>>

		const filterParam = params.find((p) => p.name === "filter")
		expect(filterParam?.required).toBe(false)

		const pageParam = params.find((p) => p.name === "page")
		expect(pageParam?.required).toBe(true)
	})
})
