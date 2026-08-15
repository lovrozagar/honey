import { describe, expect, it } from "vitest"
import * as zm from "zod/mini"
import { generateOpenApi, generateTypes } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"
import { emitSchemaType } from "../../../src/type-emitter.ts"

describe("zod mini — type emission", () => {
	describe("primitives", () => {
		it("string", () => {
			expect(emitSchemaType(zm.string())).toBe("string")
		})

		it("number", () => {
			expect(emitSchemaType(zm.number())).toBe("number")
		})

		it("boolean", () => {
			expect(emitSchemaType(zm.boolean())).toBe("boolean")
		})

		it("undefined", () => {
			expect(emitSchemaType(zm.undefined())).toBe("undefined")
		})

		it("null", () => {
			expect(emitSchemaType(zm.null())).toBe("null")
		})

		it("unknown", () => {
			expect(emitSchemaType(zm.unknown())).toBe("unknown")
		})

		it("void", () => {
			expect(emitSchemaType(zm.void())).toBe("void")
		})

		it("bigint", () => {
			expect(emitSchemaType(zm.bigint())).toBe("bigint")
		})
	})

	describe("literals and enums", () => {
		it("string literal", () => {
			expect(emitSchemaType(zm.literal("hello"))).toBe('"hello"')
		})

		it("number literal", () => {
			expect(emitSchemaType(zm.literal(42))).toBe("42")
		})

		it("boolean literal", () => {
			expect(emitSchemaType(zm.literal(true))).toBe("true")
		})

		it("string enum", () => {
			expect(emitSchemaType(zm.enum(["a", "b", "c"]))).toBe('"a" | "b" | "c"')
		})
	})

	describe("objects", () => {
		it("flat object", () => {
			const schema = zm.object({ age: zm.number(), name: zm.string() })
			expect(emitSchemaType(schema)).toBe("{ age: number; name: string }")
		})

		it("nested object", () => {
			const schema = zm.object({
				user: zm.object({ active: zm.boolean(), id: zm.string() }),
			})
			expect(emitSchemaType(schema)).toBe("{ user: { active: boolean; id: string } }")
		})

		it("empty object", () => {
			expect(emitSchemaType(zm.object({}))).toBe("{}")
		})
	})

	describe("arrays", () => {
		it("string array", () => {
			expect(emitSchemaType(zm.array(zm.string()))).toBe("string[]")
		})

		it("object array", () => {
			const schema = zm.array(zm.object({ id: zm.string() }))
			expect(emitSchemaType(schema)).toBe("{ id: string }[]")
		})
	})

	describe("optionals and nullables", () => {
		it("optional", () => {
			expect(emitSchemaType(zm.optional(zm.string()))).toBe("string | undefined")
		})

		it("nullable", () => {
			expect(emitSchemaType(zm.nullable(zm.string()))).toBe("string | null")
		})
	})

	describe("unions and intersections", () => {
		it("union", () => {
			const schema = zm.union([zm.string(), zm.number()])
			expect(emitSchemaType(schema)).toBe("string | number")
		})

		it("intersection", () => {
			const schema = zm.intersection(zm.object({ a: zm.string() }), zm.object({ b: zm.number() }))
			expect(emitSchemaType(schema)).toBe("{ a: string } & { b: number }")
		})
	})

	describe("records and tuples", () => {
		it("record", () => {
			expect(emitSchemaType(zm.record(zm.string(), zm.number()))).toBe(
				"Partial<Record<string, number>>",
			)
		})

		it("tuple", () => {
			const schema = zm.tuple([zm.string(), zm.number(), zm.boolean()])
			expect(emitSchemaType(schema)).toBe("[string, number, boolean]")
		})
	})
})

describe("zod mini — OpenAPI JSON Schema", () => {
	it("input object → proper JSON Schema", async () => {
		const h = honey<{}>()
		h.post("/items")
			.input({ json: zm.object({ age: zm.number(), name: zm.string() }) })
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

	it("output → response with JSON Schema", async () => {
		const h = honey<{}>()
		h.get("/items")
			.output({ "application/json": { ok: zm.object({ count: zm.number(), id: zm.string() }) } })
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

	it("search → query parameters", async () => {
		const h = honey<{}>()
		h.get("/items")
			.input({ search: zm.object({ limit: zm.number(), page: zm.number() }) })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.get as Record<string, unknown>
		const params = op.parameters as Array<Record<string, unknown>>
		const pageParam = params.find((p) => p.name === "page")
		expect(pageParam?.in).toBe("query")
		expect(pageParam?.schema).toEqual({ type: "number" })
	})
})

describe("zod mini — generateTypes", () => {
	it("emits proper TS types", () => {
		const h = honey<{}>()
		h.post("/items")
			.input({ json: zm.object({ name: zm.string() }) })
			.output({ "application/json": { ok: zm.object({ id: zm.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: "1" }))

		const types = generateTypes(h, { appExport: "app", appImport: "./app" })
		expect(types).toContain("name: string")
		expect(types).toContain("ok: { id: string }")
	})
})
