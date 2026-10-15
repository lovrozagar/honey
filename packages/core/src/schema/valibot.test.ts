import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { valibotJsonSchema } from "./valibot.ts"

const STRING = { type: "string" }
const NUMBER = { type: "number" }

describe("valibotJsonSchema: scalars", () => {
	// v0: 036c68781a
	// v0: 22df6f664f
	// v0: 7599848c52
	// v0: 48a4e529d9
	// v0: 2c1c00b106
	// v0: b9e59dda83
	// v0: c66db053f8
	// v0: 05ae76480a
	// v0: 70cdea1f7d
	// v0: 35b13eaa06
	// v0: f5912c9c65
	it.each([
		["string", v.string(), STRING],
		["number", v.number(), NUMBER],
		["boolean", v.boolean(), { type: "boolean" }],
		["bigint", v.bigint(), { format: "int64", type: "integer" }],
		["date", v.date(), { format: "date-time", type: "string" }],
		["null", v.null(), { type: "null" }],
		["a string literal", v.literal("hello"), { const: "hello" }],
		["a number literal", v.literal(42), { const: 42 }],
		["a boolean literal", v.literal(true), { const: true }],
		["a picklist", v.picklist(["active", "inactive", "pending"]), { enum: ["active", "inactive", "pending"] }],
		["an enum", v.enum({ Admin: "admin", User: "user" }), { enum: ["admin", "user"] }],
	] as const)("%s", (_name, schema, expected) => {
		expect(valibotJsonSchema(schema)).toEqual(expected)
	})
})

describe("valibotJsonSchema: objects", () => {
	// v0: 211b3b85c9
	// v0: 19a56bc07a
	// v0: d4f2c26079
	// v0: 32654a0f30
	// v0: fa2225441b
	// v0: c221b8b152
	// v0: 7770f21578
	// v0: a8de027499
	it("lists every key a value is required for; optional, nullish and exact-optional keys are not", () => {
		expect([
			valibotJsonSchema(v.object({ age: v.number(), name: v.string() })),
			valibotJsonSchema(v.object({ bio: v.optional(v.string()), name: v.string() })),
			valibotJsonSchema(v.object({ a: v.optional(v.string()), b: v.optional(v.number()) })),
			valibotJsonSchema(v.object({ address: v.object({ city: v.string() }), name: v.string() })),
			valibotJsonSchema(v.object({})),
			valibotJsonSchema(v.object({ a: v.nullish(v.string()), b: v.exactOptional(v.string()), c: v.string() })),
		]).toEqual([
			{ properties: { age: NUMBER, name: STRING }, required: ["age", "name"], type: "object" },
			{ properties: { bio: STRING, name: STRING }, required: ["name"], type: "object" },
			{ properties: { a: STRING, b: NUMBER }, type: "object" },
			{
				properties: { address: { properties: { city: STRING }, required: ["city"], type: "object" }, name: STRING },
				required: ["address", "name"],
				type: "object",
			},
			{ type: "object" },
			{
				properties: { a: { anyOf: [STRING, { type: "null" }] }, b: STRING, c: STRING },
				required: ["c"],
				type: "object",
			},
		])
	})

	// v0: 5b786778fc
	// v0: 5d0beae33d
	// v0: 334e470801
	it("a strict object forbids extra keys; a loose one allows them; a rest schema and a record describe them", () => {
		const named = { properties: { name: STRING }, required: ["name"], type: "object" }
		expect([
			valibotJsonSchema(v.strictObject({ a: v.string() })),
			valibotJsonSchema(v.looseObject({ a: v.string() })),
			valibotJsonSchema(v.objectWithRest({ a: v.string() }, v.number())),
			valibotJsonSchema(v.record(v.string(), v.number())),
			valibotJsonSchema(v.record(v.string(), v.object({ name: v.string() }))),
		]).toEqual([
			{ additionalProperties: false, properties: { a: STRING }, required: ["a"], type: "object" },
			{ properties: { a: STRING }, required: ["a"], type: "object" },
			{ additionalProperties: NUMBER, properties: { a: STRING }, required: ["a"], type: "object" },
			{ additionalProperties: NUMBER, type: "object" },
			{ additionalProperties: named, type: "object" },
		])
	})
})

