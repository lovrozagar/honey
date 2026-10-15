import { describe, expect, it } from "vitest"
import * as z from "zod"
import * as zm from "zod/mini"
import { zodJsonSchema } from "./zod.ts"

/** `schema` with its JSON Schema converters taken away: only its definition left to walk. */
function stripped<T extends object>(schema: T): T {
	const bare = Object.create(schema) as T
	Object.defineProperty(bare, "~standard", { value: { validate: () => ({ value: null }), vendor: "zod", version: 1 } })
	Object.defineProperty(bare, "toJSONSchema", { value: undefined })
	return bare
}

const report = () => {}

describe("zodJsonSchema: walking the definition when no converter is published", () => {
	// v0: c42975aca8
	// v0: 543eeee5a9
	it("walks a schema that lost its converters, keeping formats and bounds from its checks", () => {
		const schema = z.object({
			email: z.string().email(),
			id: z.string().uuid(),
			n: z.number().min(1).max(10),
			tag: z.string().min(3),
		})
		expect(zodJsonSchema(stripped(schema), "output", report)).toMatchObject({
			properties: {
				email: { format: "email", type: "string" },
				id: { format: "uuid", type: "string" },
				n: { maximum: 10, minimum: 1, type: "number" },
				tag: { minLength: 3, type: "string" },
			},
			required: ["email", "id", "n", "tag"],
			type: "object",
		})
	})

	it("converts zod/mini, which publishes no converter, through its definition", () => {
		const schema = zm.object({
			at: zm.date(),
			kind: zm.enum(["a", "b"]),
			list: zm.array(zm.string()),
			maybe: zm.optional(zm.nullable(zm.number())),
			pair: zm.tuple([zm.string(), zm.boolean()]),
			rec: zm.record(zm.string(), zm.number()),
		})
		expect(zodJsonSchema(schema, "output", report)).toEqual({
			additionalProperties: false,
			properties: {
				at: { format: "date-time", type: "string" },
				kind: { enum: ["a", "b"], type: "string" },
				list: { items: { type: "string" }, type: "array" },
				maybe: { anyOf: [{ type: "number" }, { type: "null" }] },
				pair: {
					items: false,
					maxItems: 2,
					minItems: 2,
					prefixItems: [{ type: "string" }, { type: "boolean" }],
					type: "array",
				},
				rec: { additionalProperties: { type: "number" }, type: "object" },
			},
			required: ["at", "kind", "list", "pair", "rec"],
			type: "object",
		})
	})

	it("reads a default as optional going in and present coming out, on the walk too", () => {
		const schema = stripped(z.object({ page: z.number().default(1) }))
		expect([zodJsonSchema(schema, "input", report).required, zodJsonSchema(schema, "output", report).required]).toEqual(
			[undefined, ["page"]],
		)
	})
})

const STRING = { type: "string" }
const NUMBER = { type: "number" }

/** A closed object of one required key, as zod writes an output object. */
function closed(key: string, json: object) {
	return { additionalProperties: false, properties: { [key]: json }, required: [key], type: "object" }
}

/** The output JSON Schema properties of `shape`, walked: its converters taken away. */
function walked(shape: z.ZodRawShape) {
	return zodJsonSchema(stripped(z.object(shape)), "output", report).properties
}

describe("zodJsonSchema: scalars on the walk", () => {
	it("scalars, literals and enums, with their formats and bounds; Date and BigInt as they cross the wire", () => {
		expect(
			walked({
				any: z.any(),
				big: z.bigint(),
				bigLit: z.literal(1n),
				bool: z.boolean(),
				counted: z.array(z.string()).min(1).max(3),
				file: z.file(),
				int: z.int(),
				lits: z.literal(["x", 1]),
				mixed: z.enum({ A: "a", B: 1 }),
				nul: z.null(),
				numeric: z.enum({ A: 0, B: 1 }),
				over: z.number().gt(1).lt(9),
				pattern: z.string().regex(/^a+$/),
			}),
		).toEqual({
			any: {},
			big: { format: "int64", type: "integer" },
			bigLit: { const: 1 },
			bool: { type: "boolean" },
			counted: { items: STRING, maxItems: 3, minItems: 1, type: "array" },
			file: { contentEncoding: "binary", format: "binary", type: "string" },
			int: { maximum: Number.MAX_SAFE_INTEGER, minimum: Number.MIN_SAFE_INTEGER, type: "integer" },
			lits: { enum: ["x", 1] },
			mixed: { enum: ["a", 1] },
			nul: { type: "null" },
			numeric: { enum: [0, 1], type: "number" },
			over: { exclusiveMaximum: 9, exclusiveMinimum: 1, type: "number" },
			pattern: { pattern: "^a+$", type: "string" },
		})
	})
})

