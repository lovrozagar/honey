import { describe, expect, it } from "vitest"
import * as z from "zod"
import { generateOpenApi } from "../../../src/codegen.ts"
import { defineErrors, honey } from "../../../src/index.ts"
import { resolveSchema } from "./_resolve-schema.ts"

const hasZodJsonSchema = typeof (z as Record<string, unknown>).toJSONSchema === "function"

/* helper: extract error response schema from OpenAPI spec for a given status code */
function getErrorSchema(
	spec: Awaited<ReturnType<typeof generateOpenApi>>,
	path: string,
	method: string,
	statusCode: string,
): Record<string, unknown> | undefined {
	const op = spec.paths[path]?.[method] as Record<string, unknown> | undefined
	if (!op) return undefined
	const responses = op.responses as Record<string, Record<string, unknown>> | undefined
	if (!responses?.[statusCode]) return undefined
	const content = responses[statusCode].content as Record<string, Record<string, unknown>> | undefined
	return resolveSchema(spec, content?.["application/json"]?.schema as Record<string, unknown> | undefined)
}

describe("OpenAPI error schema — default shape", () => {
	it("error response includes fields and status_key (not just error_key/message/status/success)", async () => {
		const errors = defineErrors({ item_not_found: "not_found" })
		const app = honey<{}>().errorFactory(errors)
		app
			.get("/items/:id")
			.errors("item_not_found")
			.handler((ctx) => ctx.res.json("ok", {}))

		const spec = await generateOpenApi(app, {
			info: { title: "T", version: "1" },
		})
		const schema = getErrorSchema(spec, "/items/{id}", "get", "404")

		expect(schema).toBeDefined()
		const props = schema?.properties as Record<string, unknown>
		expect(props.error_key).toBeDefined()
		expect(props.message).toBeDefined()
		expect(props.status).toBeDefined()
		expect(props.success).toBeDefined()
		/* these are new — currently missing from codegen */
		expect(props.fields).toBeDefined()
		expect(props.status_key).toBeDefined()
	})

	it("default error schema required array includes all default fields", async () => {
		const errors = defineErrors({ bad_input: "bad_request" })
		const app = honey<{}>().errorFactory(errors)
		app
			.post("/items")
			.errors("bad_input")
			.handler((ctx) => ctx.res.json("ok", {}))

		const spec = await generateOpenApi(app, {
			info: { title: "T", version: "1" },
		})
		const schema = getErrorSchema(spec, "/items", "post", "400")

		const required = schema?.required as string[]
		expect(required).toContain("error_key")
		expect(required).toContain("status")
		expect(required).toContain("success")
		expect(required).toContain("fields")
		expect(required).toContain("message")
		expect(required).toContain("status_key")
	})
})

describe("OpenAPI error schema — custom via errorFormatter(schema, mapper)", () => {
	it.skipIf(!hasZodJsonSchema)("custom zod error schema replaces default in OpenAPI output", async () => {
		const errors = defineErrors({ unauthorized: "unauthorized" })

		const customSchema = z.object({
			code: z.string(),
			message: z.string(),
			ok: z.literal(false),
		})

		const app = honey<{}>()
			.errorFactory(errors)
			.defaultErrorFormatter(customSchema, (error) => ({
				code: error.errorKey,
				message: error.message,
				ok: false as const,
			}))

		app
			.get("/secret")
			.errors("unauthorized")
			.handler((ctx) => ctx.res.json("ok", {}))

		const spec = await generateOpenApi(app, {
			info: { title: "T", version: "1" },
		})
		const schema = getErrorSchema(spec, "/secret", "get", "401")

		expect(schema).toBeDefined()
		const props = schema?.properties as Record<string, unknown>
		/* custom schema fields present */
		expect(props.code).toBeDefined()
		expect(props.message).toBeDefined()
		expect(props.ok).toBeDefined()
		/* default fields NOT present */
		expect(props.error_key).toBeUndefined()
		expect(props.fields).toBeUndefined()
		expect(props.status_key).toBeUndefined()
	})

	it.skipIf(!hasZodJsonSchema)("enum injection patches error_key property when present in custom schema", async () => {
		const errors = defineErrors({
			email_taken: "conflict",
			org_limit: "conflict",
		})

		const customSchema = z.object({
			error_key: z.string(),
			message: z.string(),
			status: z.number().int(),
			success: z.literal(false),
		})

		const app = honey<{}>()
			.errorFactory(errors)
			.defaultErrorFormatter(customSchema, (error) => ({
				error_key: error.errorKey,
				message: error.message,
				status: error.status,
				success: false as const,
			}))

		app
			.post("/orgs")
			.errors("email_taken", "org_limit")
			.handler((ctx) => ctx.res.json("ok", {}))

		const spec = await generateOpenApi(app, {
			info: { title: "T", version: "1" },
		})
		const schema = getErrorSchema(spec, "/orgs", "post", "409")

		expect(schema).toBeDefined()
		const props = schema?.properties as Record<string, Record<string, unknown>>
		/* error_key should be patched with enum */
		expect(props.error_key.enum).toBeDefined()
		const enumValues = props.error_key.enum as string[]
		expect(enumValues).toContain("email_taken")
		expect(enumValues).toContain("org_limit")
		/* status should be patched with enum */
		expect(props.status.enum).toEqual([409])
	})

	it.skipIf(!hasZodJsonSchema)("custom schema without error_key/status skips enum injection", async () => {
		const errors = defineErrors({ bad_input: "bad_request" })

		const customSchema = z.object({
			code: z.string(),
			msg: z.string(),
			ok: z.literal(false),
		})

		const app = honey<{}>()
			.errorFactory(errors)
			.defaultErrorFormatter(customSchema, (error) => ({
				code: error.errorKey,
				msg: error.message,
				ok: false as const,
			}))

		app
			.post("/items")
			.errors("bad_input")
			.handler((ctx) => ctx.res.json("ok", {}))

		const spec = await generateOpenApi(app, {
			info: { title: "T", version: "1" },
		})
		const schema = getErrorSchema(spec, "/items", "post", "400")

		expect(schema).toBeDefined()
		const props = schema?.properties as Record<string, Record<string, unknown>>
		/* code replaces error_key — no enum injection (field name mismatch) */
		expect(props.code).toBeDefined()
		expect(props.code.enum).toBeUndefined()
		/* no error_key or status properties */
		expect(props.error_key).toBeUndefined()
		expect(props.status).toBeUndefined()
	})
})

