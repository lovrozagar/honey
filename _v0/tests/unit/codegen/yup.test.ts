import { describe, expect, it } from "vitest"
import * as yup from "yup"
import { generateOpenApi, generateTypes } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"
import { emitSchemaType } from "../../../src/type-emitter.ts"
import { resolveSchema } from "./_resolve-schema.ts"

describe("yup — type emission", () => {
	describe("primitives", () => {
		it("string", () => {
			expect(emitSchemaType(yup.string().required())).toBe("string")
		})

		it("number", () => {
			expect(emitSchemaType(yup.number().required())).toBe("number")
		})

		it("boolean", () => {
			expect(emitSchemaType(yup.boolean().required())).toBe("boolean")
		})

		it("date", () => {
			expect(emitSchemaType(yup.date().required())).toBe("Date")
		})
	})

	describe("objects", () => {
		it("flat object", () => {
			const schema = yup.object({ age: yup.number().required(), name: yup.string().required() })
			expect(emitSchemaType(schema)).toBe("{ age: number; name: string }")
		})

		it("nested object", () => {
			const schema = yup.object({
				user: yup.object({ active: yup.boolean().required(), id: yup.string().required() }),
			})
			expect(emitSchemaType(schema)).toBe("{ user?: { active: boolean; id: string } }")
		})

		it("empty object", () => {
			expect(emitSchemaType(yup.object({}))).toBe("{}")
		})

		it("optional fields", () => {
			const schema = yup.object({ age: yup.number(), name: yup.string().required() })
			expect(emitSchemaType(schema)).toBe("{ age?: number; name: string }")
		})
	})

	describe("arrays", () => {
		it("string array", () => {
			expect(emitSchemaType(yup.array().of(yup.string()))).toBe("string[]")
		})

		it("object array", () => {
			const schema = yup.array().of(yup.object({ id: yup.string().required() }))
			expect(emitSchemaType(schema)).toBe("{ id: string }[]")
		})
	})

	describe("nullable", () => {
		it("nullable string", () => {
			/* yup: .required().nullable() — order matters */
			expect(emitSchemaType(yup.string().required().nullable())).toBe("string | null")
		})
	})

	describe("tuple", () => {
		it("string + number tuple", () => {
			const schema = yup.tuple([yup.string().required(), yup.number().required()])
			expect(emitSchemaType(schema)).toBe("[string, number]")
		})
	})

	describe("mixed with oneOf", () => {
		it("string enum via oneOf", () => {
			const schema = yup.mixed().oneOf(["a", "b", "c"])
			expect(emitSchemaType(schema)).toBe('"a" | "b" | "c"')
		})
	})
})

describe("yup — OpenAPI JSON Schema", () => {
	it("input object → proper JSON Schema", async () => {
		const h = honey<{}>()
		h.post("/items")
			.input({ json: yup.object({ age: yup.number().required(), name: yup.string().required() }) })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.post as Record<string, unknown>
		const body = op.requestBody as Record<string, unknown>
		const content = body.content as Record<string, Record<string, unknown>>
		const schema = resolveSchema(spec, content["application/json"].schema as Record<string, unknown>)
		expect(schema?.type).toBe("object")
		expect(schema?.properties).toBeDefined()
		const props = schema?.properties as Record<string, Record<string, string>>
		expect(props.name.type).toBe("string")
		expect(props.age.type).toBe("number")
	})

	it("search → query parameters", async () => {
		const h = honey<{}>()
		h.get("/items")
			.input({
				search: yup.object({ limit: yup.number().required(), page: yup.number().required() }),
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
					ok: yup.object({ count: yup.number().required(), id: yup.string().required() }),
				},
			})
			.handler((ctx) => ctx.res.json("ok", { count: 0, id: "1" }))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.get as Record<string, unknown>
		const responses = op.responses as Record<string, Record<string, unknown>>
		const content = responses["200"].content as Record<string, Record<string, unknown>>
		const schema = resolveSchema(spec, content["application/json"].schema as Record<string, unknown>)
		expect(schema?.type).toBe("object")
		const props = schema?.properties as Record<string, Record<string, string>>
		expect(props.id.type).toBe("string")
		expect(props.count.type).toBe("number")
	})

	it("nullable field → anyOf with null", async () => {
		const h = honey<{}>()
		h.post("/items")
			.input({ json: yup.object({ name: yup.string().required().nullable() }) })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.post as Record<string, unknown>
		const body = op.requestBody as Record<string, unknown>
		const content = body.content as Record<string, Record<string, unknown>>
		const schema = resolveSchema(spec, content["application/json"].schema as Record<string, unknown>)
		const props = schema?.properties as Record<string, unknown>
		const nameProp = props.name as Record<string, unknown>
		expect(nameProp.anyOf).toEqual([{ type: "string" }, { type: "null" }])
	})
})

describe("yup — generateTypes", () => {
	it("emits proper TS types", () => {
		const h = honey<{}>()
		h.post("/items")
			.input({ json: yup.object({ name: yup.string().required() }) })
			.output({ "application/json": { ok: yup.object({ id: yup.string().required() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: "1" }))

		const types = generateTypes(h, { appExport: "app", appImport: "./app" })
		expect(types).toContain("name: string")
		expect(types).toContain("ok: { id: string }")
	})
})