describe("zodJsonSchema: wrappers and composites on the walk", () => {
	it("wrappers, pipes and composites; an optional under nullable stays optional", () => {
		const shape = {
			both: z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })),
			caught: z.string().catch("x"),
			lazy: z.lazy(() => z.string()),
			loose: z.looseObject({ a: z.string() }),
			must: z.string().optional().nonoptional(),
			piped: z.string().pipe(z.coerce.number()),
			read: z.string().readonly(),
			rest: z.tuple([z.string()], z.number()),
			sometimes: z.string().optional().nullable(),
			strict: z.strictObject({ a: z.string() }),
			union: z.union([z.string(), z.number()]),
			when: z.number().default(() => 2),
		}
		expect(walked(shape)).toEqual({
			both: { allOf: [closed("a", STRING), closed("b", NUMBER)] },
			caught: STRING,
			lazy: STRING,
			loose: { additionalProperties: {}, properties: { a: STRING }, required: ["a"], type: "object" },
			must: STRING,
			piped: NUMBER,
			read: { readOnly: true, type: "string" },
			rest: { items: NUMBER, minItems: 1, prefixItems: [STRING], type: "array" },
			sometimes: { anyOf: [STRING, { type: "null" }] },
			strict: closed("a", STRING),
			union: { anyOf: [STRING, NUMBER] },
			when: { default: 2, type: "number" },
		})
		const input = zodJsonSchema(stripped(z.object(shape)), "input", report)
		expect([input.properties, input.required]).toMatchObject([
			{ piped: STRING },
			expect.not.arrayContaining(["sometimes", "when"]),
		])
	})
})

describe("zodJsonSchema: which converter, and what it could not say", () => {
	it("uses the instance converter zod 4.0 and 4.1 carry when Standard JSON Schema is missing", () => {
		const schema = z.object({ at: z.date() })
		const bare = Object.create(schema) as typeof schema
		Object.defineProperty(bare, "~standard", {
			value: { validate: () => ({ value: null }), vendor: "zod", version: 1 },
		})
		expect(zodJsonSchema(bare, "output", report)).toMatchObject({
			properties: { at: { format: "date-time", type: "string" } },
		})
	})

	it("degrades a node with no JSON Schema, a schema with no zod 4 definition, and a recursion past the bound", () => {
		type Tree = { children: Tree[] }
		const tree: z.ZodType<Tree> = z.object({ children: z.array(z.lazy(() => tree)) })
		const heard: (readonly string[])[] = []
		const hear = (nodes: readonly string[]) => void heard.push(nodes)
		/* zod 3 carries `_def`, not `_zod.def`, and no JSON Schema converter */
		const zod3 = { "~standard": { validate: () => ({}), vendor: "zod", version: 1 }, _def: { typeName: "ZodString" } }
		const custom = stripped(z.object({ data: z.custom<string>(), fn: z.map(z.string(), z.string()) }))
		expect([zodJsonSchema(custom, "output", hear).properties, zodJsonSchema(zod3, "output", hear)]).toEqual([
			{ data: {}, fn: {} },
			{},
		])
		expect(zodJsonSchema(stripped(tree), "output", hear)).toMatchObject({ type: "object" })
		expect(heard).toEqual([["custom", "map"], ["unrecognized"]])
	})
})
