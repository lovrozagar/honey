import { describe, expect, it } from "vitest"
import { sanitizeZodJsonSchema } from "../../../src/codegen-sanitize.ts"

describe("sanitizeZodJsonSchema", () => {
	it("does not rewrite non-schema payloads such as example", () => {
		const out = sanitizeZodJsonSchema({
			example: { $schema: "keep", nested: { $schema: "keep-too" } },
			properties: { id: { $schema: "drop", type: "string" } },
			type: "object",
		})
		expect(out.example).toEqual({ $schema: "keep", nested: { $schema: "keep-too" } })
		expect(out.properties).toEqual({ id: { type: "string" } })
	})
})
