import { describe, expect, it } from "vitest"
import { type IRSchema, irResolver, schemaToIR } from "./model.ts"

type Json = Record<string, unknown>

const STRING: IRSchema = { kind: "scalar", type: "string" }
const NUMBER: IRSchema = { kind: "scalar", type: "number" }
const ref = (name: string): IRSchema => ({ kind: "ref", name })
const nullable = (inner: IRSchema): IRSchema => ({ inner, kind: "nullable" })
const field = (name: string, required: boolean, schema: IRSchema = STRING) => ({ name, required, schema })

describe("schemaToIR: the plain scalars", () => {
	// v0: 404db74b24
	// v0: 47a34c2e35
	// v0: a30de0935b
	// v0: d62a9014f7
	// v0: ec577ff078
	it.each<[string, Json, IRSchema]>([
		["a plain string", { type: "string" }, { kind: "scalar", type: "string" }],
		["an integer", { type: "integer" }, { kind: "scalar", type: "integer" }],
		["a number", { type: "number" }, { kind: "scalar", type: "number" }],
		["a boolean", { type: "boolean" }, { kind: "scalar", type: "boolean" }],
		[
			"a date-time string",
			{ format: "date-time", type: "string" },
			{ format: "date-time", kind: "scalar", type: "string" },
		],
	])("%s", (_name, schema, expected) => {
		expect(schemaToIR(schema)).toEqual(expected)
	})
})

describe("schemaToIR: scalars, enums and consts", () => {
	// v0: bc49f24dc7
	// v0: 6ed77decf1
	// v0: e9b04c8709
	// v0: bc5cfad9b1
	// v0: b7cb3786b8
	// v0: 0765717f16
	// v0: 06e2a73170
	// v0: 4651d8fadd
	// v0: ed39443a1b
	// v0: c9e7cae18b
	// v0: 7335521b17
	// v0: cd32fad787
	// v0: 915dfcc252
	// v0: bec25dd0a0
	// v0: f6d1b98f82
	// v0: ca8844bc17
	// v0: 7b143a9a12
	// v0: 0954a0a070
	// v0: 5f78355c1a
	// v0: aa459aee5a
	// v0: 92693a402e
	// v0: 5378faff01
	it.each<[string, Json | undefined, IRSchema]>([
		["an explicit null", { type: "null" }, { kind: "scalar", type: "null" }],
		[
			"a string with its format",
			{ format: "uuid", type: "string" },
			{ format: "uuid", kind: "scalar", type: "string" },
		],
		["a string enum", { enum: ["a", "b"], type: "string" }, { enum: ["a", "b"], kind: "scalar", type: "string" }],
		["a one-value string enum", { enum: ["only"], type: "string" }, { enum: ["only"], kind: "scalar", type: "string" }],
		["an integer enum", { enum: [-2, 0, 3], type: "integer" }, { enum: [-2, 0, 3], kind: "scalar", type: "integer" }],
		["an untyped string enum", { enum: ["a"] }, { enum: ["a"], kind: "scalar", type: "string" }],
		["an untyped integer enum", { enum: [1, 2] }, { enum: [1, 2], kind: "scalar", type: "integer" }],
		[
			"a mixed enum, as a union of consts",
			{ enum: ["a", 1, true] },
			{
				kind: "union",
				variants: [
					{ kind: "const", value: "a" },
					{ kind: "const", value: 1 },
					{ kind: "const", value: true },
				],
			},
		],
	])("%s", (_name, schema, expected) => {
		expect(schemaToIR(schema)).toEqual(expected)
	})
})

describe("schemaToIR: consts and what has no shape", () => {
	it.each<[string, Json | undefined, IRSchema]>([
		["a string const", { const: "x" }, { kind: "const", value: "x" }],
		["a false const", { const: false }, { kind: "const", value: false }],
		["an integer const", { const: 7 }, { kind: "const", value: 7 }],
		["a float const", { const: 1.5 }, { kind: "const", value: 1.5 }],
		[
			"a const keeping its declared type",
			{ const: "x", type: "string" },
			{ kind: "const", type: "string", value: "x" },
		],
		["a null const, which no SDK types", { const: null }, { kind: "unknown" }],
		["an unknown type", { type: "date" }, { kind: "unknown" }],
		["an enum holding a null, unreadable", { enum: ["a", null] }, { kind: "unknown" }],
		["an empty schema", {}, { kind: "unknown" }],
		["no schema at all", undefined, { kind: "unknown" }],
	])("%s", (_name, schema, expected) => {
		expect(schemaToIR(schema)).toEqual(expected)
	})
})

