import { describe, expect, it } from "vitest"
import { ClientError, isClientError } from "../../../src/client/error.ts"

describe("ClientError", () => {
	it("constructs with body and metadata", () => {
		const body = {
			error_key: "not_found",
			fields: { name: [{ error_key: "required", message: "Required", path: "name" }] },
			message: "Not found",
			status: 404,
			status_key: "not_found",
			success: false,
		}
		const res = new Response(null, { status: 404 })
		const err = new ClientError({
			body,
			message: "HTTP 404",
			response: res,
			status: 404,
		})

		expect(err).toBeInstanceOf(Error)
		expect(err).toBeInstanceOf(ClientError)
		expect(err.body).toBe(body)
		expect(err.body.error_key).toBe("not_found")
		expect(err.status).toBe(404)
		expect(err.message).toBe("HTTP 404")
		expect(err.response).toBe(res)
	})

	it("body can be any shape", () => {
		const body = { code: "ERR_CUSTOM", detail: "Something went wrong" }
		const res = new Response(null, { status: 500 })
		const err = new ClientError({
			body,
			message: "HTTP 500",
			response: res,
			status: 500,
		})

		expect(err.body).toBe(body)
	})

	it("has correct name property", () => {
		const res = new Response(null, { status: 400 })
		const err = new ClientError({
			body: {},
			message: "HTTP 400",
			response: res,
			status: 400,
		})
		expect(err.name).toBe("ClientError")
	})
})

describe("isClientError", () => {
	it("returns true for ClientError instances", () => {
		const err = new ClientError({
			body: { error_key: "not_found" },
			message: "HTTP 404",
			response: new Response(null, { status: 404 }),
			status: 404,
		})
		expect(isClientError(err)).toBe(true)
	})

	it("returns false for plain Error", () => {
		expect(isClientError(new Error("nope"))).toBe(false)
	})

	it("returns false for non-error values", () => {
		expect(isClientError(null)).toBe(false)
		expect(isClientError(undefined)).toBe(false)
		expect(isClientError("string")).toBe(false)
		expect(isClientError(42)).toBe(false)
		expect(isClientError({})).toBe(false)
	})
})
