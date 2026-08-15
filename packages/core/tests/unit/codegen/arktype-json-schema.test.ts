import { type } from "arktype"
import { describe, expect, it } from "vitest"
import { generateOpenApi } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"
import { resolveSchema } from "./_resolve-schema.ts"

type JsonSchema = Record<string, unknown>
type OpenApiOp = Record<string, unknown>
type OpenApiSpec = { components?: { schemas?: Record<string, JsonSchema> } }

function extractInputSchema(spec: OpenApiSpec, op: OpenApiOp): JsonSchema {
	const body = op.requestBody as Record<string, unknown>
	const content = body.content as Record<string, Record<string, unknown>>
	return resolveSchema(spec, content["application/json"].schema as JsonSchema) ?? {}
}

function extractOutputSchema(spec: OpenApiSpec, op: OpenApiOp, status = "200"): JsonSchema {
	const responses = op.responses as Record<string, Record<string, unknown>>
	const content = responses[status].content as Record<string, Record<string, unknown>>
	return resolveSchema(spec, content["application/json"].schema as JsonSchema) ?? {}
}

describe("arktype JSON Schema via OpenAPI generation", () => {
	describe("primitive types", () => {
		it("type('string') produces {type: 'string'}", async () => {
			const h = honey<{}>()
			h.post("/test")
				.input({ json: type({ value: "string" }) })
				.handler((ctx) => ctx.res.text("ok", "ok"))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const schema = extractInputSchema(spec, spec.paths["/test"].post as OpenApiOp)
			const props = schema.properties as Record<string, JsonSchema>
			expect(props.value.type).toBe("string")
		})

		it("type('number') produces {type: 'number'}", async () => {
			const h = honey<{}>()
			h.post("/test")
				.input({ json: type({ value: "number" }) })
				.handler((ctx) => ctx.res.text("ok", "ok"))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const schema = extractInputSchema(spec, spec.paths["/test"].post as OpenApiOp)
			const props = schema.properties as Record<string, JsonSchema>
			expect(props.value.type).toBe("number")
		})

		it("type('boolean') produces {type: 'boolean'}", async () => {
			const h = honey<{}>()
			h.post("/test")
				.input({ json: type({ value: "boolean" }) })
				.handler((ctx) => ctx.res.text("ok", "ok"))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const schema = extractInputSchema(spec, spec.paths["/test"].post as OpenApiOp)
			const props = schema.properties as Record<string, JsonSchema>
			expect(props.value.type).toBe("boolean")
		})

		it("type('null') produces {type: 'null'}", async () => {
			const h = honey<{}>()
			h.post("/test")
				.input({ json: type({ value: "null" }) })
				.handler((ctx) => ctx.res.text("ok", "ok"))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const schema = extractInputSchema(spec, spec.paths["/test"].post as OpenApiOp)
			const props = schema.properties as Record<string, JsonSchema>
			expect(props.value.type).toBe("null")
		})
	})

	describe("literal types", () => {
		it("type(\"'hello'\") produces const: 'hello'", async () => {
			const h = honey<{}>()
			h.post("/test")
				.output({ "application/json": { ok: type({ tag: "'hello'" }) } })
				.handler((ctx) => ctx.res.json("ok", { tag: "hello" as const }))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const schema = extractOutputSchema(spec, spec.paths["/test"].post as OpenApiOp)
			const props = schema.properties as Record<string, JsonSchema>
			expect(props.tag.const).toBe("hello")
		})
	})

	describe("object types", () => {
		it("type({name: 'string', age: 'number'}) produces object with properties and required", async () => {
			const h = honey<{}>()
			h.post("/test")
				.input({ json: type({ age: "number", name: "string" }) })
				.handler((ctx) => ctx.res.text("ok", "ok"))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const schema = extractInputSchema(spec, spec.paths["/test"].post as OpenApiOp)
			expect(schema.type).toBe("object")
			expect(schema.properties).toBeDefined()
			const props = schema.properties as Record<string, JsonSchema>
			expect(props.name.type).toBe("string")
			expect(props.age.type).toBe("number")
			const required = schema.required as string[]
			expect(required).toContain("name")
			expect(required).toContain("age")
		})

		it("optional field excluded from required array", async () => {
			const h = honey<{}>()
			h.post("/test")
				.input({ json: type({ "age?": "number", name: "string" }) })
				.handler((ctx) => ctx.res.text("ok", "ok"))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const schema = extractInputSchema(spec, spec.paths["/test"].post as OpenApiOp)
			expect(schema.type).toBe("object")
			const props = schema.properties as Record<string, JsonSchema>
			expect(props.name.type).toBe("string")
			expect(props.age.type).toBe("number")
			const required = schema.required as string[]
			expect(required).toContain("name")
			expect(required).not.toContain("age")
		})

		it("all-optional object has no required array or empty required", async () => {
			const h = honey<{}>()
			h.post("/test")
				.input({ json: type({ "age?": "number", "name?": "string" }) })
				.handler((ctx) => ctx.res.text("ok", "ok"))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const schema = extractInputSchema(spec, spec.paths["/test"].post as OpenApiOp)
			expect(schema.type).toBe("object")
			const props = schema.properties as Record<string, JsonSchema>
			expect(props.name.type).toBe("string")
			expect(props.age.type).toBe("number")
			/* arktype may omit required or set it to [] */
			const required = schema.required as string[] | undefined
			if (required !== undefined) {
				expect(required).toHaveLength(0)
			}
		})
	})

	describe("nested objects", () => {
		it("nested object produces nested properties", async () => {
			const h = honey<{}>()
			h.post("/test")
				.input({ json: type({ user: { email: "string", name: "string" } }) })
				.handler((ctx) => ctx.res.text("ok", "ok"))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const schema = extractInputSchema(spec, spec.paths["/test"].post as OpenApiOp)
			expect(schema.type).toBe("object")
			const props = schema.properties as Record<string, JsonSchema>
			expect(props.user.type).toBe("object")
			const userProps = (props.user as JsonSchema).properties as Record<string, JsonSchema>
			expect(userProps.name.type).toBe("string")
			expect(userProps.email.type).toBe("string")
			const userRequired = (props.user as JsonSchema).required as string[]
			expect(userRequired).toContain("name")
			expect(userRequired).toContain("email")
		})

		it("deeply nested objects", async () => {
			const h = honey<{}>()
			h.post("/test")
				.input({
					json: type({
						org: {
							address: { city: "string", zip: "string" },
							name: "string",
						},
					}),
				})
				.handler((ctx) => ctx.res.text("ok", "ok"))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const schema = extractInputSchema(spec, spec.paths["/test"].post as OpenApiOp)
			const orgProps = (schema.properties as Record<string, JsonSchema>).org as JsonSchema
			expect(orgProps.type).toBe("object")
			const addressProps = (orgProps.properties as Record<string, JsonSchema>).address as JsonSchema
			expect(addressProps.type).toBe("object")
			const addrFields = addressProps.properties as Record<string, JsonSchema>
			expect(addrFields.city.type).toBe("string")
			expect(addrFields.zip.type).toBe("string")
		})
	})

	describe("array types", () => {
		it("type('string[]') produces array with string items", async () => {
			const h = honey<{}>()
			h.post("/test")
				.output({ "application/json": { ok: type({ tags: "string[]" }) } })
				.handler((ctx) => ctx.res.json("ok", { tags: ["a"] }))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const schema = extractOutputSchema(spec, spec.paths["/test"].post as OpenApiOp)
			const props = schema.properties as Record<string, JsonSchema>
			expect(props.tags.type).toBe("array")
			expect((props.tags as JsonSchema).items).toEqual({ type: "string" })
		})

		it("type({name: 'string'}).array() produces array of objects", async () => {
			const h = honey<{}>()
			h.post("/test")
				.output({ "application/json": { ok: type({ name: "string" }).array() } })
				.handler((ctx) => ctx.res.json("ok", [{ name: "a" }]))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const schema = extractOutputSchema(spec, spec.paths["/test"].post as OpenApiOp)
			expect(schema.type).toBe("array")
			const items = schema.items as JsonSchema
			expect(items.type).toBe("object")
			const itemProps = items.properties as Record<string, JsonSchema>
			expect(itemProps.name.type).toBe("string")
		})
	})

	describe("union types", () => {
		it("type('string | number') produces anyOf", async () => {
			const h = honey<{}>()
			h.post("/test")
				.output({ "application/json": { ok: type({ value: "string | number" }) } })
				.handler((ctx) => ctx.res.json("ok", { value: "hello" }))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const schema = extractOutputSchema(spec, spec.paths["/test"].post as OpenApiOp)
			const props = schema.properties as Record<string, JsonSchema>
			const valueSchema = props.value as JsonSchema
			const anyOf = valueSchema.anyOf as JsonSchema[]
			expect(anyOf).toBeDefined()
			expect(anyOf).toHaveLength(2)
			const types = anyOf.map((s) => s.type)
			expect(types).toContain("string")
			expect(types).toContain("number")
		})

		it("type(\"'a' | 'b' | 'c'\") produces enum", async () => {
			const h = honey<{}>()
			h.post("/test")
				.output({
					"application/json": { ok: type({ status: "'a' | 'b' | 'c'" }) },
				})
				.handler((ctx) => ctx.res.json("ok", { status: "a" as const }))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const schema = extractOutputSchema(spec, spec.paths["/test"].post as OpenApiOp)
			const props = schema.properties as Record<string, JsonSchema>
			const statusSchema = props.status as JsonSchema
			/* arktype produces enum for string literal unions */
			const enumValues = statusSchema.enum as string[]
			expect(enumValues).toBeDefined()
			expect(enumValues).toContain("a")
			expect(enumValues).toContain("b")
			expect(enumValues).toContain("c")
			expect(enumValues).toHaveLength(3)
		})
	})

	describe("top-level schema (not wrapped in object)", () => {
		it("type('string') as standalone input schema", async () => {
			const h = honey<{}>()
			h.post("/test")
				.input({ json: type("string") })
				.handler((ctx) => ctx.res.text("ok", "ok"))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const schema = extractInputSchema(spec, spec.paths["/test"].post as OpenApiOp)
			expect(schema.type).toBe("string")
		})

		it("type('number') as standalone input schema", async () => {
			const h = honey<{}>()
			h.post("/test")
				.input({ json: type("number") })
				.handler((ctx) => ctx.res.text("ok", "ok"))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const schema = extractInputSchema(spec, spec.paths["/test"].post as OpenApiOp)
			expect(schema.type).toBe("number")
		})

		it("type('boolean') as standalone input schema", async () => {
			const h = honey<{}>()
			h.post("/test")
				.input({ json: type("boolean") })
				.handler((ctx) => ctx.res.text("ok", "ok"))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const schema = extractInputSchema(spec, spec.paths["/test"].post as OpenApiOp)
			expect(schema.type).toBe("boolean")
		})

		it("type('null') as standalone input schema", async () => {
			const h = honey<{}>()
			h.post("/test")
				.input({ json: type("null") })
				.handler((ctx) => ctx.res.text("ok", "ok"))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const schema = extractInputSchema(spec, spec.paths["/test"].post as OpenApiOp)
			expect(schema.type).toBe("null")
		})
	})

	describe("$schema field handling", () => {
		it("arktype includes $schema at top level", async () => {
			const h = honey<{}>()
			h.post("/test")
				.input({ json: type({ name: "string" }) })
				.handler((ctx) => ctx.res.text("ok", "ok"))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const schema = extractInputSchema(spec, spec.paths["/test"].post as OpenApiOp)
			/* arktype natively adds $schema — verify it doesn't break OpenAPI */
			expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema")
			expect(schema.type).toBe("object")
		})
	})

	describe("search input decomposition", () => {
		it("arktype search schema decomposes into query parameters", async () => {
			const h = honey<{}>()
			h.get("/items")
				.input({ search: type({ limit: "number", page: "number" }) })
				.handler((ctx) => ctx.res.text("ok", "ok"))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const op = spec.paths["/items"].get as OpenApiOp
			const params = op.parameters as Array<Record<string, unknown>>
			const pageParam = params.find((p) => p.name === "page")
			expect(pageParam?.in).toBe("query")
			expect(pageParam?.schema).toEqual({ type: "number" })
			const limitParam = params.find((p) => p.name === "limit")
			expect(limitParam?.in).toBe("query")
			expect(limitParam?.schema).toEqual({ type: "number" })
		})

		it("optional search field is not marked required in parameters", async () => {
			const h = honey<{}>()
			h.get("/items")
				.input({ search: type({ "limit?": "number", page: "number" }) })
				.handler((ctx) => ctx.res.text("ok", "ok"))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const op = spec.paths["/items"].get as OpenApiOp
			const params = op.parameters as Array<Record<string, unknown>>
			const pageParam = params.find((p) => p.name === "page")
			expect(pageParam?.required).toBe(true)
			const limitParam = params.find((p) => p.name === "limit")
			expect(limitParam?.required).toBe(false)
		})
	})

	describe("output responses", () => {
		it("output schema maps to correct HTTP status code", async () => {
			const h = honey<{}>()
			h.post("/test")
				.output({
					"application/json": {
						created: type({ id: "string" }),
						ok: type({ ids: "string[]" }),
					},
				})
				.handler((ctx) => ctx.res.json("created", { id: "1" }))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const op = spec.paths["/test"].post as OpenApiOp
			const responses = op.responses as Record<string, Record<string, unknown>>
			expect(responses["200"]).toBeDefined()
			expect(responses["201"]).toBeDefined()

			const okSchema = extractOutputSchema(spec, op, "200")
			expect(okSchema.type).toBe("object")
			const okProps = okSchema.properties as Record<string, JsonSchema>
			expect(okProps.ids.type).toBe("array")

			const createdSchema = extractOutputSchema(spec, op, "201")
			expect(createdSchema.type).toBe("object")
			const createdProps = createdSchema.properties as Record<string, JsonSchema>
			expect(createdProps.id.type).toBe("string")
		})
	})
})
