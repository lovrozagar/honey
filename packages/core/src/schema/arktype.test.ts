import { type } from "arktype"
import { describe, expect, it } from "vitest"
import { arktypeJsonSchema } from "./arktype.ts"

describe("arktypeJsonSchema: from the schema's own converter", () => {
	it("uses the instance converter, and answers {} for a schema without one or whose converter throws", () => {
		const throwing = {
			toJsonSchema: () => {
				throw new Error("cannot")
			},
		}
		expect([arktypeJsonSchema(type({ id: "string" })), arktypeJsonSchema({}), arktypeJsonSchema(throwing)]).toEqual([
			{
				$schema: "https://json-schema.org/draft/2020-12/schema",
				properties: { id: { type: "string" } },
				required: ["id"],
				type: "object",
			},
			{},
			{},
		])
	})
})

describe("arktypeJsonSchema: scalars and literals", () => {
	// v0: ac679e01e1
	// v0: d49b6a9439
	// v0: 942a4db7f1
	// v0: 5c034b9d84
	// v0: 38b15f8a47
	// v0: 6cbaaaed28
	// v0: bcf9d4c054
	// v0: 87328ec5a8
	// v0: f1e81a7b19
	// v0: a514e16c76
	it.each<[string, unknown, Record<string, unknown>]>([
		["string", type("string"), { type: "string" }],
		["number", type("number"), { type: "number" }],
		["boolean", type("boolean"), { type: "boolean" }],
		["null", type("null"), { type: "null" }],
		["a string literal", type({ tag: "'hello'" }), { properties: { tag: { const: "hello" } } }],
		["a literal union", type("'a' | 'b' | 'c'"), { enum: ["a", "b", "c"] }],
	])("%s", (_name, schema, expected) => {
		expect(arktypeJsonSchema(schema)).toMatchObject(expected)
	})
})

describe("arktypeJsonSchema: objects, arrays and unions", () => {
	// v0: 31fb2597ad
	// v0: bf2f0fd86d
	// v0: d2e1a38ca3
	// v0: 6eb8ac6fc6
	// v0: fafe6e4d81
	// v0: e4c6f6452c
	// v0: 16481179c6
	it.each<[string, unknown, Record<string, unknown>]>([
		[
			"an object with its required keys",
			type({ age: "number", name: "string" }),
			{ properties: { age: { type: "number" }, name: { type: "string" } }, required: ["age", "name"], type: "object" },
		],
		[
			"an optional key left out of required",
			type({ "age?": "number", name: "string" }),
			{ properties: { age: { type: "number" } }, required: ["name"] },
		],
		[
			"nested objects",
			type({ org: { address: { city: "string" }, name: "string" } }),
			{
				properties: {
					org: {
						properties: { address: { properties: { city: { type: "string" } }, required: ["city"], type: "object" } },
						type: "object",
					},
				},
			},
		],
		[
			"an array of strings",
			type({ tags: "string[]" }),
			{ properties: { tags: { items: { type: "string" }, type: "array" } } },
		],
		[
			"an array of objects",
			type({ name: "string" }).array(),
			{ items: { properties: { name: { type: "string" } }, type: "object" }, type: "array" },
		],
		["a union", type("string | number"), { anyOf: [{ type: "number" }, { type: "string" }] }],
	])("%s", (_name, schema, expected) => {
		expect(arktypeJsonSchema(schema)).toMatchObject(expected)
	})

	// v0: 89eff94a2b
	it("leaves an all-optional object without required keys", () => {
		const schema = arktypeJsonSchema(type({ "age?": "number", "name?": "string" })) as { required?: string[] }
		expect(schema.required ?? []).toEqual([])
	})
})
