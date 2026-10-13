import { describe, it } from "vitest"
import * as z from "zod"

describe("DEBUG: Zod 4.3.6 typeName values", () => {
	it("inspect various types", () => {
		const types = {
			array: z.array(z.string()),
			boolean: z.boolean(),
			date: z.date(),
			null: z.null(),
			nullable: z.string().nullable(),
			number: z.number(),
			object: z.object({}),
			optional: z.string().optional(),
			string: z.string(),
			undefined: z.undefined(),
			union: z.union([z.string(), z.number()]),
		}

		console.log("\n=== Zod 4.3.6 typeName values ===")
		for (const [name, schema] of Object.entries(types)) {
			const _def = (schema as any)._def
			console.log(`${name}: typeName = "${_def.typeName || "undefined"}"`)
		}
	})
})
