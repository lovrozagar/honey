import { describe, expect, expectTypeOf, it } from "vitest"
import type { FieldError } from "./error.ts"
import { HoneyError } from "./error.ts"
import { defineErrors, ERROR_META } from "./errors.ts"

/** A minimal Standard Schema that accepts anything and types its output as `T`. */
function schemaOf<T>() {
	return {
		"~standard": {
			types: undefined as unknown as { input: T; output: T },
			validate: (value: unknown) => ({ value }),
			vendor: "test",
			version: 1 as const,
		},
	}
}

describe("defineErrors", () => {
	// v0: 71b9a86b01
	it("creates factory with correct keys", () => {
		const errors = defineErrors({ invalid_email: "bad_request", user_not_found: "not_found" })
		expect(errors.invalid_email).toBeTypeOf("function")
		expect(errors.user_not_found).toBeTypeOf("function")
	})

	// v0: fa4dc9ccf0
	it("each key returns a function that creates HoneyError", () => {
		expect(defineErrors({ something_broke: "internal_server_error" }).something_broke()).toBeInstanceOf(HoneyError)
	})

	// v0: e4e769948d
	it("error has correct errorKey", () => {
		expect(defineErrors({ duplicate_record: "conflict" }).duplicate_record().errorKey).toBe("duplicate_record")
	})

	// v0: 191978a3a9
	it("error has correct status code mapped from status key", () => {
		const errors = defineErrors({
			gone_resource: "gone",
			invalid_input: "bad_request",
			missing_item: "not_found",
			server_fail: "internal_server_error",
			unauthorized_access: "unauthorized",
		})
		expect(errors.invalid_input().status).toBe(400)
		expect(errors.unauthorized_access().status).toBe(401)
		expect(errors.missing_item().status).toBe(404)
		expect(errors.gone_resource().status).toBe(410)
		expect(errors.server_fail().status).toBe(500)
	})

	// v0: 072a31d246
	it("error has correct statusKey", () => {
		expect(defineErrors({ rate_limited: "too_many_requests" }).rate_limited().statusKey).toBe("too_many_requests")
	})

	// v0: ed8479919f
	it("supports vars parameter for i18n", () => {
		const err = defineErrors({ quota_exceeded: "bad_request" }).quota_exceeded({
			vars: { limit: 100, resource: "files" },
		})
		expect(err.vars).toEqual({ limit: 100, resource: "files" })
	})

	// v0: 5f08d5291d
	it("factory is an object with null prototype", () => {
		expect(Object.getPrototypeOf(defineErrors({ test_error: "bad_request" }))).toBeNull()
	})
})

