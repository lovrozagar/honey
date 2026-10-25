/**
 * An IR schema as a tool's JSON Schema (bit 18 phase b): each kind as JSON Schema writes it; every ref inlined, a ref
 * back into one being inlined `{}`, a pure cycle of refs refused, a schema past the node budget refused fast;
 * descriptions with their controls dropped.
 */
import { describe, expect, it } from "vitest"
import type { IRSchema } from "../../ir/model.ts"
import { jsonSchemaOf, NODE_BUDGET } from "./schema.ts"

const STR: IRSchema = { kind: "scalar", type: "string" }

describe("each kind (phase b)", () => {
	it.each<[string, IRSchema, unknown]>([
		[
			"a scalar with its format and enum",
			{ enum: ["a", "b"], format: "email", kind: "scalar", type: "string" },
			{ enum: ["a", "b"], format: "email", type: "string" },
		],
		["a scalar with an empty enum", { enum: [], kind: "scalar", type: "integer" }, { type: "integer" }],
		["a const", { kind: "const", value: 3 }, { const: 3 }],
		["an array", { items: STR, kind: "array" }, { items: { type: "string" }, type: "array" }],
		[
			"a tuple with a rest, two required",
			{ items: [STR, STR, STR], kind: "tuple", required: 2, rest: STR },
			{
				items: { type: "string" },
				minItems: 2,
				prefixItems: [{ type: "string" }, { type: "string" }, { type: "string" }],
				type: "array",
			},
		],
		[
			"a closed tuple",
			{ items: [STR], kind: "tuple" },
			{ items: false, minItems: 1, prefixItems: [{ type: "string" }], type: "array" },
		],
		[
			"a union",
			{ kind: "union", variants: [STR, { kind: "scalar", type: "number" }] },
			{ anyOf: [{ type: "string" }, { type: "number" }] },
		],
		["an allOf", { kind: "allOf", parts: [STR] }, { allOf: [{ type: "string" }] }],
		["a nullable", { inner: STR, kind: "nullable" }, { anyOf: [{ type: "string" }, { type: "null" }] }],
		["bytes", { kind: "binary" }, { contentEncoding: "base64", type: "string" }],
		["anything", { kind: "unknown" }, {}],
		[
			"an object, its required fields, a field's description, closed",
			{
				additional: false,
				fields: [
					{ description: "the\u0007 name", name: "n", required: true, schema: STR },
					{ name: "o", required: false, schema: STR },
				],
				kind: "object",
			},
			{
				additionalProperties: false,
				properties: { n: { description: "the name", type: "string" }, o: { type: "string" } },
				required: ["n"],
				type: "object",
			},
		],
		[
			"a map",
			{ additional: STR, fields: [], kind: "object" },
			{ additionalProperties: { type: "string" }, properties: {}, type: "object" },
		],
	])("writes %s", (_, schema, expected) => {
		expect(jsonSchemaOf(schema, {})).toEqual(expected)
	})
})

describe("refs (phase b)", () => {
	// v0: aff10fde13
	// v0: 32fcd8c065
	it("inlines every ref, a ref back into one being inlined as {}, a ref to nothing as {}", () => {
		const schemas: Record<string, IRSchema> = {
			Node: { fields: [{ name: "next", required: false, schema: { kind: "ref", name: "Node" } }], kind: "object" },
			Pet: { fields: [{ name: "name", required: true, schema: STR }], kind: "object" },
		}
		expect([
			jsonSchemaOf({ items: { kind: "ref", name: "Pet" }, kind: "array" }, schemas),
			jsonSchemaOf({ kind: "ref", name: "Node" }, schemas),
			jsonSchemaOf({ kind: "ref", name: "Gone" }, schemas),
		]).toEqual([
			{ items: { properties: { name: { type: "string" } }, required: ["name"], type: "object" }, type: "array" },
			{ properties: { next: {} }, type: "object" },
			{},
		])
	})

	// v0: 5cc55ddfc1
	it("refuses a pure cycle of refs with no schema between", () => {
		const schemas: Record<string, IRSchema> = { A: { kind: "ref", name: "B" }, B: { kind: "ref", name: "A" } }
		expect(() => jsonSchemaOf({ kind: "ref", name: "A" }, schemas)).toThrow(
			"a $ref cycle with no schema between: A → B → A",
		)
	})
})

describe("the node budget (phase b)", () => {
	it("refuses a schema past the budget it is given, a small one on a small fixture", () => {
		const fields = Array.from({ length: 20 }, (_, i) => ({ name: `f${i}`, required: false, schema: STR }))
		const wide: IRSchema = { fields, kind: "object" }
		expect(
			[() => jsonSchemaOf(wide, {}, 10), () => jsonSchemaOf(wide, {}, 21)].map((convert) =>
				(() => {
					try {
						convert()
						return "converted"
					} catch (error) {
						return (error as Error).message
					}
				})(),
			),
		).toEqual(["a schema inlines past 10 nodes", "converted"])
	})

	it("holds the default budget at 50,000 nodes", () => {
		expect(NODE_BUDGET).toBe(50_000)
	})

	// v0: 0a32000a71
	it("refuses, at the default budget, shared refs inlined over and over past it, timed by the clock around the call", () => {
		const schemas: Record<string, IRSchema> = { L0: STR }
		for (let i = 1; i <= 17; i++) {
			const ref: IRSchema = { kind: "ref", name: `L${i - 1}` }
			schemas[`L${i}`] = {
				fields: [
					{ name: "a", required: true, schema: ref },
					{ name: "b", required: true, schema: ref },
				],
				kind: "object",
			}
		}
		const started = performance.now()
		expect(() => jsonSchemaOf({ kind: "ref", name: "L17" }, schemas)).toThrow(
			`a schema inlines past ${NODE_BUDGET} nodes`,
		)
		expect(performance.now() - started).toBeLessThan(2000)
	})
})
