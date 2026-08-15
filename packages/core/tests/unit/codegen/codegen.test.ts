import { type } from "arktype"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import {
	extractSchemas,
	generateManifest,
	generateOpenApi,
	generateTypes,
	normalizeSecurity,
	type OpenApiSpec,
} from "../../../src/codegen.ts"

const hasZodJsonSchema = typeof (z as Record<string, unknown>).toJSONSchema === "function"

import { honey } from "../../../src/index.ts"

/* Resolves a schema that may be a $ref, returning the actual schema object. */
function resolveSchema(spec: OpenApiSpec, schema: Record<string, unknown>): Record<string, unknown> {
	if (typeof schema.$ref !== "string") return schema
	const name = schema.$ref.replace("#/components/schemas/", "")
	return spec.components?.schemas?.[name] ?? schema
}

function makeApp() {
	const h = honey<{}>()
	h.get("/health").handler((ctx) => ctx.res.json("ok", { status: "ok" }))
	h.get("/v1/organizations/:orgId").handler((ctx) => ctx.res.json("ok", {}))
	h.post("/v1/organizations").handler((ctx) => ctx.res.json("created", {}))
	return h
}

describe("generateManifest", () => {
	it("correct route count", () => {
		const manifest = generateManifest(makeApp())
		expect(manifest.routes).toHaveLength(3)
	})

	it("correct methods and paths", () => {
		const manifest = generateManifest(makeApp())
		const keys = manifest.routes.map((r) => `${r.method} ${r.path}`)
		expect(keys).toContain("GET /health")
		expect(keys).toContain("GET /v1/organizations/:orgId")
		expect(keys).toContain("POST /v1/organizations")
	})

	it("params extracted from path pattern", () => {
		const manifest = generateManifest(makeApp())
		const route = manifest.routes.find((r) => r.path.includes(":orgId"))
		expect(route?.params).toContain("orgId")
	})

	it("route with no input/output → empty", () => {
		const manifest = generateManifest(makeApp())
		const route = manifest.routes.find((r) => r.path === "/health")
		expect(route?.input).toBeUndefined()
		expect(route?.output).toBeUndefined()
	})
})

describe("generateOpenApi", () => {
	it("returns object with openapi 3.1.0, info, paths", async () => {
		const spec = await generateOpenApi(makeApp(), { info: { title: "Test API", version: "1.0" } })
		expect(spec.openapi).toBe("3.1.0")
		expect(spec.info.title).toBe("Test API")
		expect(spec.paths).toBeDefined()
	})

	it("paths match registered routes", async () => {
		const spec = await generateOpenApi(makeApp(), { info: { title: "Test", version: "1.0" } })
		expect(spec.paths["/health"]).toBeDefined()
		expect(spec.paths["/v1/organizations/{orgId}"]).toBeDefined()
		expect(spec.paths["/v1/organizations"]).toBeDefined()
	})

	it("methods match registrations", async () => {
		const spec = await generateOpenApi(makeApp(), { info: { title: "Test", version: "1.0" } })
		expect(spec.paths["/health"].get).toBeDefined()
		expect(spec.paths["/v1/organizations"].post).toBeDefined()
	})

	it("path parameters from :param → parameters array", async () => {
		const spec = await generateOpenApi(makeApp(), { info: { title: "Test", version: "1.0" } })
		const orgRoute = spec.paths["/v1/organizations/{orgId}"]?.get as
			| { parameters?: Array<Record<string, unknown>> }
			| undefined
		expect(orgRoute?.parameters).toBeDefined()
		const param = orgRoute?.parameters?.find((p) => p.name === "orgId")
		expect(param?.in).toBe("path")
		expect(param?.required).toBe(true)
	})
})

describe("extractSchemas", () => {
	it("keyed by METHOD /path", () => {
		const schemas = extractSchemas(makeApp())
		expect(schemas["GET /health"]).toBeDefined()
		expect(schemas["POST /v1/organizations"]).toBeDefined()
	})

	it("route with no schemas → empty object", () => {
		const schemas = extractSchemas(makeApp())
		expect(schemas["GET /health"]).toEqual({})
	})
})

