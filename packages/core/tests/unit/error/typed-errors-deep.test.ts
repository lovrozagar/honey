import { describe, expect, it } from "vitest"
import * as z from "zod"
import { honey } from "../../../src/index.ts"
import { HoneyError } from "../../../src/error.ts"
import { defineErrors, ERROR_META } from "../../../src/errors.ts"
import { createErrorResponse } from "../../../src/response.ts"
import { ClientError } from "../../../src/client/error.ts"
import { createClient } from "../../../src/client/index.ts"

/* ── shared fixtures ── */

const itemSchema = z.object({
	reason: z.string(),
	suggestions: z.array(z.string()),
})

const errors = defineErrors({
	api_error: "internal_server_error",
	email_taken: "conflict",
	item_not_found: {
		schema: itemSchema,
		status: "not_found",
	},
	rate_limited: {
		schema: z.object({
			retry_after: z.number(),
		}),
		status: "too_many_requests",
	},
	unauthorized: "unauthorized",
})

/* ── defineErrors deep ── */

describe("defineErrors: deep coverage", () => {
	it("mixed factory: standard and custom coexist", () => {
		const std = errors.email_taken()
		const custom = errors.item_not_found({ reason: "gone", suggestions: [] })

		expect(std.data).toBeUndefined()
		expect(std.errorKey).toBe("email_taken")
		expect(custom.data).toEqual({ reason: "gone", suggestions: [] })
		expect(custom.errorKey).toBe("item_not_found")
	})

	it("multiple custom schema errors with different schemas", () => {
		const notFound = errors.item_not_found({ reason: "x", suggestions: [] })
		const rateLimited = errors.rate_limited({ retry_after: 60 })

		expect(notFound.status).toBe(404)
		expect(notFound.data).toEqual({ reason: "x", suggestions: [] })
		expect(rateLimited.status).toBe(429)
		expect(rateLimited.data).toEqual({ retry_after: 60 })
	})

	it("custom error with empty object payload", () => {
		const errs = defineErrors({
			empty_body: {
				schema: z.object({}),
				status: "bad_request",
			},
		})
		const err = errs.empty_body({})
		expect(err.data).toEqual({})
		expect(err.status).toBe(400)
	})

	it("custom error with nested object payload", () => {
		const errs = defineErrors({
			complex: {
				schema: z.object({
					details: z.object({
						code: z.number(),
						inner: z.object({ msg: z.string() }),
					}),
				}),
				status: "bad_request",
			},
		})
		const payload = { details: { code: 42, inner: { msg: "deep" } } }
		const err = errs.complex(payload)
		expect(err.data).toEqual(payload)
		expect(err.data).toBe(payload) /* same reference */
	})

	it("ERROR_META schema is the actual schema reference", () => {
		const meta = errors[ERROR_META]
		expect(meta.item_not_found.schema).toBe(itemSchema)
		expect(meta.rate_limited.schema).not.toBeNull()
	})

	it("ERROR_META standard entries have null schema", () => {
		const meta = errors[ERROR_META]
		expect(meta.email_taken.schema).toBeNull()
		expect(meta.unauthorized.schema).toBeNull()
		expect(meta.api_error.schema).toBeNull()
	})

	it("factory keys enumerable, ERROR_META is not", () => {
		const keys = Object.keys(errors)
		expect(keys).toContain("email_taken")
		expect(keys).toContain("item_not_found")
		expect(keys).toContain("rate_limited")
		expect(keys.length).toBe(5)
		/* symbol not in Object.keys */
		expect(Object.getOwnPropertySymbols(errors)).toContain(ERROR_META)
	})

	it("each factory call returns fresh instance", () => {
		const a = errors.item_not_found({ reason: "a", suggestions: [] })
		const b = errors.item_not_found({ reason: "b", suggestions: [] })
		expect(a).not.toBe(b)
		expect(a.data).not.toBe(b.data)
	})

	it("custom error inherits from Error and HoneyError", () => {
		const err = errors.item_not_found({ reason: "x", suggestions: [] })
		expect(err).toBeInstanceOf(Error)
		expect(err).toBeInstanceOf(HoneyError)
		expect(err.stack).toContain("item_not_found")
	})
})

