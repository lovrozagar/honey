import { describe, expect, it } from "vitest"
import * as z from "zod"
import { emitSchemaType } from "../../../src/type-emitter.ts"

describe("DEBUG: emitSchemaType", () => {
	it("debug z.string()", () => {
		const schema = z.string()
		console.log("\n=== DEBUG z.string() ===")
		console.log("Has ~standard?", "~standard" in schema)
		console.log("~standard value:", schema["~standard"])
		console.log("vendor:", schema["~standard"].vendor)
		console.log("_def:", (schema as any)._def)
		console.log("def:", (schema as any).def)
		const result = emitSchemaType(schema)
		console.log("emitSchemaType result:", result)
		console.log("Expected: string")
		expect(result).toBe("string")
	})
})
