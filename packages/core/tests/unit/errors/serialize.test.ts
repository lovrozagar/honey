import { describe, expect, it } from "vitest"
import { HoneyError } from "../../../src/error.ts"

describe("HoneyError.serialize", () => {
	it("serializes non-Error values", () => {
		expect(HoneyError.serialize("oops")).toEqual({ message: "oops" })
		expect(HoneyError.serialize(42)).toEqual({ message: "42" })
		expect(HoneyError.serialize(null)).toEqual({ message: "null" })
		expect(HoneyError.serialize(undefined)).toEqual({ message: "undefined" })
	})

	it("serializes native Error with stack", () => {
		const err = new Error("boom")
		const result = HoneyError.serialize(err)

		expect(result.message).toBe("boom")
		expect(result.name).toBe("Error")
		expect(result.stack).toBeTypeOf("string")
		expect(result).not.toHaveProperty("errorKey")
	})

	it("serializes HoneyError with errorKey, status, statusKey", () => {
		const err = new HoneyError({
			errorKey: "user_not_found",
			status: "not_found",
		})
		const result = HoneyError.serialize(err)

		expect(result.errorKey).toBe("user_not_found")
		expect(result.status).toBe(404)
		expect(result.statusKey).toBe("not_found")
		expect(result.message).toBe("user_not_found")
		expect(result.name).toBe("Error")
		expect(result.stack).toBeTypeOf("string")
	})

	it("omits empty fields, includes non-empty fields", () => {
		const withoutFields = new HoneyError({
			errorKey: "bad",
			status: "bad_request",
		})
		expect(HoneyError.serialize(withoutFields)).not.toHaveProperty("fields")

		const withFields = new HoneyError({
			errorKey: "bad",
			fields: { email: [{ key: "required", message: "required" }] },
			status: "bad_request",
		})
		expect(HoneyError.serialize(withFields)).toHaveProperty("fields")
	})

	it("recursively serializes cause chain", () => {
		const root = new Error("root cause")
		const mid = new HoneyError({
			cause: root,
			errorKey: "db_error",
			status: "internal_server_error",
		})
		const top = new HoneyError({
			cause: mid,
			errorKey: "request_failed",
			status: "internal_server_error",
		})

		const result = HoneyError.serialize(top)
		expect(result.errorKey).toBe("request_failed")

		const midSerialized = result.cause as Record<string, unknown>
		expect(midSerialized.errorKey).toBe("db_error")

		const rootSerialized = midSerialized.cause as Record<string, unknown>
		expect(rootSerialized.message).toBe("root cause")
		expect(rootSerialized).not.toHaveProperty("cause")
	})

	it("handles non-Error cause values", () => {
		const err = new HoneyError({
			cause: "string cause",
			errorKey: "fail",
			status: "internal_server_error",
		})
		const result = HoneyError.serialize(err)
		const cause = result.cause as Record<string, unknown>
		expect(cause.message).toBe("string cause")
	})
})