/* ── createErrorResponse deep ── */

describe("createErrorResponse: deep coverage", () => {
	const identity = (_e: HoneyError, shape: Record<string, unknown>) => shape

	it("standard error: full default shape fields present", async () => {
		const err = errors.email_taken({ vars: { email: "a@b.com" } })
		const res = createErrorResponse(err, identity, null)
		const body = await res.json()

		expect(body.error_key).toBe("email_taken")
		expect(body.status).toBe(409)
		expect(body.status_key).toBe("conflict")
		expect(body.success).toBe(false)
		expect(body.message).toBe("email_taken")
		expect(body.fields).toEqual({})
		expect(body.vars).toEqual({ email: "a@b.com" })
		expect(res.headers.get("content-type")).toBe("application/json")
	})

	it("standard error without vars: no vars key in body", async () => {
		const err = errors.email_taken()
		const res = createErrorResponse(err, identity, null)
		const body = await res.json()

		expect(body.vars).toBeUndefined()
	})

	it("custom error: data serialized as-is, no default shape fields", async () => {
		const err = errors.item_not_found({ reason: "deleted", suggestions: ["/other"] })
		const res = createErrorResponse(err, identity, null)
		const body = await res.json()

		expect(body).toEqual({ reason: "deleted", suggestions: ["/other"] })
		expect(body.error_key).toBeUndefined()
		expect(body.success).toBeUndefined()
		expect(body.status).toBeUndefined()
	})

	it("customFormatter receives correct HoneyError and data", async () => {
		let receivedError: HoneyError | null = null
		let receivedData: Record<string, unknown> | null = null

		const customFmt = (error: HoneyError, data: Record<string, unknown>) => {
			receivedError = error
			receivedData = data
			return { ...data, injected: true }
		}

		const err = errors.item_not_found({ reason: "test", suggestions: ["a"] })
		const res = createErrorResponse(err, identity, customFmt)
		const body = await res.json()

		expect(receivedError).toBe(err)
		expect(receivedData).toEqual({ reason: "test", suggestions: ["a"] })
		expect(body.injected).toBe(true)
		expect(body.reason).toBe("test")
	})

	it("customFormatter does NOT fire for standard errors", async () => {
		let customCalled = false
		const customFmt = (_e: HoneyError, data: Record<string, unknown>) => {
			customCalled = true
			return data
		}

		const err = errors.email_taken()
		createErrorResponse(err, identity, customFmt)

		expect(customCalled).toBe(false)
	})

	it("defaultFormatter does NOT fire for custom schema errors", async () => {
		let defaultCalled = false
		const defaultFmt = (_e: HoneyError, shape: Record<string, unknown>) => {
			defaultCalled = true
			return shape
		}

		const err = errors.item_not_found({ reason: "x", suggestions: [] })
		createErrorResponse(err, defaultFmt, null)

		expect(defaultCalled).toBe(false)
	})

	it("custom error with data={} produces empty JSON object", async () => {
		const err = new HoneyError({
			data: {},
			errorKey: "empty",
			status: "bad_request",
		})
		const res = createErrorResponse(err, identity, null)
		const body = await res.json()
		expect(body).toEqual({})
	})

	it("response status matches error status for both types", async () => {
		const std = createErrorResponse(errors.email_taken(), identity, null)
		const custom = createErrorResponse(
			errors.rate_limited({ retry_after: 30 }),
			identity,
			null,
		)

		expect(std.status).toBe(409)
		expect(custom.status).toBe(429)
	})
})

/* ── HoneyError.data edge cases ── */

