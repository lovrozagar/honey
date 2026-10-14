import { describe, expect, it } from "vitest"
import * as z from "zod"
import type { HoneyError } from "../errors/error.ts"
import { paramsInput } from "./params.ts"

/** The error `run` throws. */
function thrown(run: () => unknown): HoneyError {
	try {
		run()
	} catch (error) {
		return error as HoneyError
	}
	throw new Error("did not throw")
}

describe("paramsInput: the route's params, validated", () => {
	// v0: 51b07873af
	// v0: bb1c3d0d10
	it("hands the schema the params and returns what it produced, coerced", () => {
		expect(paramsInput(z.object({ id: z.coerce.number(), orgId: z.string() }), { id: "42", orgId: "abc-123" })).toEqual(
			{
				id: 42,
				orgId: "abc-123",
			},
		)
	})

	// v0: 225f324cb4
	// v0: 39ca2fba1a
	it("a param the schema refuses is a 400 naming params.<name>", () => {
		const schema = z.object({ id: z.coerce.number(), uid: z.uuid() })
		const error = thrown(() => paramsInput(schema, { id: "abc", uid: "nope" }))
		expect([error.status, error.errorKey, Object.keys(error.fields), error.fields.uid?.[0]]).toEqual([
			400,
			"validation_failed",
			["id", "uid"],
			{ error_key: "field_invalid_format", message: expect.any(String), path: "params.uid" },
		])
	})

	// v0: fda8b40310
	it("without a schema (a readableStream entry) the params pass as they are", () => {
		const params = { id: "1" }
		expect(paramsInput(null, params)).toBe(params)
	})
})
