/**
 * Python types at a use position (contract 28 §4.5, §7.3): each JSON Schema maps to one annotation, and an inline
 * object or a variant hoists one declaration under its `<Parent><Field>` name; the `typing` names a module must
 * import are exactly the ones the annotation spells. Past depth 12 every schema is `Any` (Fb6 h).
 */
import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import { schemaToIR } from "../../ir/schema.ts"
import { pyTypeContext, pyTypeOf } from "./types.ts"

type Json = Record<string, unknown>

/** A use-position row: `schema` at field `at` of a parent gives `type` and hoists `decls` (name to text). */
type UseRow = {
	title: string
	schema: Json | undefined
	type: string
	decls?: Record<string, string>
	at?: [parent: string, field: string]
	/** names come from a document holding these components */
	components?: Record<string, Json>
}

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` })

/** A minimal OpenAPI 3.1 document holding these components. */
const doc = (schemas: Record<string, Json>): OpenApiDocument => ({
	components: { schemas },
	info: { title: "Types", version: "1" },
	openapi: "3.1.0",
	paths: {},
})

/** A fresh context; with components, one built from their IR. */
const context = (components?: Record<string, Json>) =>
	components ? pyTypeContext(toIR(doc(components))) : pyTypeContext()

/** The Python type at a use position, every declaration it hoisted, and the `typing` names it needs, sorted. */
function use({ schema, at = ["T", "v"], components }: Pick<UseRow, "at" | "components" | "schema">) {
	const ctx = { ...context(components), fieldName: at[1], parentName: at[0] }
	const type = pyTypeOf(schemaToIR(schema), ctx)
	return { decls: Object.fromEntries(ctx.decls), type, typing: [...ctx.typing].sort() }
}

/** What a use row is: its type and exactly the declarations it hoists. */
const used = (row: UseRow) => {
	const { decls, type } = use(row)
	return { decls, type }
}

/** What a use row expects. */
const usedAs = (row: UseRow) => ({ decls: row.decls ?? {}, type: row.type })

const STRING = { type: "string" }
const INTEGER = { type: "integer" }
const USER = { properties: { id: STRING }, required: ["id"], type: "object" }

/** `depth` arrays around a string, Go's and Rust's depth helper. */
const nest = (depth: number): Json => (depth === 0 ? STRING : { items: nest(depth - 1), type: "array" })

describe("pyTypeOf: scalars and the empty schema", () => {
	it.each<UseRow>([
		// v0: 07c8786b8d
		{ schema: undefined, title: "no schema is Any", type: "Any" },
		// v0: 4573bb27ab
		{ schema: {}, title: "the empty schema is Any", type: "Any" },
		// v0: ff313812af
		{ schema: STRING, title: "string is str", type: "str" },
		// v0: c429069570
		{ schema: INTEGER, title: "integer is int", type: "int" },
		// v0: 54d2186f7d
		{ schema: { type: "number" }, title: "number is float", type: "float" },
		// v0: a7211a50fe
		{ schema: { type: "boolean" }, title: "boolean is bool", type: "bool" },
		// v0: 2a08b063c1
		{ schema: { type: "null" }, title: "null is None", type: "None" },
		// v0: dd2f5372eb
		{ schema: { format: "binary", type: "string" }, title: "a binary string inside JSON is str", type: "str" },
		// v0: 9358150ac5
		{ schema: { format: "binary" }, title: "a bare binary format is str", type: "str" },
	])("$title", (row) => {
		expect(used(row)).toEqual(usedAs(row))
	})
})

describe("pyTypeOf: consts and enums are Literal, inline", () => {
	it.each<UseRow>([
		// v0: 5dae46149c
		{ schema: { const: "admin" }, title: "a string const is its Literal", type: 'Literal["admin"]' },
		// v0: 71ca02e2c5
		{ schema: { const: 42 }, title: "an integer const is its Literal", type: "Literal[42]" },
		// v0: b0886c31de
		{ schema: { const: true }, title: "a true const is Literal[True]", type: "Literal[True]" },
		// v0: 27f38d7250
		{ schema: { const: false }, title: "a false const is Literal[False]", type: "Literal[False]" },
		{ schema: { const: 1.5 }, title: "a non-integral const is float: PEP 586 has no float literals", type: "float" },
		// v0: 161af75faf
		{
			schema: { enum: ["a", "b"], type: "string" },
			title: "a string enum is one Literal in declared order, never hoisted",
			type: 'Literal["a", "b"]',
		},
		// v0: 8f21023255
		{ schema: { enum: [1, 2], type: "integer" }, title: "an integer enum is one Literal", type: "Literal[1, 2]" },
		// v0: 492bc43e08
		{ schema: { enum: [true, false] }, title: "a boolean enum is one Literal", type: "Literal[True, False]" },
		// v0: ad77a3373e
		{
			schema: { enum: ["active", 1] },
			title: "a mixed string and integer enum collapses into one Literal",
			type: 'Literal["active", 1]',
		},
		{
			schema: { enum: ["a", null], type: ["string", "null"] },
			title: "a null member of a typed enum is a None after the Literal",
			type: 'Literal["a"] | None',
		},
		/* bit 19 c: the IR reads an untyped enum holding a null as the typed form does (ir/schema.test.ts) */
		{
			schema: { enum: ["a", null] },
			title: "an untyped enum holding a null is the Literal then None, as a typed one",
			type: 'Literal["a"] | None',
		},
	])("$title", (row) => {
		expect(used(row)).toEqual(usedAs(row))
	})
})

describe("pyTypeOf: arrays and tuples", () => {
	it.each<UseRow>([
		// v0: c439678c80
		{ schema: { items: STRING, type: "array" }, title: "an array of string is list[str]", type: "list[str]" },
		// v0: c4b900a91c
		{
			schema: { items: { oneOf: [STRING, INTEGER] }, type: "array" },
			title: "an array of a oneOf is a list of the union",
			type: "list[str | int]",
		},
		// v0: 71c0c63222
		{
			schema: { items: [STRING, { type: "number" }], type: "array" },
			title: "a tuple is tuple[A, B]",
			type: "tuple[str, float]",
		},
		{ schema: { items: [], type: "array" }, title: "an empty closed tuple is tuple[()]", type: "tuple[()]" },
		{
			schema: { items: { type: "number" }, prefixItems: [STRING], type: "array" },
			title: "a tuple with a rest unpacks a variadic tuple (PEP 646, 3.11)",
			type: "tuple[str, *tuple[float, ...]]",
		},
		{
			schema: { minItems: 1, prefixItems: [STRING, { type: "number" }], type: "array" },
			title: "a tuple with an optional tail is list[Any]",
			type: "list[Any]",
		},
		{
			decls: { TVItem: "class TVItem(TypedDict):\n    a: NotRequired[str]" },
			schema: { items: { properties: { a: STRING }, type: "object" }, type: "array" },
			title: "an array of inline objects hoists its item as <Parent><Field>Item",
			type: "list[TVItem]",
		},
	])("$title", (row) => {
		expect(used(row)).toEqual(usedAs(row))
	})
})

describe("pyTypeOf: nullable and multi-type", () => {
	it.each<UseRow>([
		// v0: 14dd8f60d4
		{ schema: { nullable: true, type: "string" }, title: "nullable: true is the type | None", type: "str | None" },
		// v0: 5d90bae339
		{ schema: { type: ["string", "null"] }, title: "type [string, null] is str | None", type: "str | None" },
		// v0: 95aae2bbf9
		{ schema: { anyOf: [STRING, { type: "null" }] }, title: "anyOf [string, null] is str | None", type: "str | None" },
		// v0: 20fa7aa27f
		{ schema: { type: ["string", "number"] }, title: "a multi-type is the union of its types", type: "str | float" },
		// v0: c9251de014
		{
			schema: { type: ["string", "number", "null"] },
			title: "a multi-type with null puts None last",
			type: "str | float | None",
		},
	])("$title", (row) => {
		expect(used(row)).toEqual(usedAs(row))
	})
})

describe("pyTypeOf: unions, refs and allOf", () => {
	it.each<UseRow>([
		// v0: 0d9cde86f1
		{ schema: { oneOf: [STRING, INTEGER] }, title: "a oneOf is A | B", type: "str | int" },
		{ schema: { oneOf: [{}, STRING] }, title: "a union with an Any member is Any", type: "Any" },
		// v0: dcc88ad92f
		{ components: { User: USER }, schema: ref("User"), title: "a $ref is the component's name", type: "User" },
		// v0: 6e28e8915d
		{ schema: { allOf: [STRING, INTEGER] }, title: "an allOf of non-objects is Any", type: "Any" },
	])("$title", (row) => {
		expect(used(row)).toEqual(usedAs(row))
	})
})

describe("pyTypeOf: objects without properties are dicts", () => {
	it.each<UseRow>([
		// v0: f732435945
		{ schema: { type: "object" }, title: "an object without properties is dict[str, Any]", type: "dict[str, Any]" },
		// v0: cb011a01c0
		{
			schema: { additionalProperties: true, type: "object" },
			title: "additionalProperties: true is dict[str, Any]",
			type: "dict[str, Any]",
		},
		// v0: a0122664f4
		{
			schema: { additionalProperties: INTEGER, type: "object" },
			title: "a typed additionalProperties alone is dict[str, T]",
			type: "dict[str, int]",
		},
	])("$title", (row) => {
		expect(used(row)).toEqual(usedAs(row))
	})
})

describe("pyTypeOf: the typing names a module imports", () => {
	it("records exactly the typing names the annotation spells, and none for a builtin", () => {
		expect([
			use({ schema: { anyOf: [{ items: {}, type: "array" }, { const: "x" }] } }),
			use({ schema: { items: STRING, type: "array" } }),
		]).toEqual([
			{ decls: {}, type: 'list[Any] | Literal["x"]', typing: ["Any", "Literal"] },
			{ decls: {}, type: "list[str]", typing: [] },
		])
	})
})

describe("pyTypeOf: depth", () => {
	// v0: e0dadc9764
	it("renders a schema nested past depth 12 as Any, not past v0's 8", () => {
		expect([use({ schema: nest(12) }).type, use({ schema: nest(13) }).type]).toEqual([
			`${"list[".repeat(12)}str${"]".repeat(12)}`,
			`${"list[".repeat(13)}Any${"]".repeat(13)}`,
		])
	})
})
