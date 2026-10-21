/**
 * Java use positions, declared names and the reservation of type names (bit 16 phase b, B2, B3, B4): `javaTypeOf`
 * gives the type of a schema at a member of a parent and hoists an inline object, as `<Parent><Field>`, into the
 * context. A use position is a reference type, since generics take one (`List<Long>`); a required field is
 * primitive (models.records.test.ts). A component that declares nothing is its use type. A type name is reserved
 * when it collides with a keyword, a literal, a runtime or client type, or a type the emitted and runtime text
 * spells; a collision is `<Name>Model`, and an unspelled `java.lang` name is kept.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import { schemaToIR } from "../../ir/schema.ts"
import { declares, javaTypeContext, javaTypeOf } from "./models.ts"
import { generateJavaSdk } from "./sdk.ts"

type Json = Record<string, unknown>

/** A use-position row: `schema` at field `at` of a parent gives `type` and hoists the names in `decls`. */
type UseRow = {
	title: string
	schema: Json | undefined
	type: string
	decls?: string[]
	at?: [parent: string, field: string]
	/** names come from a document holding these components */
	components?: Record<string, Json>
	/** the names a client or the runtime reserves besides */
	taken?: readonly string[]
}

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` })

/** A minimal OpenAPI 3.1 document holding these components. */
const doc = (schemas: Record<string, Json>): OpenApiDocument => ({
	components: { schemas },
	info: { title: "Models", version: "1" },
	openapi: "3.1.0",
	paths: {},
})

const STRING = { type: "string" }
const OBJECT: Json = { properties: { id: STRING }, required: ["id"], type: "object" }
const CLIENT = "AnyrowClient"

/** The zero-op document: no path, so no operation. */
const ZERO: Json = { info: { title: "Anyrow", version: "1" }, openapi: "3.1.0", paths: {} }

/** The Java type at a use position and the names of every declaration it hoisted. */
function use({ schema, at = ["T", "v"], components = {}, taken = [] }: UseRow) {
	const ctx = { ...javaTypeContext(toIR(doc(components)), taken), fieldName: at[1], parentName: at[0] }
	const type = javaTypeOf(schemaToIR(schema), ctx)
	return { decls: [...ctx.decls.keys()], type }
}

/** What a use row expects: its type and exactly the declarations it hoists. */
const usedAs = (row: UseRow) => ({ decls: row.decls ?? [], type: row.type })

describe("javaTypeOf: scalars", () => {
	it.each<UseRow>([
		{ schema: STRING, title: "string is String", type: "String" },
		{ schema: { type: "integer" }, title: "integer is Long", type: "Long" },
		{ schema: { type: "number" }, title: "number is Double", type: "Double" },
		{ schema: { type: "boolean" }, title: "boolean is Boolean", type: "Boolean" },
		{ schema: { type: "null" }, title: "null alone is JsonNode, which holds null itself", type: "JsonNode" },
		{ schema: undefined, title: "no schema is JsonNode", type: "JsonNode" },
		{ schema: {}, title: "the empty schema is JsonNode", type: "JsonNode" },
		{ schema: { format: "binary", type: "string" }, title: "a binary string is String", type: "String" },
		{
			schema: { enum: [1, 2], type: "integer" },
			title: "an integer enum hoists as <Parent><Field>",
			type: "TV",
			decls: ["TV"],
		},
		{
			schema: { enum: ["a", "b"], type: "string" },
			title: "a string enum hoists as <Parent><Field>",
			type: "TV",
			decls: ["TV"],
		},
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("javaTypeOf: consts and nullable", () => {
	it.each<UseRow>([
		{ schema: { const: "a" }, title: "a string const is String", type: "String" },
		{ schema: { const: true }, title: "a boolean const is Boolean", type: "Boolean" },
		{ schema: { const: 3 }, title: "an integral const is Long", type: "Long" },
		{ schema: { const: 1.5 }, title: "a fractional const is Double", type: "Double" },
		{ schema: { const: 3, type: "number" }, title: "a const of a declared number is Double", type: "Double" },
		{
			schema: { nullable: true, type: "string" },
			title: "a nullable string is String, a reference already",
			type: "String",
		},
		{ schema: { nullable: true, type: "integer" }, title: "a nullable integer is Long", type: "Long" },
		{ schema: { nullable: true }, title: "a nullable open value stays JsonNode", type: "JsonNode" },
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("javaTypeOf: collections, maps, tuples and unions in use position", () => {
	it.each<UseRow>([
		{ schema: { items: STRING, type: "array" }, title: "an array is List of its item", type: "List<String>" },
		{
			schema: { items: { items: { type: "integer" }, type: "array" }, type: "array" },
			title: "nested arrays are nested Lists of boxed items",
			type: "List<List<Long>>",
		},
		{
			schema: { items: { properties: { n: STRING }, type: "object" }, type: "array" },
			title: "an inline item object hoists as <Parent><Field>Item",
			type: "List<TVItem>",
			decls: ["TVItem"],
		},
		{
			schema: { additionalProperties: STRING, type: "object" },
			title: "an object with only additionalProperties is Map<String, T>",
			type: "Map<String, String>",
		},
		{
			schema: { additionalProperties: false, type: "object" },
			title: "an object closed to every property with no fields is JsonNode",
			type: "JsonNode",
		},
		{
			schema: { type: "object" },
			title: "an object with no fields and no additionalProperties is Map<String, JsonNode>",
			type: "Map<String, JsonNode>",
		},
		{ schema: { prefixItems: [STRING], type: "array" }, title: "a tuple is List<JsonNode>", type: "List<JsonNode>" },
		{
			schema: { oneOf: [STRING, { type: "integer" }] },
			title: "a union in use position is JsonNode",
			type: "JsonNode",
		},
		{ schema: { allOf: [STRING] }, title: "an allOf of one part is that part", type: "String" },
		{ schema: { allOf: [] }, title: "an empty allOf is JsonNode", type: "JsonNode" },
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("javaTypeOf: references, aliases and hoisting", () => {
	it.each<UseRow>([
		{
			components: { User: OBJECT },
			schema: ref("User"),
			title: "a ref to a declared component is its name",
			type: "User",
		},
		{
			components: { Tags: { items: STRING, type: "array" } },
			schema: ref("Tags"),
			title: "a ref to a component that declares nothing is its use type",
			type: "List<String>",
		},
		{
			components: { Loop: ref("Loop") },
			schema: ref("Loop"),
			title: "a cycle through aliases ends at the depth cap as JsonNode",
			type: "JsonNode",
		},
		{
			components: { Ok: OBJECT },
			schema: ref("Missing"),
			title: "a ref to a component the document lacks is JsonNode",
			type: "JsonNode",
		},
		{
			at: ["Owner", "address"],
			decls: ["OwnerAddress"],
			schema: { properties: { city: STRING }, type: "object" },
			title: "an inline object hoists as <Parent><Field>",
			type: "OwnerAddress",
		},
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("declares: which components get a declaration", () => {
	it.each<[title: string, schema: Json, declared: boolean]>([
		["an object with fields", OBJECT, true],
		["an object with no fields and additionalProperties false", { additionalProperties: false, type: "object" }, true],
		["an object with only additionalProperties", { additionalProperties: STRING, type: "object" }, false],
		["a string enum", { enum: ["a"], type: "string" }, true],
		["an integer enum", { enum: [1], type: "integer" }, true],
		["a plain string", STRING, false],
		["an array", { items: STRING, type: "array" }, false],
		["a discriminated union", { discriminator: { propertyName: "kind" }, oneOf: [ref("A")] }, true],
		["a union of const strings (a string enum)", { oneOf: [{ const: "a" }, { const: "b" }] }, true],
		["a non-discriminated union of components", { oneOf: [ref("A"), ref("B")] }, false],
		["an allOf of objects", { allOf: [ref("A"), OBJECT] }, true],
	])("%s", (_title, schema, declared) => {
		expect(declares(schemaToIR(schema))).toBe(declared)
	})
})

/** The name a component `name` declares, in a document that also holds `taken` names as components. */
const nameOf = (name: string, taken: readonly string[] = [CLIENT]) =>
	javaTypeContext(toIR(doc({ [name]: OBJECT })), taken).names.ref(name)

describe("names: a type name is reserved only where it collides (B3, refined)", () => {
	it.each<[name: string, expected: string]>([
		["String", "StringModel"],
		["Long", "LongModel"],
		["Double", "DoubleModel"],
		["Boolean", "BooleanModel"],
		["Object", "ObjectModel"],
		["Override", "OverrideModel"],
		["Map", "MapModel"],
		["List", "ListModel"],
		["URI", "URIModel"],
		["JsonNode", "JsonNodeModel"],
		["JsonProperty", "JsonPropertyModel"],
		["JsonInclude", "JsonIncludeModel"],
		["StdDeserializer", "StdDeserializerModel"],
		["Opt", "OptModel"],
		["Json", "JsonModel"],
		["Transport", "TransportModel"],
		["AnyrowClient", "AnyrowClientModel"],
	])("a component named %s is %s: the emitted or runtime text spells it", (name, expected) => {
		expect(nameOf(name)).toBe(expected)
	})

	it.each<string>(["Thread", "Integer", "Record", "Exception", "Pet"])(
		"a component named %s is kept: no emitted or runtime text spells it",
		(name) => {
			expect(nameOf(name)).toBe(name)
		},
	)
})

describe("names: claims and hoists never merge", () => {
	it("gives an inline object whose hoisted name a component already holds the name …2", () => {
		const components = { OwnerAddress: OBJECT }
		const row = {
			at: ["Owner", "address"] as [string, string],
			components,
			schema: { properties: { city: STRING }, type: "object" },
			title: "",
		}
		expect(use({ ...row, decls: ["OwnerAddress2"], type: "OwnerAddress2" })).toEqual(
			usedAs({ ...row, decls: ["OwnerAddress2"], type: "OwnerAddress2" }),
		)
	})

	it("never merges two inline objects that hoist to one name: a distinct key claims the name …2", () => {
		const ctx = javaTypeContext(toIR(doc({ Owner: OBJECT })), [CLIENT])
		const inline = { properties: { a: STRING }, type: "object" }
		const first = javaTypeOf(schemaToIR(inline), { ...ctx, fieldName: "address", parentName: "Owner" })
		const second = javaTypeOf(schemaToIR(inline), { ...ctx, fieldName: "Address", parentName: "Owner" })
		expect([first, second]).toEqual(["OwnerAddress", "OwnerAddress2"])
	})
})

/* the code text a scan reads: no comments, no string contents */
const codeOf = (code: string) =>
	code
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "")
		.replace(/"(?:[^"\\\n]|\\.)*"/g, '""')

/* the types a text spells: each imported type by its simple name, and each capitalized identifier that is not a member access */
const spelled = (code: string): string[] => {
	const text = codeOf(code)
	const imported = [...text.matchAll(/^import [\w.]*\.(\w+);/gm)].map((match) => match[1] as string)
	const bare = [...text.matchAll(/(?<![.\w])[A-Z][A-Za-z0-9]*\b/g)].map((match) => match[0])
	return [...new Set([...imported, ...bare])]
}

/* the runtime's own sources, read on every run: the same set step 2 scans */
const runtimeText = (): string[] =>
	["Transport.java"].map((file) => readFileSync(new URL(`../../runtime/java/${file}`, import.meta.url), "utf8"))

describe("names: SPELLED is derived by a scan of the emitted client and the runtime", () => {
	it("reserves every type name the emitted client and the runtime spell, by scan", () => {
		const client = Object.entries(generateJavaSdk(ZERO).files)
			.filter(([path]) => path.endsWith(".java"))
			.map(([, text]) => text)
		const names = [...new Set([...client, ...runtimeText()].flatMap(spelled))].sort()
		const ir = toIR(doc(Object.fromEntries(names.map((name) => [name, OBJECT]))))
		const scope = javaTypeContext(ir, [CLIENT]).names
		const renamed = Object.fromEntries(names.map((name) => [name, scope.ref(name)]))
		expect(renamed).toEqual(Object.fromEntries(names.map((name) => [name, `${name}Model`])))
		expect(names).toEqual(
			expect.arrayContaining(["AnyrowClient", "Builder", "IllegalStateException", "String", "Transport", "URI"]),
		)
	})
})

describe("javaTypeOf: one key, one name (B3, B4)", () => {
	it("keeps an array's item object apart from a sibling field named <field>Item", () => {
		const ctx = javaTypeContext(toIR(doc({ Owner: OBJECT })), [CLIENT])
		const at = { ...ctx, parentName: "Owner" }
		const items = javaTypeOf(schemaToIR({ items: { properties: { a: STRING }, type: "object" }, type: "array" }), {
			...at,
			fieldName: "x",
		})
		const sibling = javaTypeOf(schemaToIR({ properties: { b: STRING }, type: "object" }), {
			...at,
			fieldName: "xItem",
		})
		expect([items, sibling]).toEqual(["List<OwnerXItem>", "OwnerXItem2"])
		expect([...ctx.decls.keys()]).toEqual(["OwnerXItem", "OwnerXItem2"])
	})

	it("gives the same key the same name: hoisting one inline object twice keeps one declaration", () => {
		const ctx = javaTypeContext(toIR(doc({ Owner: OBJECT })), [CLIENT])
		const at = { ...ctx, fieldName: "address", parentName: "Owner" }
		const inline = { properties: { a: STRING }, type: "object" }
		const first = javaTypeOf(schemaToIR(inline), at)
		const again = javaTypeOf(schemaToIR(inline), at)
		expect([first, again]).toEqual(["OwnerAddress", "OwnerAddress"])
		expect([...ctx.decls.keys()]).toEqual(["OwnerAddress"])
	})
})

describe("javaTypeOf: an allOf of several parts in use position (B2)", () => {
	it("takes the first ref part's type, the parts beside it not typed here", () => {
		const row: UseRow = {
			components: { User: OBJECT },
			schema: { allOf: [STRING, ref("User")] },
			title: "an allOf of a string and a ref is the ref's name",
			type: "User",
		}
		expect(use(row)).toEqual(usedAs(row))
	})
})
