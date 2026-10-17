/**
 * C# use positions (contract 45 §4.5, §7.2): Rust's table in C#. `csTypeOf` gives the type of a schema at a field of
 * a parent and hoists a string or integer enum, or an inline object, as `<Parent><Field>` into the context.
 */
import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import { schemaToIR } from "../../ir/schema.ts"
import { csTypeContext, csTypeOf } from "./types.ts"

type Json = Record<string, unknown>

/** A declaration's type text (doc comments dropped) and the header of each converter class after it. */
type Declared = { type: string; converters: string[] }

/** A use-position row: `schema` at field `at` of a parent gives `type` and hoists `decls`. */
type UseRow = {
	title: string
	schema: Json | undefined
	type: string
	decls?: Record<string, Declared>
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
	components ? csTypeContext(toIR(doc(components))) : csTypeContext()

/** A declaration's text as its type (doc comments dropped) and its converter headers (`… : JsonConverter<T>`). */
function declared(text: string): Declared {
	const kept = text
		.split("\n")
		.filter((line) => !/^\s*\/\/\//.test(line))
		.join("\n")
	return {
		converters: [...kept.matchAll(/^public sealed class \w+ : JsonConverter<\w+>$/gm)].map(([head]) => head),
		type: kept.split("\n\npublic sealed class ")[0] as string,
	}
}

/** The C# type at a use position and every declaration it hoisted. */
function use({ schema, at = ["T", "v"], components }: UseRow) {
	const ctx = { ...context(components), fieldName: at[1], parentName: at[0] }
	const type = csTypeOf(schemaToIR(schema), ctx)
	return { decls: Object.fromEntries([...ctx.decls].map(([name, text]) => [name, declared(text)])), type }
}

/** What a use row expects: its type and exactly the declarations it hoists. */
const usedAs = (row: UseRow) => ({ decls: row.decls ?? {}, type: row.type })

/** A string enum: one member per value, with its own exact converter (§1 rules). */
const stringEnum = (name: string, ...members: string[]): Declared => ({
	converters: [`public sealed class ${name}Converter : JsonConverter<${name}>`],
	type: [
		`[JsonConverter(typeof(${name}Converter))]`,
		`public enum ${name}`,
		"{",
		...members.map((m) => `    ${m},`),
		"}",
	].join("\n"),
})

/** An integer enum through the runtime's `IntEnumConverter<T>`: `L<n>` members. */
const intEnum = (name: string, ...members: [member: string, value: number][]): Declared => ({
	converters: [],
	type: [
		`[JsonConverter(typeof(IntEnumConverter<${name}>))]`,
		`public enum ${name}`,
		"{",
		...members.map(([member, value]) => `    ${member} = ${value},`),
		"}",
	].join("\n"),
})

/** One property: its `[JsonPropertyName]`, then `public <decl> { get; init; }`. */
const property = (key: string, decl: string) => [
	`[JsonPropertyName(${JSON.stringify(key)})]`,
	`public ${decl} { get; init; }`,
]

/** A sealed record, one 4-space-indented property per field and a blank line between properties. */
const record = (name: string, ...properties: string[][]): Declared => ({
	converters: [],
	type: [
		`public sealed record ${name}`,
		"{",
		...properties.flatMap((lines, i) => [...(i > 0 ? [""] : []), ...lines.map((line) => `    ${line}`)]),
		"}",
	].join("\n"),
})

const STRING = { type: "string" }
const USER = { properties: { id: STRING }, required: ["id"], type: "object" }
const JSON_ELEMENT = "JsonElement"
const MAP = "IReadOnlyDictionary"

const nest = (depth: number): Json => (depth === 0 ? STRING : { items: nest(depth - 1), type: "array" })

describe("csTypeOf: scalars", () => {
	it.each<UseRow>([
		{ schema: STRING, title: "string is string", type: "string" },
		{ schema: { type: "integer" }, title: "integer is long", type: "long" },
		{ schema: { type: "number" }, title: "number is double", type: "double" },
		{ schema: { type: "boolean" }, title: "boolean is bool", type: "bool" },
		{ schema: { type: "null" }, title: "null alone is JsonElement", type: JSON_ELEMENT },
		{ schema: undefined, title: "no schema is JsonElement", type: JSON_ELEMENT },
		{ schema: {}, title: "the empty schema is JsonElement", type: JSON_ELEMENT },
		{ schema: { format: "binary", type: "string" }, title: "a binary string inside JSON is string", type: "string" },
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("csTypeOf: consts", () => {
	it.each<UseRow>([
		{ schema: { const: "admin" }, title: "a string const is string", type: "string" },
		{ schema: { const: 42 }, title: "an integral const is long", type: "long" },
		{ schema: { const: 1.5 }, title: "a non-integral const is double", type: "double" },
		{
			schema: { const: 42, type: "number" },
			title: "a const declared number is double, integral or not",
			type: "double",
		},
		{ schema: { const: true }, title: "a boolean const is bool", type: "bool" },
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("csTypeOf: arrays and tuples", () => {
	it.each<UseRow>([
		{
			schema: { items: STRING, type: "array" },
			title: "an array of string is IReadOnlyList<string>",
			type: "IReadOnlyList<string>",
		},
		{
			schema: { items: { items: { type: "integer" }, type: "array" }, type: "array" },
			title: "an array of arrays nests IReadOnlyList",
			type: "IReadOnlyList<IReadOnlyList<long>>",
		},
		{
			components: { User: USER },
			schema: { items: ref("User"), type: "array" },
			title: "an array of $ref is a list of the ref",
			type: "IReadOnlyList<User>",
		},
		{
			schema: { items: { nullable: true, type: "string" }, type: "array" },
			title: "an array of nullable string is IReadOnlyList<string?>",
			type: "IReadOnlyList<string?>",
		},
		{
			schema: { items: { oneOf: [STRING, { type: "integer" }] }, type: "array" },
			title: "an array of a oneOf is a list of JsonElement",
			type: `IReadOnlyList<${JSON_ELEMENT}>`,
		},
		{
			schema: { items: [STRING, { type: "number" }], type: "array" },
			title: "a tuple is IReadOnlyList<JsonElement>",
			type: `IReadOnlyList<${JSON_ELEMENT}>`,
		},
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("csTypeOf: nullable", () => {
	it.each<UseRow>([
		{ schema: { nullable: true, type: "string" }, title: "nullable: true string is string?", type: "string?" },
		{ schema: { type: ["string", "null"] }, title: "type [string, null] is string?", type: "string?" },
		{ schema: { anyOf: [STRING, { type: "null" }] }, title: "anyOf [string, null] is string?", type: "string?" },
		{ schema: { type: ["integer", "null"] }, title: "type [integer, null] is long?", type: "long?" },
		{
			components: { User: USER },
			schema: { oneOf: [ref("User"), { type: "null" }] },
			title: "oneOf [$ref, null] is the ref, nullable",
			type: "User?",
		},
		{ schema: { type: ["string", "number"] }, title: "a multi-type without null is JsonElement", type: JSON_ELEMENT },
		{
			schema: { type: ["string", "number", "null"] },
			title: "a multi-type with null is JsonElement: JsonElement stays JsonElement, never JsonElement?",
			type: JSON_ELEMENT,
		},
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("csTypeOf: unions, refs and allOf", () => {
	it.each<UseRow>([
		{
			schema: { oneOf: [STRING, { type: "integer" }] },
			title: "a oneOf in use position is JsonElement",
			type: JSON_ELEMENT,
		},
		{ schema: { enum: ["active", 1] }, title: "a mixed string and integer enum is JsonElement", type: JSON_ELEMENT },
		{ components: { User: USER }, schema: ref("User"), title: "a $ref is the component's C# name", type: "User" },
		{
			schema: { allOf: [STRING, { type: "integer" }] },
			title: "an allOf of two scalars is JsonElement",
			type: JSON_ELEMENT,
		},
		{ schema: { allOf: [STRING] }, title: "an allOf of one part is that part", type: "string" },
		{
			components: { Base: USER },
			schema: { allOf: [{ properties: { x: STRING } }, ref("Base")] },
			title: "an allOf holding a $ref is its first $ref, hoisting nothing",
			type: "Base",
		},
		{
			schema: { allOf: [{ properties: { x: STRING } }, { properties: { y: STRING } }] },
			title: "an allOf of inline objects alone is JsonElement",
			type: JSON_ELEMENT,
		},
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("csTypeOf: maps and additionalProperties", () => {
	it.each<UseRow>([
		{
			schema: { type: "object" },
			title: "an open object without fields is a map of JsonElement",
			type: `${MAP}<string, ${JSON_ELEMENT}>`,
		},
		{
			schema: { additionalProperties: true, type: "object" },
			title: "additionalProperties: true is a map of JsonElement",
			type: `${MAP}<string, ${JSON_ELEMENT}>`,
		},
		{
			schema: { additionalProperties: { type: "integer" }, type: "object" },
			title: "additionalProperties without fields is IReadOnlyDictionary<string, T>",
			type: `${MAP}<string, long>`,
		},
		{
			components: { User: USER },
			schema: { additionalProperties: ref("User"), type: "object" },
			title: "a map of a $ref holds the ref",
			type: `${MAP}<string, User>`,
		},
		{
			schema: { additionalProperties: false, type: "object" },
			title: "a closed object without fields is JsonElement",
			type: JSON_ELEMENT,
		},
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("csTypeOf: hoisted enums", () => {
	it.each<UseRow>([
		{
			decls: { TV: stringEnum("TV", "A", "B") },
			schema: { enum: ["a", "b"], type: "string" },
			title: "a string enum hoists <Parent><Field> with its own converter",
			type: "TV",
		},
		{
			at: ["User", "status"],
			decls: { UserStatus: stringEnum("UserStatus", "A", "B") },
			schema: { enum: ["a", "b"] },
			title: "an untyped all-string enum hoists as a string enum",
			type: "UserStatus",
		},
		{
			at: ["User", "status"],
			decls: { UserStatus: stringEnum("UserStatus", "A", "B") },
			schema: { enum: ["a", "b"], nullable: true, type: "string" },
			title: "a nullable string enum is the hoisted enum, nullable",
			type: "UserStatus?",
		},
		{
			decls: { TV: intEnum("TV", ["L1", 1], ["L2", 2]) },
			schema: { enum: [1, 2], type: "integer" },
			title: "an integer enum hoists <Parent><Field> through IntEnumConverter<T>",
			type: "TV",
		},
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("csTypeOf: hoisted objects", () => {
	it.each<UseRow>([
		{
			at: ["Root", "inner"],
			decls: { RootInner: record("RootInner", property("id", "required string Id")) },
			schema: { properties: { id: STRING }, required: ["id"] },
			title: "an inline object hoists a <Parent><Field> record, a required field required",
			type: "RootInner",
		},
		{
			at: ["Root", "inner"],
			decls: { RootInner: record("RootInner", property("id", "string? Id")) },
			schema: { properties: { id: STRING } },
			title: "an optional field of a hoisted record is T?",
			type: "RootInner",
		},
		{
			decls: { TVItem: record("TVItem", property("id", "required string Id")) },
			schema: { items: { properties: { id: STRING }, required: ["id"], type: "object" }, type: "array" },
			title: "an array of inline objects is a list of the hoisted <Parent><Field>Item",
			type: "IReadOnlyList<TVItem>",
		},
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("csTypeOf: one declaration per hoist", () => {
	it("declares a hoist reached twice under one key once, under the name it got first", () => {
		const ctx = { ...context({ User: USER }), fieldName: "inner", parentName: "Root" }
		const inner = schemaToIR({ properties: { id: STRING }, required: ["id"] })
		expect([csTypeOf(inner, ctx), csTypeOf(inner, ctx), [...ctx.decls.keys()]]).toEqual([
			"RootInner",
			"RootInner",
			["RootInner"],
		])
	})
})

describe("csTypeOf: depth", () => {
	it("renders a schema nested past depth 12 as JsonElement", () => {
		expect([
			use({ schema: nest(12), title: "", type: "" }).type,
			use({ schema: nest(13), title: "", type: "" }).type,
		]).toEqual([
			`${"IReadOnlyList<".repeat(12)}string${">".repeat(12)}`,
			`${"IReadOnlyList<".repeat(13)}${JSON_ELEMENT}${">".repeat(13)}`,
		])
	})
})
