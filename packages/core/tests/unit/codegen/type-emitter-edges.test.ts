import { type } from "arktype"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { emitSchemaType } from "../../../src/type-emitter.ts"

describe("emitSchemaType — edge cases", () => {
	describe("valibot — pipe preserves base type", () => {
		it("pipe with minLength + maxLength", () => {
			const schema = v.pipe(v.string(), v.minLength(1), v.maxLength(100))
			expect(emitSchemaType(schema)).toBe("string")
		})

		it("pipe with integer", () => {
			const schema = v.pipe(v.number(), v.integer())
			expect(emitSchemaType(schema)).toBe("number")
		})
	})

	describe("valibot — nullish", () => {
		it("nullish string", () => {
			expect(emitSchemaType(v.nullish(v.string()))).toBe("string | null | undefined")
		})
	})

	describe("valibot — optional with complex inner", () => {
		it("optional array of numbers", () => {
			expect(emitSchemaType(v.optional(v.array(v.number())))).toBe("number[] | undefined")
		})
	})

	describe("valibot — nullable with complex inner", () => {
		it("nullable object", () => {
			const schema = v.nullable(v.object({ id: v.string() }))
			expect(emitSchemaType(schema)).toBe("{ id: string } | null")
		})
	})

	describe("valibot — union of literals", () => {
		it("string literal union", () => {
			const schema = v.union([v.literal("a"), v.literal("b")])
			expect(emitSchemaType(schema)).toBe('"a" | "b"')
		})
	})

	describe("valibot — deeply nested objects", () => {
		it("object with array of objects containing nested arrays", () => {
			const schema = v.object({
				users: v.array(
					v.object({
						name: v.string(),
						tags: v.array(v.string()),
					}),
				),
			})
			expect(emitSchemaType(schema)).toBe("{ users: { name: string; tags: string[] }[] }")
		})
	})

	describe("valibot — record with complex value", () => {
		it("record with array value", () => {
			const schema = v.record(v.string(), v.array(v.number()))
			expect(emitSchemaType(schema)).toBe("Record<string, number[]>")
		})
	})

	describe("valibot — tuple with optional element", () => {
		it("tuple with optional second element", () => {
			const schema = v.tuple([v.string(), v.optional(v.number())])
			expect(emitSchemaType(schema)).toBe("[string, number | undefined]")
		})
	})

	describe("arktype — nested array of objects with optionals", () => {
		it("array of objects with optional property", () => {
			const schema = type({
				users: type({ "age?": "number", name: "string" }).array(),
			})
			expect(emitSchemaType(schema)).toBe("{ users: { name: string; age?: number }[] }")
		})
	})

	describe("arktype — union including null", () => {
		it("string | number | null", () => {
			/* arktype sorts: number, string, null */
			expect(emitSchemaType(type("string | number | null"))).toBe("number | string | null")
		})
	})

	describe("arktype — number literal", () => {
		it("42 literal", () => {
			expect(emitSchemaType(type("42"))).toBe("42")
		})
	})

	describe("arktype — boolean union detection", () => {
		it("true | false collapses to boolean", () => {
			expect(emitSchemaType(type("true | false"))).toBe("boolean")
		})
	})

	describe("arktype — Date proto", () => {
		it("Date type", () => {
			expect(emitSchemaType(type("Date"))).toBe("Date")
		})
	})

	describe("arktype — bigint domain", () => {
		it("bigint", () => {
			expect(emitSchemaType(type("bigint"))).toBe("bigint")
		})
	})

	describe("arktype — nested arrays", () => {
		it("string[][]", () => {
			expect(emitSchemaType(type("string[][]"))).toBe("string[][]")
		})
	})

	describe("arktype — empty object", () => {
		it("{}", () => {
			expect(emitSchemaType(type({}))).toBe("{}")
		})
	})

	describe("cross-vendor consistency", () => {
		it("string across all vendors", () => {
			const zResult = emitSchemaType(z.string())
			const vResult = emitSchemaType(v.string())
			const aResult = emitSchemaType(type("string"))
			expect(zResult).toBe("string")
			expect(vResult).toBe("string")
			expect(aResult).toBe("string")
		})

		it("object with id across all vendors", () => {
			const zResult = emitSchemaType(z.object({ id: z.string() }))
			const vResult = emitSchemaType(v.object({ id: v.string() }))
			const aResult = emitSchemaType(type({ id: "string" }))
			expect(zResult).toBe("{ id: string }")
			expect(vResult).toBe("{ id: string }")
			expect(aResult).toBe("{ id: string }")
		})

		it("string array across all vendors", () => {
			const zResult = emitSchemaType(z.string().array())
			const vResult = emitSchemaType(v.array(v.string()))
			const aResult = emitSchemaType(type("string[]"))
			expect(zResult).toBe("string[]")
			expect(vResult).toBe("string[]")
			expect(aResult).toBe("string[]")
		})

		it("object with optional property across all vendors", () => {
			const zResult = emitSchemaType(z.object({ age: z.number().optional(), name: z.string() }))
			const vResult = emitSchemaType(v.object({ age: v.optional(v.number()), name: v.string() }))
			const aResult = emitSchemaType(type({ "age?": "number", name: "string" }))
			/* all three must emit ? for optional properties */
			expect(zResult).toContain("age?:")
			expect(vResult).toContain("age?:")
			expect(aResult).toContain("age?:")
			/* all three must keep required properties without ? */
			expect(zResult).toContain("name: string")
			expect(vResult).toContain("name: string")
			expect(aResult).toContain("name: string")
		})

		it("object with nullable (non-optional) property — no ? across vendors", () => {
			const zResult = emitSchemaType(z.object({ avatar: z.string().nullable() }))
			const vResult = emitSchemaType(v.object({ avatar: v.nullable(v.string()) }))
			expect(zResult).toBe("{ avatar: string | null }")
			expect(vResult).toBe("{ avatar: string | null }")
		})

		it("object with nullable+optional property across all vendors", () => {
			const zResult = emitSchemaType(z.object({ bio: z.string().nullable().optional() }))
			const vResult = emitSchemaType(v.object({ bio: v.optional(v.nullable(v.string())) }))
			expect(zResult).toContain("bio?:")
			expect(vResult).toContain("bio?:")
			expect(zResult).toContain("string | null | undefined")
			expect(vResult).toContain("string | null | undefined")
		})
	})
})
