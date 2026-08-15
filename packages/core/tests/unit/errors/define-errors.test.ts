import { describe, expect, it } from "vitest"
import { HoneyError } from "../../../src/error.ts"
import { defineErrors } from "../../../src/errors.ts"

describe("defineErrors", () => {
	it("creates factory with correct keys", () => {
		const errors = defineErrors({
			invalid_email: "bad_request",
			user_not_found: "not_found",
		})

		expect(errors.invalid_email).toBeTypeOf("function")
		expect(errors.user_not_found).toBeTypeOf("function")
	})

	it("each key returns a function that creates HoneyError", () => {
		const errors = defineErrors({
			something_broke: "internal_server_error",
		})

		const err = errors.something_broke()
		expect(err).toBeInstanceOf(HoneyError)
	})

	it("error has correct errorKey", () => {
		const errors = defineErrors({
			duplicate_record: "conflict",
		})

		const err = errors.duplicate_record()
		expect(err.errorKey).toBe("duplicate_record")
	})

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

	it("error has correct statusKey", () => {
		const errors = defineErrors({
			rate_limited: "too_many_requests",
		})

		const err = errors.rate_limited()
		expect(err.statusKey).toBe("too_many_requests")
	})

	it("supports vars parameter for i18n", () => {
		const errors = defineErrors({
			quota_exceeded: "bad_request",
		})

		const err = errors.quota_exceeded({ vars: { limit: 100, resource: "files" } })
		expect(err.vars).toEqual({ limit: 100, resource: "files" })
	})

	it("supports fields parameter", () => {
		const errors = defineErrors({
			validation_failed: "unprocessable_entity",
		})

		const fieldErrors = {
			email: [{ error_key: "invalid_email", message: "invalid format", path: "email" }],
		}
		const err = errors.validation_failed({ fields: fieldErrors })
		expect(err.fields).toEqual(fieldErrors)
	})

	it("supports cause parameter", () => {
		const errors = defineErrors({
			db_error: "internal_server_error",
		})

		const cause = new Error("connection refused")
		const err = errors.db_error({ cause })
		expect(err.cause).toBe(cause)
	})

	it("factory is an object with null prototype", () => {
		const errors = defineErrors({
			test_error: "bad_request",
		})

		expect(Object.getPrototypeOf(errors)).toBeNull()
	})

	it("multiple errors with same status key work", () => {
		const errors = defineErrors({
			email_taken: "conflict",
			slug_taken: "conflict",
			username_taken: "conflict",
		})

		const e1 = errors.email_taken()
		const e2 = errors.username_taken()
		const e3 = errors.slug_taken()

		expect(e1.status).toBe(409)
		expect(e2.status).toBe(409)
		expect(e3.status).toBe(409)

		expect(e1.errorKey).toBe("email_taken")
		expect(e2.errorKey).toBe("username_taken")
		expect(e3.errorKey).toBe("slug_taken")
	})

	it("error without opts has empty fields and no vars", () => {
		const errors = defineErrors({
			basic_error: "bad_request",
		})

		const err = errors.basic_error()
		expect(err.fields).toEqual({})
		expect(err.vars).toBeUndefined()
		expect(err.cause).toBeUndefined()
	})

	it("error message equals errorKey", () => {
		const errors = defineErrors({
			my_custom_error: "forbidden",
		})

		const err = errors.my_custom_error()
		expect(err.message).toBe("my_custom_error")
	})

	it("errors are independent instances", () => {
		const errors = defineErrors({
			reusable: "bad_request",
		})

		const e1 = errors.reusable({ vars: { x: 1 } })
		const e2 = errors.reusable({ vars: { x: 2 } })

		expect(e1.vars).toEqual({ x: 1 })
		expect(e2.vars).toEqual({ x: 2 })
		expect(e1).not.toBe(e2)
	})
})