describe("valibotJsonSchema: arrays, tuples and wrappers", () => {
	// v0: 3e090a81dc
	// v0: 5449960bc7
	// v0: dd72813a0d
	// v0: 074abf6c9f
	it("an array has its items; a tuple its fixed prefix and nothing after", () => {
		expect([
			valibotJsonSchema(v.array(v.string())),
			valibotJsonSchema(v.array(v.object({ id: v.number() }))),
			valibotJsonSchema(v.tuple([v.string(), v.number()])),
			valibotJsonSchema(v.tuple([v.boolean()])),
		]).toEqual([
			{ items: STRING, type: "array" },
			{ items: { properties: { id: NUMBER }, required: ["id"], type: "object" }, type: "array" },
			{ items: false, maxItems: 2, minItems: 2, prefixItems: [STRING, NUMBER], type: "array" },
			{ items: false, maxItems: 1, minItems: 1, prefixItems: [{ type: "boolean" }], type: "array" },
		])
	})

	// v0: 893e4102cf
	// v0: be57c66ced
	// v0: 8ca78418ad
	// v0: ad03da8ea1
	// v0: df40abf80f
	// v0: 55fd71c801
	// v0: 022d49d905
	it("optional unwraps to its inner schema; nullable and nullish are its union with null", () => {
		const object = { properties: { id: STRING }, required: ["id"], type: "object" }
		expect([
			valibotJsonSchema(v.optional(v.string())),
			valibotJsonSchema(v.optional(v.number())),
			valibotJsonSchema(v.nullable(v.string())),
			valibotJsonSchema(v.nullable(v.object({ id: v.string() }))),
			valibotJsonSchema(v.nullish(v.string())),
			valibotJsonSchema(v.nullish(v.number())),
			valibotJsonSchema(v.object({ data: v.nullable(v.string()) })),
		]).toEqual([
			STRING,
			NUMBER,
			{ anyOf: [STRING, { type: "null" }] },
			{ anyOf: [object, { type: "null" }] },
			{ anyOf: [STRING, { type: "null" }] },
			{ anyOf: [NUMBER, { type: "null" }] },
			{ properties: { data: { anyOf: [STRING, { type: "null" }] } }, required: ["data"], type: "object" },
		])
	})
})

describe("valibotJsonSchema: unions, intersections, pipes and the rest", () => {
	// v0: 456d94e2ec
	// v0: 6db8e0f077
	// v0: b3d57f413f
	// v0: d66ff776c0
	it("a union and a variant are anyOf, an intersection allOf; lazy resolves; a file is binary", () => {
		const a = { properties: { a: STRING }, required: ["a"], type: "object" }
		expect([
			valibotJsonSchema(v.union([v.string(), v.number()])),
			valibotJsonSchema(v.union([v.string(), v.number(), v.boolean()])),
			valibotJsonSchema(v.intersect([v.object({ a: v.string() }), v.object({ b: v.number() })])),
			valibotJsonSchema(v.variant("k", [v.object({ k: v.literal("a") }), v.object({ k: v.literal("b") })])),
			valibotJsonSchema(v.lazy(() => v.string())),
			valibotJsonSchema(v.file()),
		]).toEqual([
			{ anyOf: [STRING, NUMBER] },
			{ anyOf: [STRING, NUMBER, { type: "boolean" }] },
			{ allOf: [a, { properties: { b: NUMBER }, required: ["b"], type: "object" }] },
			{
				anyOf: [
					{ properties: { k: { const: "a" } }, required: ["k"], type: "object" },
					{ properties: { k: { const: "b" } }, required: ["k"], type: "object" },
				],
			},
			STRING,
			{ contentEncoding: "binary", format: "binary", type: "string" },
		])
	})
})

