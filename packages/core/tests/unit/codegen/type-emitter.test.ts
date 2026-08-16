import { type } from "arktype"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { createTypeEmitState, emitSchemaType } from "../../../src/type-emitter.ts"

describe("emitSchemaType", () => {
	describe("zod — primitives", () => {
		it("string", () => {
			expect(emitSchemaType(z.string())).toBe("string")
		})

		it("number", () => {
			expect(emitSchemaType(z.number())).toBe("number")
		})

		it("boolean", () => {
			expect(emitSchemaType(z.boolean())).toBe("boolean")
		})

		it("undefined", () => {
			expect(emitSchemaType(z.undefined())).toBe("undefined")
		})

		it("null", () => {
			expect(emitSchemaType(z.null())).toBe("null")
		})

		it("any", () => {
			expect(emitSchemaType(z.any())).toBe("unknown")
		})

		it("unknown", () => {
			expect(emitSchemaType(z.unknown())).toBe("unknown")
		})

		it("void", () => {
			expect(emitSchemaType(z.void())).toBe("void")
		})

		it("date", () => {
			expect(emitSchemaType(z.date())).toBe("Date")
		})

		it("bigint", () => {
			expect(emitSchemaType(z.bigint())).toBe("bigint")
		})
	})

	describe("zod — literals", () => {
		it("string literal", () => {
			expect(emitSchemaType(z.literal("hello"))).toBe('"hello"')
		})

		it("number literal", () => {
			expect(emitSchemaType(z.literal(42))).toBe("42")
		})

		it("boolean literal", () => {
			expect(emitSchemaType(z.literal(true))).toBe("true")
		})
	})

	describe("zod — objects", () => {
		it("flat object", () => {
			const schema = z.object({ age: z.number(), name: z.string() })
			expect(emitSchemaType(schema)).toBe("{ age: number; name: string }")
		})

		it("nested object", () => {
			const schema = z.object({
				user: z.object({ active: z.boolean(), id: z.string() }),
			})
			expect(emitSchemaType(schema)).toBe("{ user: { active: boolean; id: string } }")
		})

		it("empty object", () => {
			expect(emitSchemaType(z.object({}))).toBe("{}")
		})

		it("optional property emits ?", () => {
			const schema = z.object({ age: z.number().optional(), name: z.string() })
			expect(emitSchemaType(schema)).toBe("{ age?: number | undefined; name: string }")
		})

		it("nullable optional property emits ?", () => {
			const schema = z.object({
				bio: z.string().nullable().optional(),
				name: z.string(),
			})
			expect(emitSchemaType(schema)).toBe("{ bio?: string | null | undefined; name: string }")
		})

		it("nullable (non-optional) property does NOT emit ?", () => {
			const schema = z.object({
				avatar: z.string().nullable(),
				name: z.string(),
			})
			expect(emitSchemaType(schema)).toBe("{ avatar: string | null; name: string }")
		})

		it("default-wrapped optional still emits ? (outer is default)", () => {
			const schema = z.object({
				count: z.number().optional().default(0),
				name: z.string(),
			})
			/* Zod 4 treats default-wrapped optional as still optional in the emitted object */
			expect(emitSchemaType(schema)).toContain("count?")
		})

		it("mixed required/optional/nullable properties", () => {
			const schema = z.object({
				avatar: z.string().nullable(),
				bio: z.string().nullable().optional(),
				email: z.string(),
				nickname: z.string().optional(),
			})
			const result = emitSchemaType(schema)
			expect(result).toContain("email: string")
			expect(result).toContain("nickname?: string | undefined")
			expect(result).toContain("avatar: string | null")
			expect(result).toContain("bio?: string | null | undefined")
		})
	})

	describe("zod — arrays", () => {
		it("string array", () => {
			expect(emitSchemaType(z.string().array())).toBe("string[]")
		})

		it("object array", () => {
			const schema = z.object({ id: z.string() }).array()
			expect(emitSchemaType(schema)).toBe("{ id: string }[]")
		})
	})

	describe("zod — optionals and nullables", () => {
		it("optional", () => {
			expect(emitSchemaType(z.string().optional())).toBe("string | undefined")
		})

		it("nullable", () => {
			expect(emitSchemaType(z.string().nullable())).toBe("string | null")
		})

		it("optional nullable", () => {
			expect(emitSchemaType(z.string().nullable().optional())).toBe("string | null | undefined")
		})
	})

	describe("zod — enums", () => {
		it("string enum", () => {
			expect(emitSchemaType(z.enum(["a", "b", "c"]))).toBe('"a" | "b" | "c"')
		})
	})

	describe("zod — unions and intersections", () => {
		it("union", () => {
			const schema = z.union([z.string(), z.number()])
			expect(emitSchemaType(schema)).toBe("string | number")
		})

		it("discriminated union", () => {
			const schema = z.discriminatedUnion("type", [
				z.object({ type: z.literal("a"), val: z.string() }),
				z.object({ type: z.literal("b"), val: z.number() }),
			])
			expect(emitSchemaType(schema)).toBe('{ type: "a"; val: string } | { type: "b"; val: number }')
		})

		it("intersection", () => {
			const schema = z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() }))
			expect(emitSchemaType(schema)).toBe("{ a: string } & { b: number }")
		})
	})

	describe("zod — records and tuples", () => {
		it("record", () => {
			expect(emitSchemaType(z.record(z.string(), z.number()))).toBe("Partial<Record<string, number>>")
		})

		it("tuple", () => {
			const schema = z.tuple([z.string(), z.number(), z.boolean()])
			expect(emitSchemaType(schema)).toBe("[string, number, boolean]")
		})
	})

	describe("zod — wrappers", () => {
		it("default", () => {
			expect(emitSchemaType(z.string().default("hi"))).toBe("string")
		})

		it("catch", () => {
			expect(emitSchemaType(z.string().catch("fallback"))).toBe("string")
		})

		it("lazy", () => {
			expect(emitSchemaType(z.lazy(() => z.string()))).toBe("string")
		})

		it("recursive lazy hoists a named alias", () => {
			type FieldSelection = {
				relations: Record<string, FieldSelection | null>
				scalars: string[]
			}
			const fieldSelectionSchema: z.ZodType<FieldSelection, FieldSelection> = z.lazy(() =>
				z.object({
					relations: z.record(z.string(), fieldSelectionSchema.nullable()),
					scalars: z.array(z.string()),
				}),
			)
			const state = createTypeEmitState()
			const emitted = emitSchemaType(fieldSelectionSchema, state)
			expect(emitted).toBe("_Lazy0")
			expect(state.aliases.get("_Lazy0")).toBe("{ relations: Record<string, _Lazy0 | null>; scalars: string[] }")
		})

		it("meta.tsType overrides the emitted type", () => {
			const schema = z.custom<{ raw: unknown }>().meta({ tsType: "import('x').Y | null" })
			expect(emitSchemaType(schema)).toBe("import('x').Y | null")
		})

		it("branded", () => {
			expect(emitSchemaType(z.string().brand("UserId"))).toBe("string")
		})

		it("readonly", () => {
			expect(emitSchemaType(z.object({ a: z.string() }).readonly())).toBe("Readonly<{ a: string }>")
		})

		it("pipe", () => {
			/* z.number() type incompatible with pipe() in Zod v4 — cast to work around */
			const piped = z.string().pipe(z.coerce.number())
			expect(emitSchemaType(piped as never)).toBe("number")
		})
	})

	describe("valibot — primitives", () => {
		it("string", () => {
			expect(emitSchemaType(v.string())).toBe("string")
		})

		it("number", () => {
			expect(emitSchemaType(v.number())).toBe("number")
		})

		it("boolean", () => {
			expect(emitSchemaType(v.boolean())).toBe("boolean")
		})

		it("undefined", () => {
			expect(emitSchemaType(v.undefined_())).toBe("undefined")
		})

		it("null", () => {
			expect(emitSchemaType(v.null_())).toBe("null")
		})

		it("unknown", () => {
			expect(emitSchemaType(v.unknown())).toBe("unknown")
		})

		it("void", () => {
			expect(emitSchemaType(v.void_())).toBe("void")
		})

		it("date", () => {
			expect(emitSchemaType(v.date())).toBe("Date")
		})

		it("bigint", () => {
			expect(emitSchemaType(v.bigint())).toBe("bigint")
		})
	})

	describe("valibot — literals", () => {
		it("string literal", () => {
			expect(emitSchemaType(v.literal("hello"))).toBe('"hello"')
		})

		it("number literal", () => {
			expect(emitSchemaType(v.literal(42))).toBe("42")
		})

		it("boolean literal", () => {
			expect(emitSchemaType(v.literal(true))).toBe("true")
		})
	})

	describe("valibot — objects", () => {
		it("flat object", () => {
			const schema = v.object({ age: v.number(), name: v.string() })
			expect(emitSchemaType(schema)).toBe("{ age: number; name: string }")
		})

		it("nested object", () => {
			const schema = v.object({
				user: v.object({ active: v.boolean(), id: v.string() }),
			})
			expect(emitSchemaType(schema)).toBe("{ user: { active: boolean; id: string } }")
		})

		it("empty object", () => {
			expect(emitSchemaType(v.object({}))).toBe("{}")
		})

		it("optional property emits ?", () => {
			const schema = v.object({
				age: v.optional(v.number()),
				name: v.string(),
			})
			expect(emitSchemaType(schema)).toBe("{ age?: number | undefined; name: string }")
		})

		it("nullish property emits ?", () => {
			const schema = v.object({
				bio: v.nullish(v.string()),
				name: v.string(),
			})
			expect(emitSchemaType(schema)).toBe("{ bio?: string | null | undefined; name: string }")
		})

		it("nullable (non-optional) property does NOT emit ?", () => {
			const schema = v.object({
				avatar: v.nullable(v.string()),
				name: v.string(),
			})
			expect(emitSchemaType(schema)).toBe("{ avatar: string | null; name: string }")
		})

		it("mixed required/optional/nullable/nullish properties", () => {
			const schema = v.object({
				avatar: v.nullable(v.string()),
				bio: v.nullish(v.string()),
				email: v.string(),
				nickname: v.optional(v.string()),
			})
			const result = emitSchemaType(schema)
			expect(result).toContain("email: string")
			expect(result).toContain("nickname?: string | undefined")
			expect(result).toContain("avatar: string | null")
			expect(result).toContain("bio?: string | null | undefined")
		})
	})

	describe("valibot — arrays", () => {
		it("string array", () => {
			expect(emitSchemaType(v.array(v.string()))).toBe("string[]")
		})

		it("object array", () => {
			const schema = v.array(v.object({ id: v.string() }))
			expect(emitSchemaType(schema)).toBe("{ id: string }[]")
		})
	})

	describe("valibot — optionals and nullables", () => {
		it("optional", () => {
			expect(emitSchemaType(v.optional(v.string()))).toBe("string | undefined")
		})

		it("nullable", () => {
			expect(emitSchemaType(v.nullable(v.string()))).toBe("string | null")
		})

		it("optional nullable", () => {
			expect(emitSchemaType(v.optional(v.nullable(v.string())))).toBe("string | null | undefined")
		})
	})

	describe("valibot — enums", () => {
		it("string enum", () => {
			expect(emitSchemaType(v.picklist(["a", "b", "c"]))).toBe('"a" | "b" | "c"')
		})
	})

	describe("valibot — unions and intersections", () => {
		it("union", () => {
			const schema = v.union([v.string(), v.number()])
			expect(emitSchemaType(schema)).toBe("string | number")
		})

		it("intersect", () => {
			const schema = v.intersect([v.object({ a: v.string() }), v.object({ b: v.number() })])
			expect(emitSchemaType(schema)).toBe("{ a: string } & { b: number }")
		})
	})

	describe("valibot — records and tuples", () => {
		it("record", () => {
			expect(emitSchemaType(v.record(v.string(), v.number()))).toBe("Record<string, number>")
		})

		it("tuple", () => {
			const schema = v.tuple([v.string(), v.number(), v.boolean()])
			expect(emitSchemaType(schema)).toBe("[string, number, boolean]")
		})
	})

	describe("valibot — wrappers", () => {
		it("pipe preserves base type", () => {
			const schema = v.pipe(v.string(), v.minLength(1))
			expect(emitSchemaType(schema)).toBe("string")
		})
	})

	describe("arktype — primitives", () => {
		it("string", () => {
			expect(emitSchemaType(type("string"))).toBe("string")
		})

		it("number", () => {
			expect(emitSchemaType(type("number"))).toBe("number")
		})

		it("boolean", () => {
			expect(emitSchemaType(type("boolean"))).toBe("boolean")
		})

		it("undefined", () => {
			expect(emitSchemaType(type("undefined"))).toBe("undefined")
		})

		it("null", () => {
			expect(emitSchemaType(type("null"))).toBe("null")
		})

		it("unknown", () => {
			expect(emitSchemaType(type("unknown"))).toBe("unknown")
		})

		it("bigint", () => {
			expect(emitSchemaType(type("bigint"))).toBe("bigint")
		})

		it("Date", () => {
			expect(emitSchemaType(type("Date"))).toBe("Date")
		})
	})

	describe("arktype — literals", () => {
		it("string literal", () => {
			expect(emitSchemaType(type("'hello'"))).toBe('"hello"')
		})

		it("number literal", () => {
			expect(emitSchemaType(type("42"))).toBe("42")
		})

		it("boolean literal", () => {
			expect(emitSchemaType(type("true"))).toBe("true")
		})
	})

	describe("arktype — objects", () => {
		it("flat object", () => {
			const schema = type({ age: "number", name: "string" })
			expect(emitSchemaType(schema)).toBe("{ age: number; name: string }")
		})

		it("nested object", () => {
			const schema = type({ user: { active: "boolean", id: "string" } })
			/* arktype sorts keys alphabetically */
			expect(emitSchemaType(schema)).toBe("{ user: { active: boolean; id: string } }")
		})

		it("empty object", () => {
			expect(emitSchemaType(type({}))).toBe("{}")
		})
	})

	describe("arktype — arrays", () => {
		it("string array", () => {
			expect(emitSchemaType(type("string[]"))).toBe("string[]")
		})

		it("object array", () => {
			const schema = type({ id: "string" }).array()
			expect(emitSchemaType(schema)).toBe("{ id: string }[]")
		})
	})

	describe("arktype — optionals", () => {
		it("optional property in object", () => {
			const schema = type({ "age?": "number", name: "string" })
			expect(emitSchemaType(schema)).toBe("{ name: string; age?: number }")
		})
	})

	describe("arktype — unions", () => {
		it("union", () => {
			/* arktype sorts union members alphabetically */
			expect(emitSchemaType(type("string | number"))).toBe("number | string")
		})
	})

	describe("arktype — literal union (enum-like)", () => {
		it("string literal union", () => {
			expect(emitSchemaType(type("'a' | 'b' | 'c'"))).toBe('"a" | "b" | "c"')
		})
	})

	describe("unknown vendor", () => {
		it("returns unknown for unrecognized vendor", () => {
			const fakeSchema = {
				"~standard": {
					types: undefined,
					validate: () => ({ value: null }),
					vendor: "my-custom-validator",
					version: 1,
				},
			}
			expect(emitSchemaType(fakeSchema)).toBe("unknown")
		})
	})
})
