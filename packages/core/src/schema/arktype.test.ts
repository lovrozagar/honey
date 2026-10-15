import { type } from "arktype"
import { describe, expect, it } from "vitest"
import { arktypeJsonSchema } from "./arktype.ts"

describe("arktypeJsonSchema: from the schema's own converter", () => {
	it("uses the instance converter, and answers {} for a schema without one or whose converter throws", () => {
		const throwing = {
			toJsonSchema: () => {
				throw new Error("cannot")
			},
		}
		expect([arktypeJsonSchema(type({ id: "string" })), arktypeJsonSchema({}), arktypeJsonSchema(throwing)]).toEqual([
			{
				$schema: "https://json-schema.org/draft/2020-12/schema",
				properties: { id: { type: "string" } },
				required: ["id"],
				type: "object",
			},
			{},
			{},
		])
	})
})