describe("schemaToIR: objects, arrays and tuples", () => {
	// v0: 5cba182db6
	// v0: d307937cc6
	// v0: fb1a62af78
	// v0: d3ed9bc378
	// v0: ecd3814d6a
	// v0: c6da02e194
	// v0: 0feea0b716
	// v0: 7a9ed9bc38
	// v0: a7a9849d9a
	// v0: 12a9aeac48
	// v0: fedd1e4419
	// v0: 252cec6da6
	// v0: 4e12325bf6
	// v0: 37e13d0981
	// v0: 33d4154750
	it("keeps each key raw, in the spec's order, with its required flag, description and extra keys", () => {
		expect([
			schemaToIR({ type: "object" }),
			schemaToIR({ properties: { b: { description: "B", type: "string" }, a: { type: "number" } }, required: ["a"] }),
			schemaToIR({ additionalProperties: true, type: "object" }),
			schemaToIR({ additionalProperties: false, properties: { id: { type: "string" } }, type: "object" }),
			schemaToIR({ additionalProperties: { type: "string" } }),
			schemaToIR({ properties: { "x-y": { type: "string" }, class: { type: "string" }, "2d": { type: "string" } } }),
			schemaToIR({
				properties: { a: { properties: { b: { properties: { c: { properties: { d: { type: "string" } } } } } } } },
			}),
		]).toEqual([
			{ fields: [], kind: "object" },
			{ fields: [{ ...field("b", false), description: "B" }, field("a", true, NUMBER)], kind: "object" },
			{ additional: { kind: "unknown" }, fields: [], kind: "object" },
			{ additional: false, fields: [field("id", false)], kind: "object" },
			{ additional: STRING, fields: [], kind: "object" },
			{ fields: [field("x-y", false), field("class", false), field("2d", false)], kind: "object" },
			{
				fields: [
					field("a", false, {
						fields: [
							field("b", false, {
								fields: [field("c", false, { fields: [field("d", false)], kind: "object" })],
								kind: "object",
							}),
						],
						kind: "object",
					}),
				],
				kind: "object",
			},
		])
	})
})

describe("schemaToIR: arrays, tuples and binary", () => {
	// v0: f071f546c5
	// v0: b4d5c83704
	// v0: 91aa2147a0
	// v0: ab283f829d
	// v0: c10caea95e
	// v0: 9f36dce437
	// v0: 164bdc1242
	// v0: c0211067ce
	it("reads arrays, nested arrays, tuples and binary strings", () => {
		expect([
			schemaToIR({ items: { $ref: "#/components/schemas/User" }, type: "array" }),
			schemaToIR({ items: { items: { items: { type: "number" }, type: "array" }, type: "array" }, type: "array" }),
			schemaToIR({ type: "array" }),
			schemaToIR({ items: [{ type: "string" }, { type: "number" }] }),
			schemaToIR({ format: "binary", type: "string" }),
			schemaToIR({ format: "binary" }),
		]).toEqual([
			{ items: ref("User"), kind: "array" },
			{ items: { items: { items: NUMBER, kind: "array" }, kind: "array" }, kind: "array" },
			{ items: { kind: "unknown" }, kind: "array" },
			{ items: [STRING, NUMBER], kind: "tuple" },
			{ kind: "binary" },
			{ kind: "binary" },
		])
	})
})

describe("schemaToIR: nullability, unions and references", () => {
	// v0: 786941d5b1
	// v0: 330f7c49dd
	// v0: 849ee0b091
	// v0: 33b97341a0
	// v0: 39e4836be6
	// v0: c70b34b204
	// v0: 7b1a44c5dc
	// v0: 0ea5ec85e5
	// v0: 427954c9e3
	// v0: 97b332bfdd
	it("wraps a nullable schema once, its null variant or type stripped", () => {
		expect([
			schemaToIR({ nullable: true, type: "string" }),
			schemaToIR({ type: ["string", "null"] }),
			schemaToIR({ anyOf: [{ type: "string" }, { type: "null" }] }),
			schemaToIR({ anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] }),
			schemaToIR({ anyOf: [{ type: "null" }] }),
			schemaToIR({ anyOf: [{ nullable: true, type: "string" }, { type: "null" }] }),
			schemaToIR({ nullable: true, oneOf: [{ type: "string" }, { type: "number" }] }),
			schemaToIR({ type: ["string", "number", "null"] }),
			schemaToIR({ type: ["string", "number"] }),
			schemaToIR({ nullable: true, type: ["string", "number"] }),
			schemaToIR({ nullable: true, type: ["string", "number", "null"] }),
		]).toEqual([
			nullable(STRING),
			nullable(STRING),
			nullable(STRING),
			nullable({ kind: "union", variants: [STRING, NUMBER] }),
			nullable({ kind: "unknown" }),
			nullable(STRING),
			nullable({ kind: "union", variants: [STRING, NUMBER] }),
			nullable({ kind: "union", variants: [STRING, NUMBER] }),
			{ kind: "union", variants: [STRING, NUMBER] },
			nullable({ kind: "union", variants: [STRING, NUMBER] }),
			nullable({ kind: "union", variants: [STRING, NUMBER] }),
		])
	})
})