describe("valibotJsonSchema: pipes and recursion", () => {
	// v0: f01da8ffdd
	// v0: 6945c4d741
	// v0: 06dd8f07a0
	it("a pipe keeps the constraints JSON Schema can say", () => {
		expect([
			valibotJsonSchema(v.pipe(v.string(), v.minLength(1))),
			valibotJsonSchema(v.pipe(v.number(), v.minValue(0))),
			valibotJsonSchema(v.pipe(v.string(), v.email())),
			valibotJsonSchema(v.pipe(v.number(), v.integer())),
		]).toEqual([
			{ minLength: 1, type: "string" },
			{ minimum: 0, type: "number" },
			{ format: "email", type: "string" },
			{ type: "integer" },
		])
	})

	// v0: 7f0f15f92d
	// v0: d16fb4e280
	it("a recursive lazy schema terminates, and a nested output keeps every level", () => {
		type Node = { children: Node[] }
		const node: v.GenericSchema<Node> = v.object({ children: v.array(v.lazy(() => node)) })
		const items = v.object({ count: v.number(), items: v.array(v.object({ id: v.string(), name: v.string() })) })
		expect(valibotJsonSchema(node)).toMatchObject({ properties: { children: { type: "array" } }, type: "object" })
		expect(valibotJsonSchema(items)).toEqual({
			properties: {
				count: NUMBER,
				items: {
					items: { properties: { id: STRING, name: STRING }, required: ["id", "name"], type: "object" },
					type: "array",
				},
			},
			required: ["count", "items"],
			type: "object",
		})
	})
})

describe("valibotJsonSchema: the rarer actions, tuple rests and defaults", () => {
	it("keeps a pipe's pattern, exact length, upper bounds and description, skips a transform, and counts an array's items", () => {
		expect([
			valibotJsonSchema(v.pipe(v.string(), v.trim(), v.regex(/^a+$/), v.length(3), v.description("code"))),
			valibotJsonSchema(v.pipe(v.number(), v.maxValue(9))),
			valibotJsonSchema(v.pipe(v.string(), v.maxLength(5))),
			valibotJsonSchema(v.pipe(v.array(v.string()), v.minLength(1), v.maxLength(3))),
		]).toEqual([
			{ description: "code", maxLength: 3, minLength: 3, pattern: "^a+$", type: "string" },
			{ maximum: 9, type: "number" },
			{ maxLength: 5, type: "string" },
			{ items: STRING, maxItems: 3, minItems: 1, type: "array" },
		])
	})

	it("a tuple's rest types what follows, a loose one leaves it open, an optional tail may be left out; a value default is kept, a computed one not", () => {
		expect([
			valibotJsonSchema(v.tupleWithRest([v.string()], v.number())),
			valibotJsonSchema(v.looseTuple([v.string()])),
			valibotJsonSchema(v.tuple([v.string(), v.optional(v.number()), v.nullish(v.boolean())])),
			valibotJsonSchema(v.tuple([v.optional(v.string()), v.number()])),
			valibotJsonSchema(v.optional(v.number(), 3)),
			valibotJsonSchema(v.optional(v.number(), () => 3)),
			valibotJsonSchema(v.any()),
			valibotJsonSchema("not a schema"),
		]).toEqual([
			{ items: NUMBER, minItems: 1, prefixItems: [STRING], type: "array" },
			{ minItems: 1, prefixItems: [STRING], type: "array" },
			{
				items: false,
				maxItems: 3,
				minItems: 1,
				prefixItems: [STRING, NUMBER, { anyOf: [{ type: "boolean" }, { type: "null" }] }],
				type: "array",
			},
			{ items: false, maxItems: 2, minItems: 2, prefixItems: [STRING, NUMBER], type: "array" },
			{ default: 3, type: "number" },
			NUMBER,
			{},
			{},
		])
	})
})