describe("HoneyError.data: edge cases", () => {
	it("data: undefined means standard error (no data)", () => {
		const err = new HoneyError({ errorKey: "x", status: "bad_request" })
		expect(err.data).toBeUndefined()
		expect("data" in err).toBe(true) /* property exists, value is undefined */
	})

	it("data: explicit value preserved exactly", () => {
		const arr = [1, 2, 3]
		const err = new HoneyError({ data: arr, errorKey: "x", status: "bad_request" })
		expect(err.data).toBe(arr) /* same reference */
	})

	it("data: string payload", () => {
		const err = new HoneyError({ data: "plain text", errorKey: "x", status: "bad_request" })
		expect(err.data).toBe("plain text")
	})

	it("data: number payload", () => {
		const err = new HoneyError({ data: 42, errorKey: "x", status: "bad_request" })
		expect(err.data).toBe(42)
	})
})

/* ── Integration: full request flow ── */

describe("integration: custom schema error through honey app", () => {
	const appErrors = defineErrors({
		api_error: "internal_server_error",
		item_not_found: {
			schema: z.object({ reason: z.string() }),
			status: "not_found",
		},
		validation_error: "unprocessable_entity",
	})

	const app = honey()
		.errorFactory(appErrors)
		.defaultBoundary("api_error")

		/* route with declared custom error */
		.get("/items/:id")
		.errors("item_not_found")
		.handler((c) => {
			throw appErrors.item_not_found({ reason: "Item was deleted" })
		})

		/* route with standard error */
		.get("/fail")
		.errors("validation_error")
		.handler((c) => {
			throw appErrors.validation_error()
		})

		/* route that throws undeclared custom error → boundary wraps it */
		.get("/undeclared")
		.handler((c) => {
			throw appErrors.item_not_found({ reason: "should be wrapped" })
		})

	it("custom schema error: response body is the schema payload", async () => {
		const res = await app.fetch(new Request("http://localhost/items/123"))
		expect(res.status).toBe(404)
		const body = await res.json()
		expect(body.reason).toBe("Item was deleted")
		expect(body.error_key).toBeUndefined()
	})

	it("standard error: response body is default error shape", async () => {
		const res = await app.fetch(new Request("http://localhost/fail"))
		expect(res.status).toBe(422)
		const body = await res.json()
		expect(body.error_key).toBe("validation_error")
		expect(body.success).toBe(false)
	})

	it("undeclared custom error: boundary wraps it, data lost", async () => {
		const res = await app.fetch(new Request("http://localhost/undeclared"))
		expect(res.status).toBe(500)
		const body = await res.json()
		expect(body.error_key).toBe("api_error")
		expect(body.reason).toBeUndefined()
	})
})

/* ── Integration: client consuming custom errors ── */