describe("OpenAPI error schema — fn-only overload (backwards compat)", () => {
	it("fn-only errorFormatter uses default schema in codegen", async () => {
		const errors = defineErrors({ forbidden: "forbidden" })
		const app = honey<{}>()
			.errorFactory(errors)
			.defaultErrorFormatter((_error, defaultShape) => ({
				...defaultShape,
				timestamp: Date.now(),
			}))

		app
			.get("/admin")
			.errors("forbidden")
			.handler((ctx) => ctx.res.json("ok", {}))

		const spec = await generateOpenApi(app, {
			info: { title: "T", version: "1" },
		})
		const schema = getErrorSchema(spec, "/admin", "get", "403")

		expect(schema).toBeDefined()
		const props = schema?.properties as Record<string, unknown>
		/* default schema — no custom shape */
		expect(props.error_key).toBeDefined()
		expect(props.fields).toBeDefined()
		expect(props.status_key).toBeDefined()
		/* timestamp NOT in schema (fn-only overload, codegen can't introspect it) */
		expect(props.timestamp).toBeUndefined()
	})
})

describe("OpenAPI error schema — propagation", () => {
	it.skipIf(!hasZodJsonSchema)("errorFormatter schema propagates through basePath()", async () => {
		const errors = defineErrors({ not_found: "not_found" })

		const customSchema = z.object({
			code: z.string(),
			ok: z.literal(false),
		})

		const app = honey<{}>()
			.errorFactory(errors)
			.defaultErrorFormatter(customSchema, (error) => ({
				code: error.errorKey,
				ok: false as const,
			}))
			.basePath("/api/v1")

		app
			.get("/items")
			.errors("not_found")
			.handler((ctx) => ctx.res.json("ok", {}))

		const spec = await generateOpenApi(app, {
			info: { title: "T", version: "1" },
		})
		const schema = getErrorSchema(spec, "/api/v1/items", "get", "404")

		expect(schema).toBeDefined()
		const props = schema?.properties as Record<string, unknown>
		expect(props.code).toBeDefined()
		expect(props.ok).toBeDefined()
		expect(props.error_key).toBeUndefined()
	})

	it.skipIf(!hasZodJsonSchema)("errorFormatter schema propagates through use()", async () => {
		const errors = defineErrors({ not_found: "not_found" })

		const customSchema = z.object({
			code: z.string(),
			ok: z.literal(false),
		})

		const noop = function noop(_ctx: unknown, next: (adds?: unknown) => unknown) {
			return next()
		}

		const app = honey<{}>()
			.errorFactory(errors)
			.defaultErrorFormatter(customSchema, (error) => ({
				code: error.errorKey,
				ok: false as const,
			}))
			.use(noop)

		app
			.get("/items")
			.errors("not_found")
			.handler((ctx) => ctx.res.json("ok", {}))

		const spec = await generateOpenApi(app, {
			info: { title: "T", version: "1" },
		})
		const schema = getErrorSchema(spec, "/items", "get", "404")

		expect(schema).toBeDefined()
		const props = schema?.properties as Record<string, unknown>
		expect(props.code).toBeDefined()
		expect(props.ok).toBeDefined()
		expect(props.error_key).toBeUndefined()
	})
})

