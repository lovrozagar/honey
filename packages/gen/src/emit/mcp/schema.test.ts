/**
 * An IR schema as a tool's JSON Schema (bit 18 phase b): each kind as JSON Schema writes it; every ref inlined, a ref
 * back into one being inlined `{}`, a pure cycle of refs refused, a schema past the node budget refused fast;
 * descriptions with their controls dropped; no keyword the runtime's argument check (guard.ts) does not check, but the
 * annotations it leaves alone.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { IRSchema } from "../../ir/model.ts"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import { jsonSchemaOf, NODE_BUDGET } from "./schema.ts"
import { toolsOf } from "./tools.ts"

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

/** One schema of every IR kind, each with every option it takes: a kind added to the IR fails to type-check here. */
const EVERY_KIND: { readonly [K in IRSchema["kind"]]: Extract<IRSchema, { kind: K }> } = {
	allOf: { kind: "allOf", parts: [STR] },
	array: { items: STR, kind: "array", maxItems: 2, minItems: 1 },
	binary: { kind: "binary" },
	const: { kind: "const", type: "integer", value: 1 },
	nullable: { inner: STR, kind: "nullable" },
	object: {
		additional: STR,
		fields: [{ description: "d", name: "n", required: true, schema: STR }],
		kind: "object",
	},
	ref: { kind: "ref", name: "S" },
	scalar: {
		enum: ["a"],
		exclusiveMaximum: 9,
		exclusiveMinimum: 0,
		format: "email",
		kind: "scalar",
		maxLength: 5,
		maximum: 8,
		minLength: 1,
		minimum: 1,
		pattern: "^a",
		type: "string",
	},
	tuple: { items: [STR], kind: "tuple", required: 1, rest: STR },
	union: { discriminator: { mapping: { a: "S" }, propertyName: "k" }, kind: "union", variants: [STR] },
	unknown: { kind: "unknown" },
}

/* keywords the argument check leaves alone: those that describe a value without constraining it, as JSON Schema does,
   and `pattern`, stated but never run (a spec regex on agent input is a ReDoS surface; the API validates it) */
const ANNOTATIONS = ["contentEncoding", "description", "format", "pattern"]

/** Every keyword in `schema` and the schemas nested in it. */
function keywords(schema: Record<string, unknown>): string[] {
	return Object.entries(schema).flatMap(([keyword, value]) => {
		const nested =
			keyword === "properties"
				? Object.values(value as Record<string, Record<string, unknown>>)
				: Array.isArray(value) && ["allOf", "anyOf", "prefixItems"].includes(keyword)
					? (value as Record<string, unknown>[])
					: typeof value === "object" && value !== null && ["additionalProperties", "items"].includes(keyword)
						? [value as Record<string, unknown>]
						: []
		return [keyword, ...nested.flatMap(keywords)]
	})
}

describe("the runtime's argument check (phase c)", () => {
	it("is given no keyword it does not check: every one emitted is checked or an annotation, every one checked emitted", () => {
		/* and what tools.ts writes beside schema.ts: an event stream's max_events and last_event_id */
		const stream = toIR(
			{
				info: { title: "S", version: "1" },
				openapi: "3.1.0",
				paths: {
					"/e": {
						get: {
							operationId: "e.watch",
							responses: {
								200: { content: { "text/event-stream": { schema: { type: "string" } } }, description: "e" },
							},
							"x-mcp": true,
						},
					},
				},
			} as unknown as OpenApiDocument,
			{ deriveOperationIds: true },
		)
		const emitted = [
			...Object.values(EVERY_KIND).flatMap((schema) => keywords(jsonSchemaOf(schema, { S: STR }))),
			...toolsOf(stream).flatMap((tool) => keywords(tool.inputSchema)),
		]
		const guard = readFileSync(new URL("../../runtime/mcp/guard.ts", import.meta.url), "utf8")
		const block = /\ntype Schema = \{\n([^}]*)\n\}/.exec(guard)?.[1] ?? ""
		const checked = [...block.matchAll(/^\treadonly (\w+)\?:/gm)].map((match) => match[1])
		expect([...new Set(emitted)].filter((keyword) => !ANNOTATIONS.includes(keyword)).sort()).toEqual(
			[...checked].sort(),
		)
	})
})
