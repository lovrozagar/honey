import { JSONSchema, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { effectJsonSchema } from "./effect.ts"

describe("effectJsonSchema: through the converter its caller passes", () => {
	const schema = Schema.standardSchemaV1(Schema.Struct({ at: Schema.Date, name: Schema.String }))

	it("converts with JSONSchema.make, its $defs kept for the slots to hoist", () => {
		expect(effectJsonSchema(schema, JSONSchema.make)).toEqual({
			$defs: { Date: { description: "a string to be decoded into a Date", type: "string" } },
			$schema: "http://json-schema.org/draft-07/schema#",
			additionalProperties: false,
			properties: { at: { $ref: "#/$defs/Date" }, name: { type: "string" } },
			required: ["at", "name"],
			type: "object",
		})
	})

	it("is null without a converter, for the dispatch to report", () => {
		expect(effectJsonSchema(schema, undefined)).toBeNull()
	})
})