describe("runtime errorFormatter with schema overload", () => {
	it("schema+mapper overload formats error response at runtime", async () => {
		const errors = defineErrors({ bad_input: "bad_request" })

		const customSchema = z.object({
			code: z.string(),
			message: z.string(),
			ok: z.literal(false),
		})

		const app = honey<{}>()
			.errorFactory(errors)
			.defaultErrorFormatter(customSchema, (error) => ({
				code: error.errorKey,
				message: error.message,
				ok: false as const,
			}))

		app
			.post("/items")
			.errors("bad_input")
			.handler((ctx) => {
				throw ctx.errors.bad_input()
			})

		const res = await app.fetch(new Request("http://localhost/items", { method: "POST" }), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(res.status).toBe(400)
		expect(body.code).toBe("bad_input")
		expect(body.ok).toBe(false)
		expect(body.message).toBeDefined()
		/* default shape fields should NOT be present */
		expect(body.error_key).toBeUndefined()
		expect(body.success).toBeUndefined()
		expect(body.fields).toBeUndefined()
	})

	it("fn-only overload still works at runtime (backwards compat)", async () => {
		const app = honey<{}>()
		app.defaultErrorFormatter((_error, shape) => ({
			...shape,
			request_id: "abc-123",
		}))

		app.get("/fail").handler(() => {
			throw new Error("boom")
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.request_id).toBe("abc-123")
		expect(body.success).toBe(false)
	})
})

function errorKeyEnum(schema: Record<string, unknown> | undefined): string[] | undefined {
	const props = schema?.properties as Record<string, { enum?: string[] }> | undefined
	return props?.error_key?.enum
}

describe("OpenAPI error schema — declared keys per status", () => {
	it("named 404 key is in that operation's error_key enum", async () => {
		const errors = defineErrors({ item_not_found: "not_found" })
		const app = honey<{}>().errorFactory(errors)
		app
			.get("/items/:id")
			.errors("item_not_found")
			.handler((c) => {
				throw c.errors.item_not_found()
			})
		app.get("/other").handler((c) => c.res.json("ok", {}))

		const spec = await generateOpenApi(app, { info: { title: "T", version: "1" } })
		const item404 = getErrorSchema(spec, "/items/{id}", "get", "404")
		expect(errorKeyEnum(item404)).toContain("item_not_found")
		expect(getErrorSchema(spec, "/other", "get", "404")).toBeUndefined()
	})

	it("route with only generic not_found keeps the generic enum", async () => {
		const errors = defineErrors({
			item_not_found: "not_found",
			not_found: "not_found",
		})
		const app = honey<{}>().errorFactory(errors).defaultErrors("not_found")
		app
			.get("/items/:id")
			.errors("item_not_found")
			.handler((c) => {
				throw c.errors.item_not_found()
			})
		app.get("/other").handler((c) => c.res.json("ok", {}))

		const spec = await generateOpenApi(app, { info: { title: "T", version: "1" } })
		const named = errorKeyEnum(getErrorSchema(spec, "/items/{id}", "get", "404"))
		expect(named).toContain("item_not_found")
		expect(named).toContain("not_found")
		expect(errorKeyEnum(getErrorSchema(spec, "/other", "get", "404"))).toEqual(["not_found"])
	})

	it("named 404 key is documented when the app factory does not define it", async () => {
		const workerErrors = defineErrors({
			item_not_found: "not_found",
			not_found: "not_found",
		})
		const worker = honey<{}>().errorFactory(workerErrors).defaultErrors("not_found")
		worker
			.get("/items/:id")
			.errors("item_not_found")
			.handler((c) => {
				throw c.errors.item_not_found()
			})

		const gatewayErrors = defineErrors({ not_found: "not_found" })
		const gateway = honey<{}>().errorFactory(gatewayErrors).routeTree(worker.toRouteTree())

		const spec = await generateOpenApi(gateway, { info: { title: "T", version: "1" } })
		const keys = errorKeyEnum(getErrorSchema(spec, "/items/{id}", "get", "404"))
		expect(keys).toContain("item_not_found")
		expect(keys).toContain("not_found")
	})

	it("suffix inference prefers not_found over found", async () => {
		const workerErrors = defineErrors({
			billing_event_not_found: "not_found",
		})
		const worker = honey<{}>().errorFactory(workerErrors)
		worker
			.get("/events/:id")
			.errors("billing_event_not_found")
			.handler((c) => {
				throw c.errors.billing_event_not_found()
			})

		const gateway = honey<{}>().routeTree(worker.toRouteTree())
		const spec = await generateOpenApi(gateway, { info: { title: "T", version: "1" } })
		expect(getErrorSchema(spec, "/events/{id}", "get", "302")).toBeUndefined()
		expect(errorKeyEnum(getErrorSchema(spec, "/events/{id}", "get", "404"))).toEqual(["billing_event_not_found"])
	})
})
