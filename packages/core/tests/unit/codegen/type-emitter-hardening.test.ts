import { describe, expect, it } from "vitest"
import * as v from "valibot"
import * as z from "zod"
import { emitSchemaType } from "../../../src/type-emitter.ts"
import { createTypeEmitState } from "../../../src/type-emitter.ts"

describe("emitSchemaType — literals are written as source, never interpolated", () => {
	it("escapes quotes, backslashes and newlines in literals and keys", () => {
		expect(emitSchemaType(z.enum(['a"b', "c\\d", "e\nf"]))).toBe('"a\\"b" | "c\\\\d" | "e\\nf"')
		expect(emitSchemaType(z.literal('x"y'))).toBe('"x\\"y"')
		expect(emitSchemaType(z.object({ 'x"y': z.string(), "x-y": z.string() }))).toBe(
			'{ "x\\"y": string; "x-y": string }',
		)
		expect(emitSchemaType(v.picklist(['a"b', 1]))).toBe('"a\\"b" | 1')
	})

	it("numeric TS enums emit their values, without reverse mappings", () => {
		enum E {
			A = 1,
			B = 2,
		}
		expect(emitSchemaType(z.enum(E))).toBe("1 | 2")
		expect(emitSchemaType(v.enum(E))).toBe("1 | 2")
	})

	it("bigint literals keep their n", () => {
		expect(emitSchemaType(z.literal(5n))).toBe("5n")
	})
})

describe("emitSchemaType — shapes", () => {
	it("an intersection over a union keeps the union together", () => {
		const s = z.intersection(
			z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]),
			z.object({ c: z.string() }),
		)
		expect(emitSchemaType(s)).toBe("({ a: string } | { b: string }) & { c: string }")
	})

	it("tuple rest, map, set, nonoptional and functions", () => {
		expect(emitSchemaType(z.tuple([z.string()], z.number()))).toBe("[string, ...number[]]")
		expect(emitSchemaType(z.map(z.string(), z.number()))).toBe("Map<string, number>")
		expect(emitSchemaType(z.set(z.string()))).toBe("Set<string>")
		expect(emitSchemaType(z.string().optional().nonoptional())).toBe("Exclude<string | undefined, undefined>")
		expect(emitSchemaType(z.array(z.function()))).toBe("((...args: never[]) => unknown)[]")
	})

	it("Zod 4 getter recursion becomes a named alias instead of overflowing the stack", () => {
		const Category = z.object({
			name: z.string(),
			get subcategories() {
				return z.array(Category)
			},
		})
		const state = createTypeEmitState()
		const out = emitSchemaType(Category, state)
		expect(out).toBe("_Lazy0")
		expect(state.aliases.get("_Lazy0")).toBe("{ name: string; subcategories: _Lazy0[] }")
	})
})
