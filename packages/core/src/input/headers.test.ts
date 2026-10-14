import { describe, expect, it } from "vitest"
import * as z from "zod"
import type { HoneyError } from "../errors/error.ts"
import { headersInput } from "./headers.ts"

/** ctx.headers for `init`: lowercased names, Fetch-joined values. */
const headersOf = (init: HeadersInit) => Object.fromEntries(new Headers(init))

/** The error `run` throws. */
function thrown(run: () => unknown): HoneyError {
	try {
		run()
	} catch (error) {
		return error as HoneyError
	}
	throw new Error("did not throw")
}

const auth = z.object({ authorization: z.string().startsWith("Bearer ") })

describe("headersInput: the request headers, validated", () => {
	// v0: 7e2fee1a16
	// v0: b34c7430bf
	// v0: 09dc6ef772
	it("hands the schema lowercased names, and returns what it produced", () => {
		const schema = auth.extend({ "x-custom": z.string(), "x-page": z.coerce.number() })
		const headers = headersOf({ Authorization: "Bearer t", "X-Custom": "val", "X-Page": "3" })
		expect(headersInput(schema, headers)).toEqual({ authorization: "Bearer t", "x-custom": "val", "x-page": 3 })
	})

	// v0: 51e1bb305b
	// v0: ca0f7ed2a3
	it("an invalid or missing header is a 400 naming headers.<name>", () => {
		const invalid = thrown(() => headersInput(auth, headersOf({ authorization: "Basic x" })))
		const missing = thrown(() => headersInput(auth, headersOf({})))
		expect([
			invalid.status,
			invalid.fields.authorization?.[0]?.path,
			missing.status,
			missing.fields.authorization?.[0]?.path,
		]).toEqual([400, "headers.authorization", 400, "headers.authorization"])
	})

	it("without a schema (a readableStream entry) the headers pass as they are", () => {
		const headers = headersOf({ a: "1" })
		expect(headersInput(null, headers)).toBe(headers)
	})
})
