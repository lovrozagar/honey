import { describe, expect, it } from "vitest"
import { ClientError, isClientError } from "../../../src/client/error.ts"

describe("ClientError redesign", () => {
	it("constructs with body generic", () => {
		const body = { error_key: "not_found", message: "Not found", status: 404 }
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
		expect(err.status).toBe(404)
		expect(err.response).toBe(res)
		expect(err.message).toBe("HTTP 404")
	})

	it("body carries custom error shape", () => {
		const body = { reason: "Item deleted", suggestions: ["/items/456"] }
		const res = new Response(null, { status: 404 })
		const err = new ClientError<typeof body>({
			body,
			message: "HTTP 404",
			response: res,
			status: 404,
		})

		expect(err.body.reason).toBe("Item deleted")
		expect(err.body.suggestions).toEqual(["/items/456"])
	})

	it("has correct name property", () => {
		const err = new ClientError({
			body: {},
			message: "HTTP 400",
			response: new Response(null, { status: 400 }),
			status: 400,
		})
		expect(err.name).toBe("ClientError")
	})

	it("does NOT have errorKey, statusKey, fields properties", () => {
		const err = new ClientError({
			body: { error_key: "test" },
			message: "HTTP 400",
			response: new Response(null, { status: 400 }),
			status: 400,
		})

		expect(err).not.toHaveProperty("errorKey")
		expect(err).not.toHaveProperty("statusKey")
		expect(err).not.toHaveProperty("fields")
	})
})

describe("isClientError redesign", () => {
	it("returns true for ClientError instances", () => {
		const err = new ClientError({
			body: {},
			message: "test",
			response: new Response(null, { status: 404 }),
			status: 404,
		})
		expect(isClientError(err)).toBe(true)
	})

	it("returns false for non-ClientError", () => {
		expect(isClientError(new Error("nope"))).toBe(false)
		expect(isClientError(null)).toBe(false)
		expect(isClientError(undefined)).toBe(false)
		expect(isClientError({})).toBe(false)
	})
})
