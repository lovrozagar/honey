import { describe, expect, it } from "vitest"
import * as z from "zod"
import { honey } from "../../../src/index.ts"
import { defineErrors } from "../../../src/errors.ts"
import { generateOpenApi } from "../../../src/codegen.ts"

const info = { title: "Test API", version: "1.0.0" }

describe("OpenAPI: custom schema errors", () => {
	it("standard errors use base error schema with constrained enums", async () => {
		const errors = defineErrors({
			api_error: "internal_server_error",
			email_taken: "conflict",
			slug_taken: "conflict",
		})

		const app = honey()
			.errorFactory(errors)
			.defaultBoundary("api_error")
			.get("/test")
			.errors("email_taken", "slug_taken")
			.handler((c) => c.res.json("ok", {}))

		const spec = await generateOpenApi(app, { info })
		const responses = spec.paths["/test"].get.responses

		/* 409 response should have base error schema with constrained error_key enum */
		expect(responses["409"]).toBeDefined()
		const schema = responses["409"].content["application/json"].schema
		expect(schema.properties.error_key.enum).toEqual(["email_taken", "slug_taken"])
		expect(schema.properties.status.enum).toEqual([409])
		expect(schema.properties.success).toEqual({ const: false })
	})

	it("custom schema error uses per-error schema", async () => {
		const errors = defineErrors({
			api_error: "internal_server_error",
			item_not_found: {
				schema: z.object({
					reason: z.string(),
					suggestions: z.array(z.string()),
				}),
				status: "not_found",
			},
		})

		const app = honey()
			.errorFactory(errors)
			.defaultBoundary("api_error")
			.get("/items/:id")
			.errors("item_not_found")
			.handler((c) => c.res.json("ok", {}))

		const spec = await generateOpenApi(app, { info })
		const responses = spec.paths["/items/{id}"].get.responses

		expect(responses["404"]).toBeDefined()
		const schema = responses["404"].content["application/json"].schema

		/* should be the custom schema, not the default error shape */
		expect(schema.properties.reason).toBeDefined()
		expect(schema.properties.suggestions).toBeDefined()
		expect(schema.properties.error_key).toBeUndefined()
		expect(schema.properties.success).toBeUndefined()
	})

	it("mixed standard + custom at same status code uses oneOf", async () => {
		const errors = defineErrors({
			api_error: "internal_server_error",
			item_not_found: {
				schema: z.object({ reason: z.string() }),
				status: "not_found",
			},
			user_not_found: "not_found",
		})

		const app = honey()
			.errorFactory(errors)
			.defaultBoundary("api_error")
			.get("/search")
			.errors("item_not_found", "user_not_found")
			.handler((c) => c.res.json("ok", {}))

		const spec = await generateOpenApi(app, { info })
		const responses = spec.paths["/search"].get.responses

		expect(responses["404"]).toBeDefined()
		const schema = responses["404"].content["application/json"].schema

		/* should be oneOf with standard + custom */
		expect(schema.oneOf).toBeDefined()
		expect(schema.oneOf).toHaveLength(2)

		/* one should be the standard error shape with constrained enum */
		const stdSchema = schema.oneOf.find((s: Record<string, unknown>) =>
			(s as Record<string, Record<string, unknown>>).properties?.error_key
		)
		expect(stdSchema).toBeDefined()
		expect(stdSchema.properties.error_key.enum).toEqual(["user_not_found"])

		/* other should be the custom schema */
		const customSchema = schema.oneOf.find((s: Record<string, unknown>) =>
			(s as Record<string, Record<string, unknown>>).properties?.reason
		)
		expect(customSchema).toBeDefined()
	})

	it("customErrorFormatter schema merges via allOf", async () => {
		const errors = defineErrors({
			api_error: "internal_server_error",
			item_not_found: {
				schema: z.object({ reason: z.string() }),
				status: "not_found",
			},
		})

		const app = honey()
			.errorFactory(errors)
			.defaultBoundary("api_error")
			.customErrorFormatter(
				z.object({ timestamp: z.number() }),
				(_err, data) => ({ ...data, timestamp: Date.now() }),
			)
			.get("/items/:id")
			.errors("item_not_found")
			.handler((c) => c.res.json("ok", {}))

		const spec = await generateOpenApi(app, { info })
		const responses = spec.paths["/items/{id}"].get.responses
		const schema = responses["404"].content["application/json"].schema

		/* should be allOf merging per-error schema + custom formatter additions */
		expect(schema.allOf).toBeDefined()
		expect(schema.allOf).toHaveLength(2)
	})

	it("multiple custom schema errors at different status codes", async () => {
		const errors = defineErrors({
			api_error: "internal_server_error",
			item_not_found: {
				schema: z.object({ reason: z.string() }),
				status: "not_found",
			},
			rate_limited: {
				schema: z.object({ retry_after: z.number() }),
				status: "too_many_requests",
			},
		})

		const app = honey()
			.errorFactory(errors)
			.defaultBoundary("api_error")
			.get("/items")
			.errors("item_not_found", "rate_limited")
			.handler((c) => c.res.json("ok", {}))

		const spec = await generateOpenApi(app, { info })
		const responses = spec.paths["/items"].get.responses

		expect(responses["404"]).toBeDefined()
		expect(responses["429"]).toBeDefined()

		/* 404 should have custom schema */
		const schema404 = responses["404"].content["application/json"].schema
		expect(schema404.properties.reason).toBeDefined()

		/* 429 should have custom schema */
		const schema429 = responses["429"].content["application/json"].schema
		expect(schema429.properties.retry_after).toBeDefined()
	})

	it("output 2xx responses still work alongside custom error responses", async () => {
		const errors = defineErrors({
			api_error: "internal_server_error",
			item_not_found: {
				schema: z.object({ reason: z.string() }),
				status: "not_found",
			},
		})

		const app = honey()
			.errorFactory(errors)
			.defaultBoundary("api_error")
			.get("/items/:id")
			.output({
				"application/json": {
					ok: z.object({ id: z.string(), name: z.string() }),
				},
			})
			.errors("item_not_found")
			.handler((c) => c.res.json("ok", { id: "1", name: "test" }))

		const spec = await generateOpenApi(app, { info })
		const responses = spec.paths["/items/{id}"].get.responses

		/* 200 output */
		expect(responses["200"]).toBeDefined()
		const okSchema = responses["200"].content["application/json"].schema
		expect(okSchema.properties.id).toBeDefined()
		expect(okSchema.properties.name).toBeDefined()

		/* 404 custom error */
		expect(responses["404"]).toBeDefined()
		const errSchema = responses["404"].content["application/json"].schema
		expect(errSchema.properties.reason).toBeDefined()
	})

	it("description includes all error keys at same status", async () => {
		const errors = defineErrors({
			api_error: "internal_server_error",
			item_not_found: {
				schema: z.object({ reason: z.string() }),
				status: "not_found",
			},
			user_not_found: "not_found",
		})

		const app = honey()
			.errorFactory(errors)
			.defaultBoundary("api_error")
			.get("/search")
			.errors("item_not_found", "user_not_found")
			.handler((c) => c.res.json("ok", {}))

		const spec = await generateOpenApi(app, { info })
		const desc = spec.paths["/search"].get.responses["404"].description
		expect(desc).toContain("item_not_found")
		expect(desc).toContain("user_not_found")
	})
})

describe("OpenAPI: regression — standard errors unchanged", () => {
	it("standard-only route has base schema with error_key enum", async () => {
		const errors = defineErrors({
			api_error: "internal_server_error",
			forbidden: "forbidden",
			unauthorized: "unauthorized",
		})

		const app = honey()
			.errorFactory(errors)
			.defaultBoundary("api_error")
			.get("/secure")
			.errors("unauthorized", "forbidden")
			.handler((c) => c.res.json("ok", {}))

		const spec = await generateOpenApi(app, { info })
		const responses = spec.paths["/secure"].get.responses

		/* 401 */
		expect(responses["401"]).toBeDefined()
		const schema401 = responses["401"].content["application/json"].schema
		expect(schema401.properties.error_key.enum).toEqual(["unauthorized"])
		expect(schema401.properties.success).toEqual({ const: false })

		/* 403 */
		expect(responses["403"]).toBeDefined()
		const schema403 = responses["403"].content["application/json"].schema
		expect(schema403.properties.error_key.enum).toEqual(["forbidden"])
	})
})
