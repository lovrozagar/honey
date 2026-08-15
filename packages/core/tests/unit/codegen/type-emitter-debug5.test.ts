import { describe, it } from "vitest"
import * as z from "zod"

describe("DEBUG: Zod 4.3.6 _def deep inspection", () => {
	it("array type field", () => {
		const schema = z.array(z.string())
		const _def = (schema as unknown as Record<string, Record<string, unknown>>)._def
		console.log("\n=== array type field ===")
		console.log("_def.type:", _def.type)
		console.log("_def.type._def:", (_def.type as Record<string, unknown>)?._def)
		console.log(
			"_def.type._def.typeName:",
			((_def.type as Record<string, unknown>)?._def as Record<string, unknown>)?.typeName,
		)
	})

	it("object shape function", () => {
		const schema = z.object({ id: z.string(), name: z.string() })
		const _def = (schema as unknown as Record<string, Record<string, unknown>>)._def
		console.log("\n=== object shape ===")
		const shapeResult = (
			typeof _def.shape === "function" ? (_def.shape as () => unknown)() : _def.shape
		) as Record<string, unknown>
		console.log("shape result keys:", Object.keys(shapeResult))
		console.log("shape.id type:", typeof shapeResult.id)
		console.log(
			"shape.id._def.typeName:",
			((shapeResult.id as Record<string, unknown>)?._def as Record<string, unknown>)?.typeName,
		)
	})

	it("union options", () => {
		const schema = z.union([z.string(), z.number()])
		const _def = (schema as unknown as Record<string, Record<string, unknown>>)._def
		console.log("\n=== union options ===")
		console.log("options type:", typeof _def.options)
		console.log("options length:", (((_def.options as unknown[]) || []) as unknown[]).length)
		if (Array.isArray(_def.options)) {
			;(_def.options as Record<string, unknown>[]).forEach(
				(opt: Record<string, unknown>, i: number) => {
					console.log(
						`options[${i}]._def.typeName:`,
						(opt?._def as Record<string, unknown>)?.typeName,
					)
				},
			)
		}
	})

	it("nullable structure", () => {
		const schema = z.string().nullable()
		const _def = (schema as unknown as Record<string, Record<string, unknown>>)._def
		console.log("\n=== nullable ===")
		console.log("_def keys:", Object.keys(_def))
		console.log(
			"innerType._def.typeName:",
			((_def.innerType as Record<string, unknown>)?._def as Record<string, unknown>)?.typeName,
		)
	})

	it("literal structure", () => {
		const schema = z.literal("hello")
		const _def = (schema as unknown as Record<string, Record<string, unknown>>)._def
		console.log("\n=== literal ===")
		console.log("_def keys:", Object.keys(_def))
		console.log("_def.value:", _def.value)
	})

	it("enum structure", () => {
		const schema = z.enum(["a", "b", "c"])
		const _def = (schema as unknown as Record<string, Record<string, unknown>>)._def
		console.log("\n=== enum ===")
		console.log("_def keys:", Object.keys(_def))
		console.log("_def.values:", _def.values)
	})
})