describe("manifest schema serialization", () => {
	it("meta stored on route manifest", () => {
		const h = honey<{}>().meta<{ description?: string; tags?: string[] }>()
		h.get("/test")
			.meta({ description: "Test endpoint", tags: ["test"] })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const manifest = generateManifest(h)
		const route = manifest.routes.find((r) => r.path === "/test")
		expect(route?.meta.description).toBe("Test endpoint")
		expect(route?.meta.tags).toEqual(["test"])
	})

	it("input sources listed in manifest", () => {
		const h = honey<{}>()
		h.post("/test")
			.input({
				json: z.object({ name: z.string() }),
				search: z.object({ page: z.number() }),
			})
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const manifest = generateManifest(h)
		const route = manifest.routes.find((r) => r.path === "/test")
		expect(route?.input).toBeDefined()
		expect(Object.keys(route?.input ?? {})).toContain("json")
		expect(Object.keys(route?.input ?? {})).toContain("search")
	})

	it("output content types and status keys in manifest", () => {
		const h = honey<{}>()
		h.get("/test")
			.output({
				"application/json": {
					created: z.object({ id: z.string() }),
					ok: z.object({ items: z.string().array() }),
				},
			})
			.handler((ctx) => ctx.res.json("ok", { items: [] }))

		const manifest = generateManifest(h)
		const route = manifest.routes.find((r) => r.path === "/test")
		expect(route?.output).toBeDefined()
		const jsonOutput = route?.output?.["application/json"] as Record<string, unknown> | undefined
		expect(jsonOutput).toBeDefined()
		expect(Object.keys(jsonOutput ?? {})).toContain("ok")
		expect(Object.keys(jsonOutput ?? {})).toContain("created")
	})

	it("no meta → empty object in manifest", () => {
		const h = honey<{}>()
		h.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const manifest = generateManifest(h)
		const route = manifest.routes.find((r) => r.path === "/test")
		expect(route?.meta).toEqual({})
	})
})

describe("manifest errors aggregation", () => {
	it("manifest has flat errors array with all route error keys", () => {
		const { defineErrors } = require("../../../src/index.ts")
		const errors = defineErrors({
			custom_err: "conflict",
			other_err: "forbidden",
		})

		const h = honey<{}>()
		h.get("/a")
			.errors(errors, "custom_err")
			.handler((ctx) => ctx.res.text("ok", "ok"))
		h.get("/b")
			.errors(errors, "other_err")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const manifest = generateManifest(h)
		expect(manifest.errors).toBeDefined()
		expect(manifest.errors).toBeInstanceOf(Array)

		const errorKeys = manifest.errors.map((e: { errorKey: string }) => e.errorKey)
		expect(errorKeys).toContain("custom_err")
		expect(errorKeys).toContain("other_err")
	})
})

