import { describe, expect, expectTypeOf, it } from "vitest"
import { HoneyError } from "../../../src/error.ts"
import { defineErrors } from "../../../src/errors.ts"
import type { FieldError } from "../../../src/types.ts"

describe("HoneyError", () => {
	it("constructs with correct status code from StatusKey", () => {
		const err = new HoneyError({ errorKey: "test", status: "conflict" })
		expect(err.status).toBe(409)
		expect(err.statusKey).toBe("conflict")
		expect(err.errorKey).toBe("test")
	})

	it("is instanceof Error", () => {
		const err = new HoneyError({ errorKey: "test", status: "bad_request" })
		expect(err).toBeInstanceOf(Error)
		expect(err).toBeInstanceOf(HoneyError)
	})

	it("stack trace contains errorKey", () => {
		const err = new HoneyError({ errorKey: "my_custom_error", status: "bad_request" })
		expect(err.stack).toContain("my_custom_error")
	})

	it("cause on native Error.cause", () => {
		const cause = new Error("db failed")
		const err = new HoneyError({ cause, errorKey: "test", status: "bad_request" })
		expect(err.cause).toBe(cause)
	})

	it("fields defaults to {} when not provided", () => {
		const err = new HoneyError({ errorKey: "test", status: "bad_request" })
		expect(err.fields).toEqual({})
	})

	it("vars is undefined when not provided", () => {
		const err = new HoneyError({ errorKey: "test", status: "bad_request" })
		expect(err.vars).toBeUndefined()
	})

	it("accepts fields", () => {
		const fields: Record<string, FieldError[]> = {
			email: [{ error_key: "field_invalid_email", message: "bad email", path: "json.email" }],
		}
		const err = new HoneyError({ errorKey: "test", fields, status: "bad_request" })
		expect(err.fields).toBe(fields)
	})

	it("accepts vars", () => {
		const vars = { slug: "my-org" }
		const err = new HoneyError({ errorKey: "test", status: "conflict", vars })
		expect(err.vars).toBe(vars)
	})

	it("message is initially errorKey", () => {
		const err = new HoneyError({ errorKey: "org_slug_taken", status: "conflict" })
		expect(err.message).toBe("org_slug_taken")
	})
})

describe("defineErrors", () => {
	const errors = defineErrors({
		email_taken: "conflict",
		org_limit_reached: "forbidden",
		org_slug_taken: "conflict",
	})

	it("returns object with correct keys", () => {
		expect(errors).toHaveProperty("org_slug_taken")
		expect(errors).toHaveProperty("org_limit_reached")
		expect(errors).toHaveProperty("email_taken")
	})

	it("each key is a callable factory", () => {
		expect(typeof errors.org_slug_taken).toBe("function")
		expect(typeof errors.org_limit_reached).toBe("function")
	})

	it("factory returns fresh HoneyError each call", () => {
		const a = errors.org_slug_taken()
		const b = errors.org_slug_taken()
		expect(a).not.toBe(b)
		expect(a).toBeInstanceOf(HoneyError)
	})

	it("factory cause passed through", () => {
		const cause = new Error("db")
		const err = errors.org_slug_taken({ cause })
		expect(err.cause).toBe(cause)
	})

	it("factory vars passed through", () => {
		const err = errors.org_slug_taken({ vars: { slug: "test" } })
		expect(err.vars).toEqual({ slug: "test" })
	})

	it("factory fields passed through", () => {
		const fields: Record<string, FieldError[]> = {
			slug: [{ error_key: "taken", message: "taken", path: "json.slug" }],
		}
		const err = errors.org_slug_taken({ fields })
		expect(err.fields).toBe(fields)
	})

	it("factory headers passed through", () => {
		const err = errors.org_slug_taken({ headers: { "x-custom": "value" } })
		expect(err.headers).toEqual({ "x-custom": "value" })
	})

	it("factory without headers has undefined headers", () => {
		const err = errors.org_slug_taken()
		expect(err.headers).toBeUndefined()
	})

	it("factory sets correct errorKey and status", () => {
		const err = errors.org_slug_taken()
		expect(err.errorKey).toBe("org_slug_taken")
		expect(err.status).toBe(409)
		expect(err.statusKey).toBe("conflict")
	})
})

describe("error response headers", () => {
	it("thrown error without headers has only content-type", async () => {
		const { honey } = await import("../../../src/index.ts")
		const errors = defineErrors({ broken: "internal_server_error" })
		const app = honey<{}>().errorFactory(errors)
		app
			.get("/fail")
			.errors("broken")
			.handler(() => {
				throw errors.broken()
			})
		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(500)
		expect(res.headers.get("content-type")).toContain("application/json")
		const headerKeys = [...res.headers.keys()]
		expect(headerKeys).not.toContain("retry-after")
	})

	it("boundary error does not leak headers from undeclared error", async () => {
		const { honey } = await import("../../../src/index.ts")
		const errors = defineErrors({
			internal_server_error: "internal_server_error",
			secret_err: "bad_request",
		})
		const app = honey<{}>().errorFactory(errors).defaultBoundary("internal_server_error")
		/* route only declares internal_server_error, not secret_err */
		app.get("/leak").handler(() => {
			throw errors.secret_err({ headers: { "x-debug": "leaked" } })
		})
		const res = await app.fetch(new Request("http://localhost/leak"), {})
		expect(res.status).toBe(500)
		expect(res.headers.get("x-debug")).toBeNull()
	})

	it("thrown error with headers includes them in response", async () => {
		const { honey } = await import("../../../src/index.ts")
		const errors = defineErrors({ rate_limited: "too_many_requests" })
		const app = honey<{}>().errorFactory(errors)
		app
			.get("/limited")
			.errors("rate_limited")
			.handler(() => {
				throw errors.rate_limited({ headers: { "retry-after": "60" } })
			})
		const res = await app.fetch(new Request("http://localhost/limited"), {})
		expect(res.status).toBe(429)
		expect(res.headers.get("retry-after")).toBe("60")
		expect(res.headers.get("content-type")).toContain("application/json")
	})

	it("headers survive errorFormatter", async () => {
		const { honey } = await import("../../../src/index.ts")
		const errors = defineErrors({ rate_limited: "too_many_requests" })
		const app = honey<{}>()
			.errorFactory(errors)
			.defaultErrorFormatter((_err, shape) => ({ ...shape, custom: true }))
		app
			.get("/limited")
			.errors("rate_limited")
			.handler(() => {
				throw errors.rate_limited({ headers: { "retry-after": "30" } })
			})
		const res = await app.fetch(new Request("http://localhost/limited"), {})
		expect(res.status).toBe(429)
		expect(res.headers.get("retry-after")).toBe("30")
		const body = (await res.json()) as Record<string, unknown>
		expect(body.custom).toBe(true)
	})
})

describe("type-level", () => {
	it("defineErrors with translations narrows vars via ExtractICUVars", () => {
		type Translations = {
			org_slug_taken: "Slug {slug} is taken"
		}
		const errors = defineErrors<{ org_slug_taken: "conflict" }, Translations>({
			org_slug_taken: "conflict",
		})

		/* should compile — vars has slug */
		const _err = errors.org_slug_taken({ vars: { slug: "test" } })
		expectTypeOf(_err).toMatchTypeOf<HoneyError>()
	})
})
