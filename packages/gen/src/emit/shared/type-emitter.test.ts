import { describe, expect, it } from "vitest"
import type { IRSchema } from "../../ir/model.ts"
import { schemaToIR } from "../../ir/model.ts"
import { arrayOf, intersectionOf, irToTs, unionOf } from "./type-emitter.ts"

type Json = Record<string, unknown>

const STRING: IRSchema = { kind: "scalar", type: "string" }
const NUMBER: IRSchema = { kind: "scalar", type: "number" }
const ts = (schema: Json) => irToTs(schemaToIR(schema))

describe("irToTs: precedence", () => {
	// v0: d18d5aa3d4
	it("parenthesises a union or intersection inside an array, and a union inside an intersection", () => {
		const union: IRSchema = { kind: "union", variants: [STRING, NUMBER] }
		expect([
			irToTs({ items: union, kind: "array" }),
			irToTs({ items: { kind: "allOf", parts: [STRING, NUMBER] }, kind: "array" }),
			irToTs({ kind: "allOf", parts: [union, { kind: "scalar", type: "boolean" }] }),
			irToTs({ kind: "union", variants: [{ kind: "allOf", parts: [STRING, NUMBER] }, NUMBER] }),
			irToTs({ kind: "union", variants: [STRING, STRING] }),
			irToTs({ kind: "union", variants: [] }),
			irToTs({ inner: union, kind: "nullable" }),
		]).toEqual([
			"(string | number)[]",
			"(string & number)[]",
			"(string | number) & boolean",
			"string & number | number",
			"string",
			"never",
			"string | number | null",
		])
	})
})

describe("the precedence helpers callers share", () => {
	it("bracket a function type wherever it would bind looser, and see past quoted operators", () => {
		expect([
			unionOf(["() => void", "string"]),
			arrayOf("() => void"),
			intersectionOf(["() => void", "A"]),
			arrayOf('"a | b"'),
			arrayOf('"a\\"|b"'),
			arrayOf("Array<A | B>"),
		]).toEqual([
			"(() => void) | string",
			"(() => void)[]",
			"(() => void) & A",
			'"a | b"[]',
			'"a\\"|b"[]',
			"Array<A | B>[]",
		])
	})

	it("bracket a union in an intersection, and any array element looser than []: an intersection or a readonly array", () => {
		expect([
			intersectionOf(["A | B", "C"]),
			unionOf(["A", "A", "B"]),
			arrayOf("A & B"),
			arrayOf("readonly string[]"),
		]).toEqual(["(A | B) & C", "A | B", "(A & B)[]", "(readonly string[])[]"])
	})
})

describe("irToTs: objects", () => {
	it("sorts fields by code unit, quotes a key only when it is no identifier, and types extra keys apart", () => {
		expect([
			ts({
				properties: { b: { type: "string" }, B: { type: "number" }, class: { type: "string" }, "x-y": {}, "2d": {} },
				required: ["b"],
			}),
			ts({ additionalProperties: { type: "number" }, properties: { id: { type: "string" } }, required: ["id"] }),
			ts({ additionalProperties: false, properties: { id: { type: "string" } }, required: ["id"] }),
			ts({ additionalProperties: true, type: "object" }),
		]).toEqual([
			'{ "2d"?: unknown; B?: number; b: string; class?: string; "x-y"?: unknown }',
			"{ id: string } & { [k: string]: number }",
			"{ id: string }",
			"Record<string, unknown>",
		])
	})
})

describe("irToTs: what the caller decides", () => {
	// v0: b57532d79b
	// v0: 50ef1750af
	it("names a ref by the caller's lookup, so a recursive schema is its own alias; without one it is unknown", () => {
		const node = schemaToIR({
			properties: { children: { items: { $ref: "#/components/schemas/Node" }, type: "array" } },
			required: ["children"],
		})
		expect([irToTs(node, { refName: (name) => name }), irToTs(node)]).toEqual([
			"{ children: Node[] }",
			"{ children: unknown[] }",
		])
	})

	it("types a binary string as the caller says, a string by default, and stops at a depth bound", () => {
		let deep: IRSchema = STRING
		for (let n = 0; n < 70; n++) deep = { items: deep, kind: "array" }
		expect([
			irToTs({ kind: "binary" }),
			irToTs({ kind: "binary" }, { binary: "Blob" }),
			irToTs(deep).startsWith("unknown[][]"),
		]).toEqual(["string", "Blob", true])
	})
})

describe("irToTs: literals are written through the escape layer", () => {
	// v0: 84790b70a7
	// v0: b300f52147
	// v0: 0d961a0c2f
	it("escapes quotes, backslashes, newlines and line separators, writes numeric enums by value, and a bigint literal as its number", () => {
		expect([
			ts({ enum: ['say "hi"', "back\\slash", "line\nbreak", "a b"] }),
			ts({ properties: { 'k"\n': { const: "v" } }, required: ['k"\n'] }),
			ts({ enum: [0, 1, 2] }),
			ts({ const: 1 }),
			ts({ enum: [1.5, "a", true] }),
		]).toEqual([
			'"say \\"hi\\"" | "back\\\\slash" | "line\\nbreak" | "a\\u2028b"',
			'{ "k\\"\\n": "v" }',
			"0 | 1 | 2",
			"1",
			'1.5 | "a" | true',
		])
	})
})

describe("irToTs: shapes JSON keeps, and what it cannot", () => {
	// v0: 76b62e1210
	it("types a tuple's rest and optional tail, a non-optional field plainly, and a map, set or function as unknown", () => {
		expect([
			ts({ items: { type: "number" }, prefixItems: [{ type: "string" }], type: "array" }),
			ts({ items: false, minItems: 1, prefixItems: [{ type: "string" }, { type: "number" }], type: "array" }),
			ts({ properties: { must: { type: "string" } }, required: ["must"] }),
			ts({}),
			ts({ type: "integer" }),
			ts({ type: "null" }),
		]).toEqual(["[string, ...number[]]", "[string, number?]", "{ must: string }", "unknown", "number", "null"])
	})
})