describe("defineErrors options", () => {
	// v0: 9ea3b85898
	it("supports fields parameter", () => {
		const fields = { email: [{ error_key: "invalid_email", message: "invalid format", path: "email" }] }
		expect(defineErrors({ validation_failed: "unprocessable_entity" }).validation_failed({ fields }).fields).toEqual(
			fields,
		)
	})

	// v0: d2b739e8f9
	it("supports cause parameter", () => {
		const cause = new Error("connection refused")
		expect(defineErrors({ db_error: "internal_server_error" }).db_error({ cause }).cause).toBe(cause)
	})

	// v0: ee9a817238
	it("multiple errors with same status key work", () => {
		const errors = defineErrors({ email_taken: "conflict", slug_taken: "conflict", username_taken: "conflict" })
		const made = [errors.email_taken(), errors.username_taken(), errors.slug_taken()]
		expect(made.map((e) => e.status)).toEqual([409, 409, 409])
		expect(made.map((e) => e.errorKey)).toEqual(["email_taken", "username_taken", "slug_taken"])
	})

	// v0: 025c831532
	it("error without opts has empty fields and no vars", () => {
		const err = defineErrors({ basic_error: "bad_request" }).basic_error()
		expect(err.fields).toEqual({})
		expect(err.vars).toBeUndefined()
		expect(err.cause).toBeUndefined()
	})

	// v0: 1d79b9cfea
	it("error message equals errorKey", () => {
		expect(defineErrors({ my_custom_error: "forbidden" }).my_custom_error().message).toBe("my_custom_error")
	})

	// v0: a8cced71c2
	it("errors are independent instances", () => {
		const errors = defineErrors({ reusable: "bad_request" })
		const e1 = errors.reusable({ vars: { x: 1 } })
		const e2 = errors.reusable({ vars: { x: 2 } })
		expect(e1.vars).toEqual({ x: 1 })
		expect(e2.vars).toEqual({ x: 2 })
		expect(e1).not.toBe(e2)
	})

	// v0: e90b769661
	it("factory headers passed through", () => {
		const errors = defineErrors({ org_slug_taken: "conflict" })
		expect(errors.org_slug_taken({ headers: { "x-custom": "value" } }).headers).toEqual({ "x-custom": "value" })
		expect(errors.org_slug_taken().headers).toBeUndefined()
	})

	// v0: 68be78f539
	it("factory fields passed through", () => {
		const fields: Record<string, FieldError[]> = { slug: [{ error_key: "taken", message: "taken", path: "json.slug" }] }
		expect(defineErrors({ org_slug_taken: "conflict" }).org_slug_taken({ fields }).fields).toBe(fields)
	})
})

describe("defineErrors with custom schemas", () => {
	const errors = defineErrors({
		email_taken: "conflict",
		item_not_found: { schema: schemaOf<{ reason: string; suggestions: string[] }>(), status: "not_found" },
		unauthorized: "unauthorized",
	})

	// v0: efcf6e515a
	it("standard error factory works as before", () => {
		const err = errors.email_taken({ cause: "dup" })
		expect(err).toMatchObject({ errorKey: "email_taken", status: 409, statusKey: "conflict" })
		expect(err.data).toBeUndefined()
	})

	// v0: e18d03d99a
	it("custom schema error factory accepts typed payload as first arg", () => {
		const err = errors.item_not_found({ reason: "No item with that ID", suggestions: ["/items/123"] })
		expect(err).toMatchObject({ errorKey: "item_not_found", status: 404, statusKey: "not_found" })
		expect(err.data).toEqual({ reason: "No item with that ID", suggestions: ["/items/123"] })
		expectTypeOf(errors.item_not_found).parameter(0).toEqualTypeOf<{ reason: string; suggestions: string[] }>()
	})

	// v0: d32fcbaad4
	it("custom schema error factory accepts cause as second arg", () => {
		const cause = new Error("db lookup failed")
		const err = errors.item_not_found({ reason: "not found", suggestions: [] }, { cause, headers: { "x-a": "1" } })
		expect(err.cause).toBe(cause)
		expect(err.headers).toEqual({ "x-a": "1" })
		expect(err.data).toEqual({ reason: "not found", suggestions: [] })
	})

	// v0: a779c3cd99
	it("custom schema error has no fields/vars (those are standard-only)", () => {
		const err = errors.item_not_found({ reason: "gone", suggestions: [] })
		expect(err.fields).toEqual({})
		expect(err.vars).toBeUndefined()
	})

	// v0: 03c988163b
	it("ERROR_META exposes schema metadata for codegen", () => {
		const meta = errors[ERROR_META]
		expect(meta.email_taken).toEqual({ schema: null, statusKey: "conflict" })
		expect(meta.item_not_found.statusKey).toBe("not_found")
		expect(meta.item_not_found.schema).toHaveProperty("~standard")
	})

	// v0: 5ab50ccc16
	it("ERROR_META is not enumerable", () => {
		expect(Object.keys(errors)).toEqual(["email_taken", "item_not_found", "unauthorized"])
		expect(Object.getOwnPropertyDescriptor(errors, ERROR_META)).toMatchObject({ enumerable: false, writable: false })
	})
})
