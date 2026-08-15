import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { generateOpenApi, generateTypes } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"
import { emitSchemaType } from "../../../src/type-emitter.ts"

/* effect requires Schema.standardSchemaV1() wrapper for ~standard */
const ss = Schema.standardSchemaV1

describe("effect — type emission", () => {
	describe("primitives", () => {
		it("string", () => {
			expect(emitSchemaType(ss(Schema.String))).toBe("string")
		})

		it("number", () => {
			expect(emitSchemaType(ss(Schema.Number))).toBe("number")
		})

		it("boolean", () => {
			expect(emitSchemaType(ss(Schema.Boolean))).toBe("boolean")
		})

		it("undefined", () => {
			expect(emitSchemaType(ss(Schema.Undefined))).toBe("undefined")
		})

		it("null", () => {
			expect(emitSchemaType(ss(Schema.Null))).toBe("null")
		})

		it("unknown", () => {
			expect(emitSchemaType(ss(Schema.Unknown))).toBe("unknown")
		})

		it("void", () => {
			expect(emitSchemaType(ss(Schema.Void))).toBe("void")
		})

		it("never", () => {
			expect(emitSchemaType(ss(Schema.Never))).toBe("never")
		})

		it("bigint", () => {
			expect(emitSchemaType(ss(Schema.BigIntFromSelf))).toBe("bigint")
		})
	})

	describe("literals", () => {
		it("string literal", () => {
			expect(emitSchemaType(ss(Schema.Literal("hello")))).toBe('"hello"')
		})

		it("number literal", () => {
			expect(emitSchemaType(ss(Schema.Literal(42)))).toBe("42")
		})

		it("boolean literal", () => {
			expect(emitSchemaType(ss(Schema.Literal(true)))).toBe("true")
		})

		it("multi-literal union", () => {
			const schema = ss(Schema.Literal("a", "b", "c"))
			expect(emitSchemaType(schema)).toBe('"a" | "b" | "c"')
		})
	})

	describe("objects", () => {
		it("flat struct", () => {
			const schema = ss(Schema.Struct({ age: Schema.Number, name: Schema.String }))
			expect(emitSchemaType(schema)).toBe("{ age: number; name: string }")
		})

		it("nested struct", () => {
			const schema = ss(
				Schema.Struct({
					user: Schema.Struct({ active: Schema.Boolean, id: Schema.String }),
				}),
			)
			expect(emitSchemaType(schema)).toBe("{ user: { active: boolean; id: string } }")
		})

		it("empty struct", () => {
			expect(emitSchemaType(ss(Schema.Struct({})))).toBe("{}")
		})

		it("optional field", () => {
			const schema = ss(Schema.Struct({ age: Schema.optional(Schema.Number), name: Schema.String }))
			expect(emitSchemaType(schema)).toBe("{ age?: number | undefined; name: string }")
		})
	})

	describe("arrays", () => {
		it("string array", () => {
			expect(emitSchemaType(ss(Schema.Array(Schema.String)))).toBe("string[]")
		})

		it("object array", () => {
			const schema = ss(Schema.Array(Schema.Struct({ id: Schema.String })))
			expect(emitSchemaType(schema)).toBe("{ id: string }[]")
		})
	})

	describe("unions", () => {
		it("union", () => {
			expect(emitSchemaType(ss(Schema.Union(Schema.String, Schema.Number)))).toBe("string | number")
		})
	})

	describe("records", () => {
		it("record", () => {
			const schema = ss(Schema.Record({ key: Schema.String, value: Schema.Number }))
			expect(emitSchemaType(schema)).toBe("Record<string, number>")
		})
	})

	describe("tuples", () => {
		it("tuple", () => {
			const schema = ss(Schema.Tuple(Schema.String, Schema.Number))
			expect(emitSchemaType(schema)).toBe("[string, number]")
		})
	})
})

describe("effect — OpenAPI JSON Schema", () => {
	it("input object → proper JSON Schema", async () => {
		const h = honey<{}>()
		h.post("/items")
			.input({ json: ss(Schema.Struct({ age: Schema.Number, name: Schema.String })) })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.post as Record<string, unknown>
		const body = op.requestBody as Record<string, unknown>
		const content = body.content as Record<string, Record<string, unknown>>
		const schema = content["application/json"].schema as Record<string, unknown>
		expect(schema.type).toBe("object")
		expect(schema.properties).toBeDefined()
		const props = schema.properties as Record<string, Record<string, string>>
		expect(props.name.type).toBe("string")
		expect(props.age.type).toBe("number")
	})

	it("search → query parameters", async () => {
		const h = honey<{}>()
		h.get("/items")
			.input({
				search: ss(Schema.Struct({ limit: Schema.Number, page: Schema.Number })),
			})
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.get as Record<string, unknown>
		const params = op.parameters as Array<Record<string, unknown>>
		const pageParam = params.find((p) => p.name === "page")
		expect(pageParam?.in).toBe("query")
		expect(pageParam?.schema).toEqual({ type: "number" })
	})

	it("output → response with JSON Schema", async () => {
		const h = honey<{}>()
		h.get("/items")
			.output({
				"application/json": {
					ok: ss(Schema.Struct({ count: Schema.Number, id: Schema.String })),
				},
			})
			.handler((ctx) => ctx.res.json("ok", { count: 0, id: "1" }))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.get as Record<string, unknown>
		const responses = op.responses as Record<string, Record<string, unknown>>
		const content = responses["200"].content as Record<string, Record<string, unknown>>
		const schema = content["application/json"].schema as Record<string, unknown>
		expect(schema.type).toBe("object")
		const props = schema.properties as Record<string, Record<string, string>>
		expect(props.id.type).toBe("string")
		expect(props.count.type).toBe("number")
	})
})

describe("effect — generateTypes", () => {
	it("emits proper TS types", () => {
		const h = honey<{}>()
		h.post("/items")
			.input({ json: ss(Schema.Struct({ name: Schema.String })) })
			.output({
				"application/json": { ok: ss(Schema.Struct({ id: Schema.String })) },
			})
			.handler((ctx) => ctx.res.json("ok", { id: "1" }))

		const types = generateTypes(h, { appExport: "app", appImport: "./app" })
		expect(types).toContain("name: string")
		expect(types).toContain("ok: { id: string }")
	})
})
