import { describe, it } from "vitest"
import * as z from "zod"

describe("DEBUG: Zod 4.3.6 _def structure for complex types", () => {
	it("inspect object structure", () => {
		const schema = z.object({ id: z.string(), name: z.string() })
		const _def = (schema as any)._def
		console.log("\n=== object _def ===")
		console.log("typeName:", _def.typeName)
		console.log("keys:", Object.keys(_def))
		console.log("shape type:", typeof _def.shape)
		console.log("shape keys:", Object.keys(_def.shape || {}))
		const firstKey = Object.keys(_def.shape || {})[0]
		console.log(`shape.${firstKey} typeName:`, (_def.shape?.[firstKey]?._def as any)?.typeName)
	})

	it("inspect array structure", () => {
		const schema = z.array(z.string())
		const _def = (schema as any)._def
		console.log("\n=== array _def ===")
		console.log("typeName:", _def.typeName)
		console.log("keys:", Object.keys(_def))
		console.log("element type:", typeof _def.element)
		console.log("element._def.typeName:", (_def.element?._def as any)?.typeName)
	})

	it("inspect optional structure", () => {
		const schema = z.string().optional()
		const _def = (schema as any)._def
		console.log("\n=== optional _def ===")
		console.log("typeName:", _def.typeName)
		console.log("keys:", Object.keys(_def))
		console.log("innerType type:", typeof _def.innerType)
		console.log("innerType._def.typeName:", (_def.innerType?._def as any)?.typeName)
	})
})