describe("schemaToIR: unions and references", () => {
	// v0: 790fc96762
	// v0: d1ba9e8492
	// v0: a7f9306b7f
	// v0: 0fa87970ab
	// v0: 194bda03a9
	// v0: 7df40db217
	// v0: 143b5871bb
	// v0: b6dec3ef43
	// v0: e1e2603284
	// v0: fa2618ca68
	// v0: 4edc5ccd0c
	// v0: aaa6fc8799
	// v0: fa17dfc468
	// v0: d994c7a586
	it("keeps unions with their discriminator, allOf parts in order, and a ref by its last segment", () => {
		const cat = { $ref: "#/components/schemas/Cat" }
		const dog = { $ref: "#/components/schemas/Dog" }
		const mapping = { cat: "#/components/schemas/Cat", dog: "#/components/schemas/Dog" }
		const inline = { properties: { a: { type: "string" } }, type: "object" }
		expect([
			schemaToIR({ oneOf: [cat, dog] }),
			schemaToIR({ discriminator: { mapping, propertyName: "kind" }, oneOf: [cat, dog] }),
			schemaToIR({ discriminator: { propertyName: "kind" }, oneOf: [cat] }),
			schemaToIR({ anyOf: [cat, dog] }),
			schemaToIR({ allOf: [dog, inline, cat] }),
			schemaToIR({ $ref: "#/components/schemas/Pet/properties/name" }),
			schemaToIR({ $ref: "https://x.test/spec.json#/components/schemas/User" }),
			schemaToIR({ properties: { self: { $ref: "#/components/schemas/Tree" } }, type: "object" }),
		]).toEqual([
			{ kind: "union", variants: [ref("Cat"), ref("Dog")] },
			{
				discriminator: { mapping: { cat: "Cat", dog: "Dog" }, propertyName: "kind" },
				kind: "union",
				variants: [ref("Cat"), ref("Dog")],
			},
			{ discriminator: { propertyName: "kind" }, kind: "union", variants: [ref("Cat")] },
			{ kind: "union", variants: [ref("Cat"), ref("Dog")] },
			{
				kind: "allOf",
				parts: [ref("Dog"), { fields: [{ name: "a", required: false, schema: STRING }], kind: "object" }, ref("Cat")],
			},
			ref("name"),
			ref("User"),
			{ fields: [{ name: "self", required: false, schema: ref("Tree") }], kind: "object" },
		])
	})
})

describe("reading the IR back", () => {
	it("follows refs to their schema, an unknown or endless one to unknown", () => {
		const resolve = irResolver({ A: ref("B"), B: STRING, Loop: ref("Loop") })
		expect([resolve(ref("A")), resolve(ref("Missing")), resolve(ref("Loop")), resolve(NUMBER)]).toEqual([
			STRING,
			{ kind: "unknown" },
			{ kind: "unknown" },
			NUMBER,
		])
	})
})

describe("schemaToIR: tuples, as 2020-12 and draft-07 write them", () => {
	it("reads prefixItems closed unless items types a rest, and an optional tail from minItems", () => {
		expect([
			schemaToIR({ items: false, prefixItems: [{ type: "string" }, { type: "number" }], type: "array" }),
			schemaToIR({ items: { type: "number" }, prefixItems: [{ type: "string" }] }),
			schemaToIR({ maxItems: 2, minItems: 1, prefixItems: [{ type: "string" }, { type: "number" }] }),
			schemaToIR({ additionalItems: { type: "number" }, items: [{ type: "string" }] }),
			schemaToIR({ items: [{ type: "string" }], minItems: 1 }),
			schemaToIR({ prefixItems: [{ type: "string" }, { type: "number" }], type: "array" }),
		]).toEqual([
			{ items: [STRING, NUMBER], kind: "tuple" },
			{ items: [STRING], kind: "tuple", rest: NUMBER },
			{ items: [STRING, NUMBER], kind: "tuple", required: 1 },
			{ items: [STRING], kind: "tuple", rest: NUMBER },
			{ items: [STRING], kind: "tuple" },
			{ items: [STRING, NUMBER], kind: "tuple" },
		])
	})
})
