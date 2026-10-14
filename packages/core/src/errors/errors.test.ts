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
	// v0: b05608688e
	// v0: 934d2fcdb5
	it("creates factory with correct keys", () => {
		const errors = defineErrors({ invalid_email: "bad_request", user_not_found: "not_found" })
		expect(errors.invalid_email).toBeTypeOf("function")
		expect(errors.user_not_found).toBeTypeOf("function")
	})

	// v0: fa4dc9ccf0
	// v0: aa1659aa9a
	// v0: e39e69ae6d
	it("each key returns a function that creates HoneyError", () => {
		expect(defineErrors({ something_broke: "internal_server_error" }).something_broke()).toBeInstanceOf(HoneyError)
		expect(defineErrors({ user_not_found: "not_found" }).user_not_found()).toMatchObject({
			errorKey: "user_not_found",
			status: 404,
			statusKey: "not_found",
		})
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
})

describe("defineErrors: each error's key, status and vars", () => {
	// v0: 072a31d246
	it("error has correct statusKey", () => {
		expect(defineErrors({ rate_limited: "too_many_requests" }).rate_limited().statusKey).toBe("too_many_requests")
	})

	// v0: ed8479919f
	// v0: 031acbb57a
	// v0: 6a6627d231
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
	// v0: a0e072cc9f
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
})

describe("defineErrors options: messages, instances and what passes through", () => {
	// v0: 1d79b9cfea
	it("error message equals errorKey", () => {
		expect(defineErrors({ my_custom_error: "forbidden" }).my_custom_error().message).toBe("my_custom_error")
	})

	// v0: a8cced71c2
	// v0: c5176a28ca
	it("errors are independent instances", () => {
		const errors = defineErrors({ reusable: "bad_request" })
		const e1 = errors.reusable({ vars: { x: 1 } })
		const e2 = errors.reusable({ vars: { x: 2 } })
		expect(e1.vars).toEqual({ x: 1 })
		expect(e2.vars).toEqual({ x: 2 })
		expect(e1).not.toBe(e2)
	})

	// v0: e90b769661
	// v0: 254ffb4bfd
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

const schemaErrors = () =>
	defineErrors({
		email_taken: "conflict",
		item_not_found: { schema: schemaOf<{ reason: string; suggestions: string[] }>(), status: "not_found" },
		unauthorized: "unauthorized",
	})

describe("defineErrors with custom schemas", () => {
	const errors = schemaErrors()

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
})

describe("defineErrors with custom schemas: the error itself", () => {
	const errors = schemaErrors()

	// v0: 55d47c1a77
	// v0: 486423a06e
	// v0: 59901fa255
	// v0: 2b6499a285
	// v0: 39e68a711e
	it("a schema error is an Error and a HoneyError, fresh per call, keeping its payload by reference", () => {
		const nested = { reason: "deep", suggestions: ["/a"] }
		const [first, second] = [errors.item_not_found(nested), errors.item_not_found({ reason: "b", suggestions: [] })]
		const empty = defineErrors({ empty_body: { schema: schemaOf<object>(), status: "bad_request" } }).empty_body({})
		expect([first instanceof Error, first instanceof HoneyError, first.stack?.includes("item_not_found")]).toEqual([
			true,
			true,
			true,
		])
		expect([first === second, first.data === nested, second.data, empty.data, empty.status]).toEqual([
			false,
			true,
			{ reason: "b", suggestions: [] },
			{},
			400,
		])
		expect([errors.email_taken().data, errors.email_taken().errorKey]).toEqual([undefined, "email_taken"])
	})
})

describe("defineErrors with custom schemas: what a schema error leaves out, and its metadata", () => {
	const errors = schemaErrors()

	// v0: a779c3cd99
	it("custom schema error has no fields/vars (those are standard-only)", () => {
		const err = errors.item_not_found({ reason: "gone", suggestions: [] })
		expect(err.fields).toEqual({})
		expect(err.vars).toBeUndefined()
	})

	// v0: 0c49253646
	// v0: 8f05ffa447
	// v0: 90e055d862
	// v0: 8f002a863a
	it("every factory returns a HoneyError: a standard one given cause, fields and vars, a schema one its payload", () => {
		const standard = defineErrors({ email_taken: "conflict" })
		expectTypeOf(standard.email_taken()).toEqualTypeOf<HoneyError>()
		expectTypeOf(
			standard.email_taken({ cause: "test", fields: {}, vars: { email: "a@b.c", message: "custom" } }),
		).toEqualTypeOf<HoneyError>()
		expectTypeOf(errors.item_not_found({ reason: "gone", suggestions: [] })).toEqualTypeOf<HoneyError>()
		// @ts-expect-error a schema error takes its payload, not the standard options
		errors.item_not_found({ vars: {} })
	})

	// v0: 03c988163b
	it("ERROR_META exposes schema metadata for codegen", () => {
		const meta = errors[ERROR_META]
		expect(meta.email_taken).toEqual({ schema: null, statusKey: "conflict" })
		expect(meta.item_not_found.statusKey).toBe("not_found")
		expect(meta.item_not_found.schema).toHaveProperty("~standard")
	})

	// v0: 5ab50ccc16
	// v0: 0bf85a7506
	it("ERROR_META is not enumerable", () => {
		expect(Object.keys(errors)).toEqual(["email_taken", "item_not_found", "unauthorized"])
		expect(Object.getOwnPropertyDescriptor(errors, ERROR_META)).toMatchObject({ enumerable: false, writable: false })
	})
})
