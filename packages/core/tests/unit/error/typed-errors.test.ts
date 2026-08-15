import { describe, expect, expectTypeOf, it } from "vitest"
import * as z from "zod"
import { HoneyError } from "../../../src/error.ts"
import { defineErrors, ERROR_META } from "../../../src/errors.ts"
import { createErrorResponse } from "../../../src/response.ts"

describe("defineErrors with custom schemas", () => {
	const errors = defineErrors({
		/* standard — string status key */
		email_taken: "conflict",
		unauthorized: "unauthorized",

		/* typed — object with status + schema */
		item_not_found: {
			schema: z.object({
				reason: z.string(),
				suggestions: z.array(z.string()),
			}),
			status: "not_found",
		},
	})

	it("standard error factory works as before", () => {
		const err = errors.email_taken({ cause: "dup" })
		expect(err).toBeInstanceOf(HoneyError)
		expect(err.errorKey).toBe("email_taken")
		expect(err.status).toBe(409)
		expect(err.statusKey).toBe("conflict")
		expect(err.data).toBeUndefined()
	})

	it("custom schema error factory accepts typed payload as first arg", () => {
		const err = errors.item_not_found(
			{ reason: "No item with that ID", suggestions: ["/items/123"] },
		)
		expect(err).toBeInstanceOf(HoneyError)
		expect(err.errorKey).toBe("item_not_found")
		expect(err.status).toBe(404)
		expect(err.statusKey).toBe("not_found")
		expect(err.data).toEqual({
			reason: "No item with that ID",
			suggestions: ["/items/123"],
		})
	})

	it("custom schema error factory accepts cause as second arg", () => {
		const cause = new Error("db lookup failed")
		const err = errors.item_not_found(
			{ reason: "not found", suggestions: [] },
			{ cause },
		)
		expect(err.cause).toBe(cause)
		expect(err.data).toEqual({ reason: "not found", suggestions: [] })
	})

	it("custom schema error has no fields/vars (those are standard-only)", () => {
		const err = errors.item_not_found(
			{ reason: "gone", suggestions: [] },
		)
		expect(err.fields).toEqual({})
		expect(err.vars).toBeUndefined()
	})

	it("ERROR_META exposes schema metadata for codegen", () => {
		const meta = errors[ERROR_META]
		expect(meta).toBeDefined()
		expect(meta.email_taken).toEqual({
			schema: null,
			statusKey: "conflict",
		})
		expect(meta.item_not_found.statusKey).toBe("not_found")
		expect(meta.item_not_found.schema).toBeDefined()
	})

	it("ERROR_META is not enumerable", () => {
		const keys = Object.keys(errors)
		expect(keys).not.toContain(ERROR_META.toString())
	})
})

describe("HoneyError.data", () => {
	it("data is undefined when not provided", () => {
		const err = new HoneyError({ errorKey: "test", status: "bad_request" })
		expect(err.data).toBeUndefined()
	})

	it("data is set when provided", () => {
		const data = { reason: "not found", suggestions: [] }
		const err = new HoneyError({
			data,
			errorKey: "item_not_found",
			status: "not_found",
		})
		expect(err.data).toBe(data)
	})
})

describe("createErrorResponse with dual formatters", () => {
	const defaultFormatter = (
		_error: HoneyError,
		defaultShape: Record<string, unknown>,
	) => ({
		...defaultShape,
		timestamp: 1234567890,
	})

	const customFormatter = (
		_error: HoneyError,
		data: Record<string, unknown>,
	) => ({
		...data,
		timestamp: 1234567890,
	})

	it("standard error uses defaultFormatter", async () => {
		const err = new HoneyError({
			errorKey: "email_taken",
			status: "conflict",
		})
		const res = createErrorResponse(err, defaultFormatter, null)
		expect(res.status).toBe(409)
		const body = await res.json()
		expect(body.error_key).toBe("email_taken")
		expect(body.timestamp).toBe(1234567890)
		expect(body.success).toBe(false)
	})

	it("custom schema error uses data as-is when no customFormatter", async () => {
		const err = new HoneyError({
			data: { reason: "not found", suggestions: ["/a"] },
			errorKey: "item_not_found",
			status: "not_found",
		})
		const res = createErrorResponse(err, defaultFormatter, null)
		expect(res.status).toBe(404)
		const body = await res.json()
		expect(body.reason).toBe("not found")
		expect(body.suggestions).toEqual(["/a"])
		expect(body.error_key).toBeUndefined()
		expect(body.timestamp).toBeUndefined()
	})

	it("custom schema error uses customFormatter when provided", async () => {
		const err = new HoneyError({
			data: { reason: "not found", suggestions: [] },
			errorKey: "item_not_found",
			status: "not_found",
		})
		const res = createErrorResponse(err, defaultFormatter, customFormatter)
		expect(res.status).toBe(404)
		const body = await res.json()
		expect(body.reason).toBe("not found")
		expect(body.timestamp).toBe(1234567890)
	})

	it("customFormatter crash falls back to raw data", async () => {
		const crashingFormatter = () => {
			throw new Error("formatter crashed")
		}
		const err = new HoneyError({
			data: { reason: "not found" },
			errorKey: "item_not_found",
			status: "not_found",
		})
		const res = createErrorResponse(err, defaultFormatter, crashingFormatter)
		const body = await res.json()
		expect(body.reason).toBe("not found")
	})

	it("defaultFormatter crash falls back to default shape", async () => {
		const crashingFormatter = () => {
			throw new Error("formatter crashed")
		}
		const err = new HoneyError({
			errorKey: "email_taken",
			status: "conflict",
		})
		const res = createErrorResponse(err, crashingFormatter, null)
		const body = await res.json()
		expect(body.error_key).toBe("email_taken")
		expect(body.success).toBe(false)
	})
})

describe("type-level: defineErrors with custom schemas", () => {
	it("standard error factory accepts opts with cause/fields/vars", () => {
		const errors = defineErrors({
			email_taken: "conflict",
		})
		const err = errors.email_taken({
			cause: "test",
			fields: {},
			vars: { email: "test@test.com" },
		})
		expectTypeOf(err).toMatchTypeOf<HoneyError>()
	})

	it("custom schema error factory accepts typed payload", () => {
		const errors = defineErrors({
			item_not_found: {
				schema: z.object({
					reason: z.string(),
				}),
				status: "not_found",
			},
		})
		const err = errors.item_not_found({ reason: "gone" })
		expectTypeOf(err).toMatchTypeOf<HoneyError>()
	})
})
