import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import { schemaToIR } from "../../ir/schema.ts"
import { rustTypeContext, rustTypeOf } from "./types.ts"

type Json = Record<string, unknown>

/** A declaration's type text (comments dropped) and the header of each trait impl after it. */
type Declared = { type: string; impls: string[] }

/** A use-position row: `schema` at field `at` of a parent gives `type` and hoists `decls`. */
type UseRow = {
	title: string
	schema: Json | undefined
	type: string
	decls?: Record<string, Declared>
	at?: [parent: string, field: string]
	/** names come from a document holding these components (cyclic set, claimed names) */
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
	components ? rustTypeContext(toIR(doc(components))) : rustTypeContext()

/** A declaration's text as its type (comments dropped) and its impl headers (`impl … for <Name>`). */
const declared = (text: string): Declared => ({
	impls: [...text.matchAll(/^(impl\b.*?) \{$/gm)].map(([, head]) => head as string),
	type: (text.split("\n\nimpl")[0] as string)
		.split("\n")
		.filter((line) => !/^\s*\/\//.test(line))
		.join("\n"),
})

/** The Rust type at a use position and every declaration it hoisted. */
function use({ schema, at = ["T", "v"], components }: UseRow) {
	const ctx = { ...context(components), fieldName: at[1], parentName: at[0] }
	const type = rustTypeOf(schemaToIR(schema), ctx)
	return { decls: Object.fromEntries([...ctx.decls].map(([name, text]) => [name, declared(text)])), type }
}

/** What a use row expects: its type and exactly the declarations it hoists. */
const usedAs = (row: UseRow) => ({ decls: row.decls ?? {}, type: row.type })

const DERIVE = "#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]"
const SKIP = 'skip_serializing_if = "Option::is_none"'

/** One struct field: its `#[serde(…)]` keys when any, then `pub <decl>,`. */
const field = (decl: string, ...serde: string[]) =>
	[...(serde.length > 0 ? [`#[serde(${serde.join(", ")})]`] : []), `pub ${decl},`].join("\n")

/** A struct declaration with its derives, one 4-space-indented field per line. */
const struct = (name: string, ...fields: string[]): Declared => ({
	impls: [],
	type: [DERIVE, `pub struct ${name} {`, ...fields.flatMap((f) => f.split("\n").map((l) => `    ${l}`)), "}"].join(
		"\n",
	),
})

/** A string enum: the first variant is `#[default]`; a variant renames itself only when its value differs. */
const stringEnum = (name: string, ...variants: [variant: string, value: string][]): Declared => ({
	impls: [],
	type: [
		"#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, serde::Serialize, serde::Deserialize)]",
		`pub enum ${name} {`,
		...variants.flatMap(([variant, value], i) => [
			...(i === 0 ? ["    #[default]"] : []),
			...(variant === value ? [] : [`    #[serde(rename = "${value}")]`]),
			`    ${variant},`,
		]),
		"}",
	].join("\n"),
})

/** An integer enum: `#[repr(i64)]`, the first variant `#[default]`, with serde implemented by hand. */
const intEnum = (name: string, ...variants: [variant: string, value: number][]): Declared => ({
	impls: [`impl serde::Serialize for ${name}`, `impl<'de> serde::Deserialize<'de> for ${name}`],
	type: [
		"#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]",
		"#[repr(i64)]",
		`pub enum ${name} {`,
		...variants.flatMap(([variant, value], i) => [
			...(i === 0 ? ["    #[default]"] : []),
			`    ${variant} = ${value},`,
		]),
		"}",
	].join("\n"),
})

const STRING = { type: "string" }
const USER = { properties: { id: STRING }, required: ["id"], type: "object" }
const COMMENT = { properties: { parent: ref("Comment") }, type: "object" }
const VALUE = "serde_json::Value"

const nest = (depth: number): Json => (depth === 0 ? STRING : { items: nest(depth - 1), type: "array" })

const userStatus = { UserStatus: stringEnum("UserStatus", ["A", "a"], ["B", "b"]) }

describe("rustTypeOf: scalars", () => {
	it.each<UseRow>([
		// v0: 05ac9df6b0
		{ schema: STRING, title: "string is String", type: "String" },
		// v0: 61d252bed8
		{ schema: { type: "integer" }, title: "integer is i64", type: "i64" },
		// v0: 242814e4ff
		{ schema: { type: "number" }, title: "number is f64", type: "f64" },
		// v0: c7e5f00e19
		{ schema: { type: "boolean" }, title: "boolean is bool", type: "bool" },
		// v0: 0f9e870541
		{ schema: { type: "null" }, title: "null alone is serde_json::Value", type: VALUE },
		// v0: 65b3e5c742
		{ schema: undefined, title: "no schema is serde_json::Value", type: VALUE },
		// v0: dc5fd869ad
		{ schema: {}, title: "the empty schema is serde_json::Value", type: VALUE },
		{ schema: { format: "binary", type: "string" }, title: "a binary string is String", type: "String" },
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("rustTypeOf: consts", () => {
	it.each<UseRow>([
		// v0: 1d3cfae19a
		{ schema: { const: "admin" }, title: "an untyped string const is String", type: "String" },
		// v0: e139d16def
		{ schema: { const: 42 }, title: "an untyped integer const is i64", type: "i64" },
		// v0: 6914d29867
		{ schema: { const: true }, title: "an untyped boolean const is bool", type: "bool" },
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("rustTypeOf: arrays and tuples", () => {
	it.each<UseRow>([
		// v0: 250f5e68b7
		{ schema: { items: STRING, type: "array" }, title: "an array of string is Vec<String>", type: "Vec<String>" },
		// v0: 0b790ed994
		{
			schema: { items: { items: { type: "integer" }, type: "array" }, type: "array" },
			title: "an array of arrays nests Vec",
			type: "Vec<Vec<i64>>",
		},
		// v0: be2ccf7cf0
		{
			components: { User: USER },
			schema: { items: ref("User"), type: "array" },
			title: "an array of $ref is a Vec of the ref",
			type: "Vec<User>",
		},
		// v0: ee9566799d
		{
			schema: { items: { nullable: true, type: "string" }, type: "array" },
			title: "an array of nullable string is Vec<Option<String>>",
			type: "Vec<Option<String>>",
		},
		// v0: 6d43fc37c8
		{
			schema: { items: [STRING, { type: "number" }], type: "array" },
			title: "a draft-07 tuple is Vec<serde_json::Value>",
			type: `Vec<${VALUE}>`,
		},
		{
			components: { Comment: COMMENT },
			schema: { items: ref("Comment"), type: "array" },
			title: "a Vec of a ref on a value cycle holds it unboxed: the Vec already breaks the cycle",
			type: "Vec<Comment>",
		},
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("rustTypeOf: nullable", () => {
	it.each<UseRow>([
		// v0: 2920f309ed
		{
			schema: { nullable: true, type: "string" },
			title: "nullable: true string is Option<String>",
			type: "Option<String>",
		},
		// v0: c12a7d0d9e
		{ schema: { type: ["string", "null"] }, title: "type [string, null] is Option<String>", type: "Option<String>" },
		// v0: a00e57b6da
		{
			schema: { anyOf: [STRING, { type: "null" }] },
			title: "anyOf [string, null] is Option<String>",
			type: "Option<String>",
		},
		// v0: 8420b3033a
		{ schema: { type: ["string", "number"] }, title: "a multi-type without null is serde_json::Value", type: VALUE },
		// v0: d49424bea8
		{
			schema: { type: ["string", "number", "null"] },
			title: "a multi-type with null is serde_json::Value, never an Option",
			type: VALUE,
		},
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("rustTypeOf: unions and mixed enums", () => {
	it.each<UseRow>([
		// v0: 21dc5e92f5
		{
			schema: { oneOf: [STRING, { type: "integer" }] },
			title: "a oneOf of two types is serde_json::Value",
			type: VALUE,
		},
		// v0: c300f38b69
		{
			schema: { anyOf: [STRING, { type: "integer" }, { type: "null" }] },
			title: "anyOf of two types plus null is serde_json::Value",
			type: VALUE,
		},
		// v0: 65e3766c7a
		{
			components: { User: USER },
			schema: { oneOf: [ref("User"), { type: "null" }] },
			title: "oneOf [$ref, null] is an Option of the ref",
			type: "Option<User>",
		},
		// v0: b17b059b28
		{ schema: { enum: ["active", 1] }, title: "a mixed string and integer enum is serde_json::Value", type: VALUE },
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("rustTypeOf: refs and cycles", () => {
	it.each<UseRow>([
		// v0: 37eef5e02c
		{ schema: ref("User"), title: "a $ref is the component's Rust name", type: "User" },
		// v0: 873bbb3fd4
		{
			components: { Comment: COMMENT },
			schema: ref("Comment"),
			title: "a $ref into a value cycle is boxed",
			type: "Box<Comment>",
		},
		{
			components: { User: USER },
			schema: ref("Missing"),
			title: "a $ref to no component is its name as a Rust type",
			type: "Missing",
		},
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("rustTypeOf: allOf", () => {
	it.each<UseRow>([
		// v0: 75280b3f51
		{
			schema: { allOf: [ref("Base"), { properties: { x: STRING } }] },
			title: "an allOf holding a $ref is its first $ref, hoisting nothing",
			type: "Base",
		},
		// v0: 0bc58de819
		{
			schema: { allOf: [{ properties: { x: STRING } }, { properties: { y: STRING } }] },
			title: "an allOf of inline objects alone is serde_json::Value",
			type: VALUE,
		},
		{ schema: { allOf: [STRING] }, title: "an allOf of one part is that part", type: "String" },
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("rustTypeOf: maps and additionalProperties", () => {
	it.each<UseRow>([
		// v0: 7cd2de3189
		// v0: d1ab354443
		{
			schema: { type: "object" },
			title: "an open object without properties is a HashMap of serde_json::Value",
			type: `std::collections::HashMap<String, ${VALUE}>`,
		},
		// v0: 9205ae8617
		{
			schema: { additionalProperties: { type: "integer" }, type: "object" },
			title: "additionalProperties without properties is a fully qualified HashMap<String, T>",
			type: "std::collections::HashMap<String, i64>",
		},
		// v0: 3f37672f67
		{
			schema: { additionalProperties: false, type: "object" },
			title: "a closed object without properties is serde_json::Value",
			type: VALUE,
		},
		{
			components: { Comment: COMMENT },
			schema: { additionalProperties: ref("Comment"), type: "object" },
			title: "a map of a ref on a value cycle holds it unboxed: the map already breaks the cycle",
			type: "std::collections::HashMap<String, Comment>",
		},
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("rustTypeOf: hoisted objects and enums", () => {
	it.each<UseRow>([
		// v0: 54c34c7c40
		{
			at: ["Root", "inner"],
			decls: { RootInner: struct("RootInner", field("id: String")) },
			schema: { properties: { id: STRING }, required: ["id"] },
			title: "an inline object hoists a <Parent><Field> struct, a required field bare",
			type: "RootInner",
		},
		// v0: fc4fa66e5a
		{
			at: ["Root", "inner"],
			decls: { RootInner: struct("RootInner", field("id: Option<String>", SKIP)) },
			schema: { properties: { id: STRING } },
			title: "an optional field of a hoisted struct is Option<T>, skipped when None",
			type: "RootInner",
		},
		// v0: 322c6e8065
		{
			at: ["User", "status"],
			decls: userStatus,
			schema: { enum: ["a", "b"], type: "string" },
			title: "a string enum field hoists <Parent><Field>, one renamed variant per value, the first the default",
			type: "UserStatus",
		},
		// v0: d74f2fcbdd
		{
			at: ["User", "status"],
			decls: userStatus,
			schema: { enum: ["a", "b"] },
			title: "an untyped all-string enum hoists as a string enum",
			type: "UserStatus",
		},
		// v0: 3fdfd6a239
		{
			at: ["User", "status"],
			decls: userStatus,
			schema: { enum: ["a", "b"], nullable: true, type: "string" },
			title: "a nullable string enum is an Option of the hoisted enum",
			type: "Option<UserStatus>",
		},
		// v0: 8dee61497a
		{
			at: ["Post", "score"],
			decls: { PostScore: intEnum("PostScore", ["L1", 1], ["L2", 2]) },
			schema: { enum: [1, 2], type: "integer" },
			title: "an integer enum field hoists a repr(i64) enum with hand-written serde impls",
			type: "PostScore",
		},
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("rustTypeOf: one declaration per hoist", () => {
	it("declares a hoist reached twice under one key once, under the name it got first", () => {
		const ctx = { ...context({ User: USER }), fieldName: "inner", parentName: "Root" }
		const inner = schemaToIR({ properties: { id: STRING }, required: ["id"] })
		expect([rustTypeOf(inner, ctx), rustTypeOf(inner, ctx), [...ctx.decls.keys()]]).toEqual([
			"RootInner",
			"RootInner",
			["RootInner"],
		])
	})
})

describe("rustTypeOf: depth", () => {
	// v0: be85ba4d40
	it("renders a schema nested past depth 12 as serde_json::Value", () => {
		expect([
			use({ schema: nest(12), title: "", type: "" }).type,
			use({ schema: nest(13), title: "", type: "" }).type,
		]).toEqual([`${"Vec<".repeat(12)}String${">".repeat(12)}`, `${"Vec<".repeat(13)}${VALUE}${">".repeat(13)}`])
	})
})
