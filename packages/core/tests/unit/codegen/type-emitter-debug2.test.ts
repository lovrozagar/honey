import { describe, it } from "vitest"
import * as z from "zod"

describe("DEBUG: Zod structure analysis", () => {
	it("analyze z.string() structure", () => {
		const schema = z.string()
		const s = schema as unknown as Record<string, unknown>
		console.log("\n=== Full schema keys ===")
		console.log(Object.keys(schema).slice(0, 20))

		console.log("\n=== _def structure ===")
		const _def = s._def as Record<string, unknown>
		console.log("_def keys:", Object.keys(_def))
		console.log("_def values:", JSON.stringify(_def, null, 2))

		console.log("\n=== Looking for type ===")
		console.log("_def.type:", _def.type)
		console.log("_def.typeName:", _def.typeName)

		console.log("\n=== Looking in schema root ===")
		console.log("schema.type:", s.type)
		console.log("schema.typeName:", s.typeName)

		console.log("\n=== Looking in _zod ===")
		const zodObj = (s as Record<string, unknown>)._zod as Record<string, unknown> | undefined
		if (zodObj) {
			console.log("_zod.def:", zodObj.def)
		}
	})
})