describe("OpenAPI with real schemas", () => {
	it("request body from .input({ json }) → schema in requestBody", async () => {
		const h = honey<{}>()
		h.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.post as Record<string, unknown> | undefined
		expect(op?.requestBody).toBeDefined()
	})

	it.skipIf(!hasZodJsonSchema)("request body contains real JSON Schema", async () => {
		const h = honey<{}>()
		h.post("/items")
			.input({ json: z.object({ age: z.number(), name: z.string() }) })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.post as Record<string, unknown>
		const body = op.requestBody as Record<string, unknown>
		const content = body.content as Record<string, Record<string, unknown>>
		const schema = resolveSchema(spec, content["application/json"].schema as Record<string, unknown>)
		expect(schema.type).toBe("object")
		expect(schema.properties).toBeDefined()
		const props = schema.properties as Record<string, Record<string, string>>
		expect(props.name.type).toBe("string")
		expect(props.age.type).toBe("number")
	})

	it.skipIf(!hasZodJsonSchema)("search input → query parameters", async () => {
		const h = honey<{}>()
		h.get("/items")
			.input({ search: z.object({ limit: z.number(), page: z.number() }) })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.get as Record<string, unknown>
		const params = op.parameters as Array<Record<string, unknown>>
		const pageParam = params.find((p) => p.name === "page")
		expect(pageParam?.in).toBe("query")
		const limitParam = params.find((p) => p.name === "limit")
		expect(limitParam?.in).toBe("query")
	})

	it("response schemas from .output() → keyed by status code", async () => {
		const h = honey<{}>()
		h.get("/items")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: "1" }))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.get as Record<string, unknown> | undefined
		const responses = op?.responses as Record<string, unknown> | undefined
		expect(responses?.["200"]).toBeDefined()
	})

	it.skipIf(!hasZodJsonSchema)("response schema contains real JSON Schema", async () => {
		const h = honey<{}>()
		h.get("/items")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: "1" }))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.get as Record<string, unknown>
		const responses = op.responses as Record<string, Record<string, unknown>>
		const content = responses["200"].content as Record<string, Record<string, unknown>>
		const schema = resolveSchema(spec, content["application/json"].schema as Record<string, unknown>)
		expect(schema.type).toBe("object")
		const props = schema.properties as Record<string, Record<string, string>>
		expect(props.id.type).toBe("string")
	})

	it("tags and summary from .meta({ openApi })", async () => {
		const h = honey<{}>()
		h.get("/items")
			.meta({ summary: "List items", tags: ["Items"] })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.get as Record<string, unknown> | undefined
		expect(op?.summary).toBe("List items")
		expect(op?.tags).toEqual(["Items"])
	})
})

describe("codegen string escaping", () => {
	it("internal: emitLiteral escapes quotes in meta strings", () => {
		const h = honey<{}>().meta<{ description?: string }>()
		h.get("/test")
			.meta({ description: 'He said "hello"' })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const types = generateTypes(h, {})
		/* generated type must contain properly escaped quote */
		expect(types).toContain('He said \\"hello\\"')
		/* must NOT contain unescaped double quote that breaks TS syntax */
		expect(types).not.toContain('He said "hello"')
	})

	it("internal: emitLiteral escapes backslashes in meta strings", () => {
		const h = honey<{}>().meta<{ path?: string }>()
		h.get("/test")
			.meta({ path: "C:\\Users\\test" })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const types = generateTypes(h, {})
		expect(types).toContain("C:\\\\Users\\\\test")
	})

	it("consumer: meta with special chars produces valid TypeScript", () => {
		const h = honey<{}>().meta<{ note?: string }>()
		h.get("/docs")
			.meta({ note: 'has "quotes" inside' })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const types = generateTypes(h, {})
		/* The meta line must use JSON-safe escaping — no raw " inside the string */
		const metaLine = types.split("\n").find((l) => l.includes("meta:"))
		expect(metaLine).toBeDefined()
		/* extract the string value between the outer quotes of the note field */
		/* valid: note: "has \"quotes\" inside" — the inner quotes are escaped */
		/* invalid: note: "has "quotes" inside" — raw quotes break the string */
		expect(metaLine).toContain('\\"quotes\\"')
	})
})

describe("generateTypes with inlineTapsType", () => {
	it("emits TapMap type alias when inlineTapsType provided", () => {
		const h = honey<{}>()
		h.get("/test").handler((ctx) => ctx.res.json("ok", {}))

		const types = generateTypes(h, {
			inlineTapsType: '{ audit: { action: "create" | "delete"; resource: string } }',
		})

		expect(types).toContain("type TapMap =")
		expect(types).toContain('"create"')
		expect(types).toContain('"delete"')
		expect(types).not.toContain("Omit<HoneyContext")
	})

	it("does not emit TapMap when inlineTapsType is null", () => {
		const h = honey<{}>()
		h.get("/test").handler((ctx) => ctx.res.json("ok", {}))

		const types = generateTypes(h, { inlineTapsType: null })

		expect(types).not.toContain("TapMap")
		expect(types).not.toContain("tap<K")
	})

	it("does not emit TapMap when inlineTapsType is undefined", () => {
		const h = honey<{}>()
		h.get("/test").handler((ctx) => ctx.res.json("ok", {}))

		const types = generateTypes(h, {})

		expect(types).not.toContain("TapMap")
		expect(types).not.toContain("tap<K")
	})
})