describe("integration: client receives custom schema errors", () => {
	const appErrors = defineErrors({
		api_error: "internal_server_error",
		item_not_found: {
			schema: z.object({
				reason: z.string(),
				suggestions: z.array(z.string()),
			}),
			status: "not_found",
		},
		std_not_found: "not_found",
	})

	const app = honey()
		.errorFactory(appErrors)
		.defaultBoundary("api_error")

		.get("/custom-404")
		.errors("item_not_found")
		.handler(() => {
			throw appErrors.item_not_found({
				reason: "Item deleted",
				suggestions: ["/items/456"],
			})
		})

		.get("/standard-404")
		.errors("std_not_found")
		.handler(() => {
			throw appErrors.std_not_found()
		})

		.get("/ok")
		.output({ "application/json": { ok: z.object({ id: z.string() }) } })
		.handler((c) => c.res.json("ok", { id: "123" }))

	const client = createClient<typeof app>({
		baseURL: "http://localhost",
		fetch: (input, init) => app.fetch(new Request(input, init)),
	})

	it("custom error: error IS the schema payload", async () => {
		const r = await client.get("/custom-404")
		expect(r.error).not.toBeNull()
		expect(r.status).toBe(404)
		expect(r.error.reason).toBe("Item deleted")
		expect(r.error.suggestions).toEqual(["/items/456"])
	})

	it("standard error: error IS the default error shape", async () => {
		const r = await client.get("/standard-404")
		expect(r.error).not.toBeNull()
		expect(r.status).toBe(404)
		expect(r.error.error_key).toBe("std_not_found")
	})

	it("success: data present, no error", async () => {
		const r = await client.get("/ok")
		expect(r.error).toBeNull()
		expect(r.data).toEqual({ id: "123" })
	})

	it("error is raw parsed body in safe mode, status/response on result", async () => {
		const r = await client.get("/custom-404")
		expect(r.error).not.toBeNull()
		expect(r.status).toBe(404)
		expect(r.response).toBeInstanceOf(Response)
	})

	it("throw mode: ClientError thrown with body", async () => {
		const throwClient = createClient<typeof app>({
			baseURL: "http://localhost",
			fetch: (input, init) => app.fetch(new Request(input, init)),
			throwOnError: true,
		})

		try {
			await throwClient.get("/custom-404")
			expect.fail("should have thrown")
		} catch (e) {
			expect(e).toBeInstanceOf(ClientError)
			const ce = e as ClientError
			expect(ce.status).toBe(404)
			expect(ce.body.reason).toBe("Item deleted")
			expect(ce.body.suggestions).toEqual(["/items/456"])
		}
	})
})

/* ── Integration: customErrorFormatter in app ── */

describe("integration: customErrorFormatter via createErrorResponse", () => {
	it("adds fields to custom error responses", async () => {
		const appErrors = defineErrors({
			api_error: "internal_server_error",
			item_gone: {
				schema: z.object({ reason: z.string() }),
				status: "gone",
			},
		})

		const customFmt = (_e: HoneyError, data: Record<string, unknown>) => ({
			...data,
			request_id: "req-abc",
		})

		/* simulate what the framework does internally */
		const err = appErrors.item_gone({ reason: "removed" })
		const res = createErrorResponse(
			err,
			(e, s) => s, /* identity default formatter */
			customFmt,
		)
		const body = await res.json()

		expect(body.reason).toBe("removed")
		expect(body.request_id).toBe("req-abc")
		expect(body.error_key).toBeUndefined()
	})
})

/* ── Regression: standard errors unchanged ── */

describe("regression: standard error flow unchanged", () => {
	const appErrors = defineErrors({
		api_error: "internal_server_error",
		slug_taken: "conflict",
	})

	const app = honey()
		.errorFactory(appErrors)
		.defaultBoundary("api_error")
		.get("/conflict")
		.errors("slug_taken")
		.handler(() => {
			throw appErrors.slug_taken({ vars: { slug: "my-org" } })
		})

	it("standard error produces correct response", async () => {
		const res = await app.fetch(new Request("http://localhost/conflict"))
		expect(res.status).toBe(409)
		const body = await res.json()
		expect(body.error_key).toBe("slug_taken")
		expect(body.status).toBe(409)
		expect(body.status_key).toBe("conflict")
		expect(body.success).toBe(false)
		expect(body.message).toBe("slug_taken")
		expect(body.vars).toEqual({ slug: "my-org" })
	})

	it("fields present on standard error", async () => {
		const fieldsErrors = defineErrors({
			api_error: "internal_server_error",
			val_error: "unprocessable_entity",
		})

		const fieldsApp = honey()
			.errorFactory(fieldsErrors)
			.defaultBoundary("api_error")
			.post("/validate")
			.errors("val_error")
			.handler(() => {
				throw fieldsErrors.val_error({
					fields: {
						email: [{ error_key: "field_invalid_email", message: "bad", path: "json.email" }],
					},
				})
			})

		const res = await fieldsApp.fetch(
			new Request("http://localhost/validate", { method: "POST" }),
		)
		const body = await res.json()
		expect(body.fields.email).toHaveLength(1)
		expect(body.fields.email[0].error_key).toBe("field_invalid_email")
	})
})