describe("extractSchemas with real data", () => {
	it("input schemas have structure", () => {
		const h = honey<{}>()
		h.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const schemas = extractSchemas(h)
		const route = schemas["POST /items"] as Record<string, Record<string, unknown>>
		expect(route.input).toBeDefined()
		expect(route.input.json).toBeDefined()
	})

	it("output schemas have content-type dimension", () => {
		const h = honey<{}>()
		h.get("/items")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: "1" }))

		const schemas = extractSchemas(h)
		const route = schemas["GET /items"] as Record<string, Record<string, unknown>>
		expect(route.output).toBeDefined()
		expect(route.output["application/json"]).toBeDefined()
	})
})

/* ---- Valibot OpenAPI ---- */

describe("OpenAPI with valibot schemas", () => {
	it("request body contains real JSON Schema from valibot input", async () => {
		const h = honey<{}>()
		h.post("/items")
			.input({ json: v.object({ age: v.number(), name: v.string() }) })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.post as Record<string, unknown>
		const body = op.requestBody as Record<string, unknown>
		const content = body.content as Record<string, Record<string, unknown>>
		const schema = resolveSchema(spec, content["application/json"].schema as Record<string, unknown>)
		expect(schema.type).toBe("object")
		expect(schema.properties).toBeDefined()
		const props = schema.properties as Record<string, Record<string, string>>
		expect(props.name.type).toBe("string")
		expect(props.age.type).toBe("number")
	})

	it("valibot search input → query parameters with proper schema", async () => {
		const h = honey<{}>()
		h.get("/items")
			.input({ search: v.object({ limit: v.number(), page: v.number() }) })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.get as Record<string, unknown>
		const params = op.parameters as Array<Record<string, unknown>>
		const pageParam = params.find((p) => p.name === "page")
		expect(pageParam?.in).toBe("query")
		expect(pageParam?.schema).toEqual({ type: "number" })
	})

	it("valibot output → response with real JSON Schema", async () => {
		const h = honey<{}>()
		h.get("/items")
			.output({ "application/json": { ok: v.object({ count: v.number(), id: v.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { count: 0, id: "1" }))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.get as Record<string, unknown>
		const responses = op.responses as Record<string, Record<string, unknown>>
		const content = responses["200"].content as Record<string, Record<string, unknown>>
		const schema = resolveSchema(spec, content["application/json"].schema as Record<string, unknown>)
		expect(schema.type).toBe("object")
		const props = schema.properties as Record<string, Record<string, string>>
		expect(props.id.type).toBe("string")
		expect(props.count.type).toBe("number")
	})
})

/* ---- ArkType OpenAPI ---- */

describe("OpenAPI with arktype schemas", () => {
	it("request body contains real JSON Schema from arktype input", async () => {
		const h = honey<{}>()
		h.post("/items")
			.input({ json: type({ age: "number", name: "string" }) })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.post as Record<string, unknown>
		const body = op.requestBody as Record<string, unknown>
		const content = body.content as Record<string, Record<string, unknown>>
		const schema = resolveSchema(spec, content["application/json"].schema as Record<string, unknown>)
		expect(schema.type).toBe("object")
		expect(schema.properties).toBeDefined()
		const props = schema.properties as Record<string, Record<string, string>>
		expect(props.name.type).toBe("string")
		expect(props.age.type).toBe("number")
	})

	it("arktype search input → query parameters with proper schema", async () => {
		const h = honey<{}>()
		h.get("/items")
			.input({ search: type({ limit: "number", page: "number" }) })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.get as Record<string, unknown>
		const params = op.parameters as Array<Record<string, unknown>>
		const pageParam = params.find((p) => p.name === "page")
		expect(pageParam?.in).toBe("query")
		expect(pageParam?.schema).toEqual({ type: "number" })
	})

	it("arktype output → response with real JSON Schema", async () => {
		const h = honey<{}>()
		h.get("/items")
			.output({ "application/json": { ok: type({ count: "number", id: "string" }) } })
			.handler((ctx) => ctx.res.json("ok", { count: 0, id: "1" }))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.get as Record<string, unknown>
		const responses = op.responses as Record<string, Record<string, unknown>>
		const content = responses["200"].content as Record<string, Record<string, unknown>>
		const schema = resolveSchema(spec, content["application/json"].schema as Record<string, unknown>)
		expect(schema.type).toBe("object")
		const props = schema.properties as Record<string, Record<string, string>>
		expect(props.id.type).toBe("string")
		expect(props.count.type).toBe("number")
	})
})

/* ---- generateTypes with valibot and arktype ---- */

describe("generateTypes with valibot schemas", () => {
	it("emits proper TS types for valibot input", () => {
		const h = honey<{}>()
		h.post("/items")
			.input({ json: v.object({ age: v.number(), name: v.string() }) })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const types = generateTypes(h, {})
		expect(types).toContain("name: string")
		expect(types).toContain("age: number")
	})

	it("emits proper TS types for valibot output", () => {
		const h = honey<{}>()
		h.get("/items")
			.output({ "application/json": { ok: v.object({ id: v.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: "1" }))

		const types = generateTypes(h, {})
		expect(types).toContain("id: string")
		/* output line should not contain "unknown" — but HoneyContext<Record<string, unknown>> is fine */
		expect(types).toContain("ok: { id: string }")
	})
})

describe("generateTypes with arktype schemas", () => {
	it("emits proper TS types for arktype input", () => {
		const h = honey<{}>()
		h.post("/items")
			.input({ json: type({ age: "number", name: "string" }) })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const types = generateTypes(h, {})
		expect(types).toContain("name: string")
		expect(types).toContain("age: number")
	})

	it("emits proper TS types for arktype output", () => {
		const h = honey<{}>()
		h.get("/items")
			.output({ "application/json": { ok: type({ id: "string" }) } })
			.handler((ctx) => ctx.res.json("ok", { id: "1" }))

		const types = generateTypes(h, {})
		expect(types).toContain("id: string")
	})
})

/* ---- Mixed vendor ---- */

describe("mixed vendor schemas", () => {
	it.skipIf(!hasZodJsonSchema)(
		"app with zod input + valibot output produces valid OpenAPI",
		async () => {
			const h = honey<{}>()
			h.post("/items")
				.input({ json: z.object({ name: z.string() }) })
				.output({ "application/json": { ok: v.object({ id: v.string(), name: v.string() }) } })
				.handler((ctx) => ctx.res.json("ok", { id: "1", name: "test" }))

			const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
			const op = spec.paths["/items"]?.post as Record<string, unknown>
			/* input: zod JSON Schema */
			const body = op.requestBody as Record<string, unknown>
			const bodyContent = body.content as Record<string, Record<string, unknown>>
			const inputSchema = resolveSchema(spec, bodyContent["application/json"].schema as Record<string, unknown>)
			expect(inputSchema.type).toBe("object")
			/* output: valibot JSON Schema */
			const responses = op.responses as Record<string, Record<string, unknown>>
			const outContent = responses["200"].content as Record<string, Record<string, unknown>>
			const outputSchema = resolveSchema(spec, outContent["application/json"].schema as Record<string, unknown>)
			expect(outputSchema.type).toBe("object")
			const outProps = outputSchema.properties as Record<string, Record<string, string>>
			expect(outProps.id.type).toBe("string")
		},
	)

	it("generateTypes with mixed vendors emits proper types", () => {
		const h = honey<{}>()
		h.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.output({ "application/json": { ok: v.object({ id: v.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: "1" }))

		const types = generateTypes(h, {})
		/* input from zod */
		expect(types).toContain("name: string")
		/* output from valibot */
		expect(types).toContain("id: string")
		/* no "unknown" for either */
		expect(types).not.toMatch(/input:.*unknown/)
		expect(types).not.toMatch(/output:.*unknown/)
	})
})

/* ---- securitySchemes ---- */

describe("OpenAPI securitySchemes", () => {
	it("securitySchemes option emits components.securitySchemes in spec", async () => {
		const h = honey<{}>()
		h.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, {
			info: { title: "T", version: "1" },
			securitySchemes: {
				bearerAuth: { bearerFormat: "JWT", scheme: "bearer", type: "http" },
			},
		})
		const components = (spec as Record<string, unknown>).components as Record<string, unknown>
		expect(components).toBeDefined()
		expect(components.securitySchemes).toEqual({
			bearerAuth: { bearerFormat: "JWT", scheme: "bearer", type: "http" },
		})
	})

	it("no securitySchemes option omits components", async () => {
		const h = honey<{}>()
		h.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		expect((spec as Record<string, unknown>).components).toBeUndefined()
	})

	it("per-route security with full OpenAPI syntax", async () => {
		const h = honey<{}>()
		h.get("/secure")
			.meta({ security: [{ bearerAuth: [] }] })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, {
			info: { title: "T", version: "1" },
			securitySchemes: {
				bearerAuth: { bearerFormat: "JWT", scheme: "bearer", type: "http" },
			},
		})
		const op = spec.paths["/secure"]?.get as Record<string, unknown>
		expect(op.security).toEqual([{ bearerAuth: [] }])
	})

	it("per-route security with string shorthand", async () => {
		const h = honey<{}>()
		h.get("/secure")
			.meta({ security: "bearerAuth" })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, {
			info: { title: "T", version: "1" },
			securitySchemes: {
				bearerAuth: { bearerFormat: "JWT", scheme: "bearer", type: "http" },
			},
		})
		const op = spec.paths["/secure"]?.get as Record<string, unknown>
		expect(op.security).toEqual([{ bearerAuth: [] }])
	})

	it("per-route security with string array shorthand (OR)", async () => {
		const h = honey<{}>()
		h.get("/secure")
			.meta({ security: ["bearerAuth", "apiKey"] })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, {
			info: { title: "T", version: "1" },
			securitySchemes: {
				apiKey: { in: "header", name: "X-API-Key", type: "apiKey" },
				bearerAuth: { bearerFormat: "JWT", scheme: "bearer", type: "http" },
			},
		})
		const op = spec.paths["/secure"]?.get as Record<string, unknown>
		expect(op.security).toEqual([{ bearerAuth: [] }, { apiKey: [] }])
	})
})

/* ---- route-level filter ---- */

describe("OpenAPI route-level filter", () => {
	it("filter excludes routes where callback returns false", async () => {
		const h = honey<{}>().meta<{ auth?: false | string }>()
		h.get("/public")
			.meta({ auth: false })
			.handler((ctx) => ctx.res.text("ok", "ok"))
		h.get("/dashboard")
			.meta({ auth: "jwt" })
			.handler((ctx) => ctx.res.text("ok", "ok"))
		h.get("/api")
			.meta({ auth: "api_key" })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, {
			filterRoutes: (route) => (route.meta as Record<string, unknown>)?.auth !== "jwt",
			info: { title: "T", version: "1" },
		})
		expect(spec.paths["/public"]).toBeDefined()
		expect(spec.paths["/api"]).toBeDefined()
		expect(spec.paths["/dashboard"]).toBeUndefined()
	})

	it("no filter includes all routes", async () => {
		const h = honey<{}>().meta<{ auth?: false | string }>()
		h.get("/public")
			.meta({ auth: false })
			.handler((ctx) => ctx.res.text("ok", "ok"))
		h.get("/dashboard")
			.meta({ auth: "jwt" })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, {
			info: { title: "T", version: "1" },
		})
		expect(spec.paths["/public"]).toBeDefined()
		expect(spec.paths["/dashboard"]).toBeDefined()
	})
})

/* ---- x-internal field filtering ---- */

describe("OpenAPI x-internal field filtering", () => {
	it.skipIf(!hasZodJsonSchema)("json body properties with x-internal are stripped from request body schema", async () => {
		const h = honey<{}>()
		h.post("/login")
			.input({
				json: z.object({
					email: z.email(),
					internal_trace: z.string().optional().meta({ "x-internal": true }),
				}),
			})
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/login"]?.post as Record<string, unknown>
		const body = op.requestBody as Record<string, unknown>
		const content = body.content as Record<string, Record<string, unknown>>
		const schema = resolveSchema(spec, content["application/json"].schema as Record<string, unknown>)
		const props = schema.properties as Record<string, unknown>
		expect(props.email).toBeDefined()
		expect(props.internal_trace).toBeUndefined()
	})

	it.skipIf(!hasZodJsonSchema)("query params with x-internal are excluded from parameters", async () => {
		const h = honey<{}>()
		h.get("/items")
			.input({
				search: z.object({
					limit: z.number(),
					trace_id: z.string().optional().meta({ "x-internal": true }),
				}),
			})
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.get as Record<string, unknown>
		const params = op.parameters as Array<Record<string, unknown>>
		const paramNames = params.map((p) => p.name)
		expect(paramNames).toContain("limit")
		expect(paramNames).not.toContain("trace_id")
	})

	it.skipIf(!hasZodJsonSchema)("header fields with x-internal are excluded from parameters", async () => {
		const h = honey<{}>()
		h.post("/login")
			.input({
				headers: z.object({
					"cf-connecting-ip": z.string().optional().meta({ "x-internal": true }),
					"user-agent": z.string().optional().meta({ "x-internal": true }),
				}),
				json: z.object({ email: z.email(), password: z.string() }),
			})
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(h, { info: { title: "T", version: "1" } })
		const op = spec.paths["/login"]?.post as Record<string, unknown>
		const params = (op.parameters ?? []) as Array<Record<string, unknown>>
		const paramNames = params.map((p) => p.name)
		expect(paramNames).not.toContain("cf-connecting-ip")
		expect(paramNames).not.toContain("user-agent")
	})
})

describe("normalizeSecurity", () => {
	it("string returns single AND group", () => {
		expect(normalizeSecurity("jwt")).toEqual([{ jwt: [] }])
	})

	it("empty string array returns empty", () => {
		expect(normalizeSecurity([])).toEqual([])
	})

	it("string array returns OR of single-scheme alternatives", () => {
		expect(normalizeSecurity(["jwt", "apiKey"])).toEqual([{ jwt: [] }, { apiKey: [] }])
	})

	it("single nested string array returns single AND group", () => {
		expect(normalizeSecurity([["iaKey", "iaDomain", "iaActor"]])).toEqual([
			{ iaActor: [], iaDomain: [], iaKey: [] },
		])
	})

	it("multiple nested string arrays return OR-of-AND", () => {
		expect(normalizeSecurity([["iaKey", "iaDomain"], ["jwt"]])).toEqual([
			{ iaDomain: [], iaKey: [] },
			{ jwt: [] },
		])
	})

	it("legacy object array passthrough", () => {
		expect(normalizeSecurity([{ jwt: [] }, { apiKey: ["read", "write"] }])).toEqual([
			{ jwt: [] },
			{ apiKey: ["read", "write"] },
		])
	})

	it("mixed string and nested array falls to empty", () => {
		expect(normalizeSecurity(["jwt", ["iaKey", "iaDomain"]])).toEqual([])
	})

	it("single empty nested array returns single empty AND group", () => {
		expect(normalizeSecurity([[]])).toEqual([{}])
	})

	it("nested array mixed with object falls to empty", () => {
		expect(normalizeSecurity([{ jwt: [] }, ["iaKey"]])).toEqual([])
	})

	it("non-array non-string primitives return empty", () => {
		expect(normalizeSecurity(null)).toEqual([])
		expect(normalizeSecurity(undefined)).toEqual([])
		expect(normalizeSecurity(42)).toEqual([])
		expect(normalizeSecurity({})).toEqual([])
	})
})
