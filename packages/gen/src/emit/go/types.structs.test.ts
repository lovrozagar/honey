import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import { schemaToIR } from "../../ir/schema.ts"
import { goTopLevel, goTypeContext, goTypeOf } from "./types.ts"

type Json = Record<string, unknown>

/** A use-position row: `schema` at field `at` of a parent gives `type` and hoists `decls`. */
type UseRow = {
	title: string
	schema: Json | undefined
	type: string
	decls?: Record<string, string>
	at?: [parent: string, field: string]
	/** names come from a document holding these components (cyclic set, claimed names) */
	components?: Record<string, Json>
}

/** A top-level row: component `name` declares `type` (comments dropped) with `methods`, hoisting `decls`. */
type TopRow = {
	title: string
	name: string
	/** defaults to `components[name]` */
	schema?: Json
	components?: Record<string, Json>
	type: string
	methods?: string[]
	decls?: Record<string, string>
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
	components ? goTypeContext(toIR(doc(components))) : goTypeContext()

/** The Go type at a use position and every declaration it hoisted. */
function use({ schema, at = ["T", "v"], components }: UseRow) {
	const ctx = { ...context(components), fieldName: at[1], parentName: at[0] }
	const type = goTypeOf(schemaToIR(schema), ctx)
	return { decls: Object.fromEntries(ctx.decls), type }
}

/** A component's declaration as its type text (comments dropped), its method set, and what it hoisted. */
function top({ name, schema, components }: TopRow) {
	const ctx = context(components)
	const text = goTopLevel(name, schemaToIR(schema ?? components?.[name]), ctx)
	const head = text.split("\n\nfunc ")[0] as string
	return {
		decls: Object.fromEntries(ctx.decls),
		methods: [...text.matchAll(/^func \(\w+ (\*?\w+)\) (\w+)\(/gm)].map(([, recv, method]) => `(${recv}) ${method}`),
		type: head
			.split("\n")
			.filter((line) => !/^\s*\/\//.test(line))
			.join("\n"),
	}
}

/** What a use row expects: its type and exactly the declarations it hoists. */
const usedAs = (row: UseRow) => ({ decls: row.decls ?? {}, type: row.type })
/** What a top-level row expects: its type, its method set and exactly the declarations it hoists. */
const declaredAs = (row: TopRow) => ({ decls: row.decls ?? {}, methods: row.methods ?? [], type: row.type })
/** `type <name> struct { <fields> }` as the emitter writes it, one tab-indented field per line. */
const struct = (name: string, ...fields: string[]) =>
	[`type ${name} struct {`, ...fields.map((f) => `\t${f}`), "}"].join("\n")

/** A hoisted or top-level enum: the named type, then one `<Name><Label>` const per value. */
const enumDecl = (name: string, base: "int" | "string", ...values: [label: string, literal: string][]) =>
	[`type ${name} ${base}`, "const (", ...values.map(([label, lit]) => `\t${name}${label} ${name} = ${lit}`), ")"].join(
		"\n",
	)

const MARSHAL = (name: string) => `(${name}) MarshalJSON`
const UNMARSHAL = (name: string) => `(*${name}) UnmarshalJSON`

const STRING = { type: "string" }
const COMMENT = { properties: { parent: ref("Comment") }, type: "object" }
const DEFINITION = {
	properties: {
		filters: { properties: { limit: { type: "integer" }, search: STRING }, required: ["limit"], type: "object" },
	},
	required: ["filters"],
	type: "object",
}
const FEED = {
	properties: {
		items: {
			items: { properties: { id: STRING, score: { type: "number" } }, required: ["id"], type: "object" },
			type: "array",
		},
	},
	required: ["items"],
	type: "object",
}
const RESERVED = {
	properties: { chan: STRING, func: STRING, type: STRING },
	required: ["type", "chan", "func"],
	type: "object",
}
const THING = {
	properties: {
		attrs: { additionalProperties: STRING, type: "object" },
		note: { type: ["string", "null"] },
		parent: { anyOf: [ref("Thing"), { type: "null" }] },
		plain: STRING,
		tags: { items: STRING, type: "array" },
		"x-key": { type: ["integer", "null"] },
	},
	required: ["tags", "attrs"],
	type: "object",
}
const DOG = { properties: { kind: { const: "dog" }, name: STRING }, required: ["kind", "name"], type: "object" }
const CAT = { properties: { kind: { enum: ["cat"], type: "string" } }, required: ["kind"], type: "object" }
const ANIMAL = { discriminator: { propertyName: "kind" }, oneOf: [ref("Dog"), ref("Cat")] }

const PET = {
	discriminator: { mapping: { fish: "#/components/schemas/Fish" }, propertyName: "type" },
	oneOf: [
		ref("Fish"),
		ref("Code"),
		{ properties: { type: { const: "lizard" } }, required: ["type"], type: "object" },
		{ properties: { type: { const: 1 } }, type: "object" },
		{ properties: { type: STRING }, type: "object" },
		STRING,
	],
}
const UNTAGGED = {
	properties: { "": { type: ["integer", "null"] }, "a,b": STRING, 'c"d': { items: STRING, type: "array" } },
	required: ["a,b"],
	type: "object",
}

const ID = 'Id string `json:"id"`'

describe("goTypeOf: nullable and pointers", () => {
	it.each<UseRow>([
		// v0: 2616780db8
		{ schema: { nullable: true, type: "string" }, title: "nullable: true string is *string", type: "*string" },
		// v0: c72fd1c908
		{ schema: { type: ["string", "null"] }, title: "type [string, null] is *string", type: "*string" },
		// v0: d525f50e10
		{
			schema: { type: ["string", "number"] },
			title: "a multi-type without null is json.RawMessage",
			type: "json.RawMessage",
		},
		// v0: 2b1175f179
		{
			schema: { type: ["string", "number", "null"] },
			title: "a multi-type with null is json.RawMessage, never a pointer",
			type: "json.RawMessage",
		},
		// v0: 7b4b734e5d
		{ schema: { anyOf: [STRING, { type: "null" }] }, title: "anyOf [string, null] is *string", type: "*string" },
		// v0: 80d017f93d
		{
			schema: { anyOf: [STRING, { type: "integer" }, { type: "null" }] },
			title: "anyOf of two types plus null is json.RawMessage",
			type: "json.RawMessage",
		},
		// v0: d6106ca788
		{
			schema: { oneOf: [ref("User"), { type: "null" }] },
			title: "oneOf [$ref, null] is a pointer to the ref",
			type: "*User",
		},
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("goTopLevel: nullable and pointers", () => {
	it.each<TopRow>([
		// v0: 5be6b85a64
		{
			components: { Thing: THING },
			methods: [MARSHAL("Thing")],
			name: "Thing",
			title: "optional-nullable is Nullable[T] omitzero, a cyclic ref inside stays *T, optional is *T omitempty",
			type: struct(
				"Thing",
				'Attrs map[string]string `json:"attrs"`',
				'Note Nullable[string] `json:"note,omitzero"`',
				'Parent Nullable[*Thing] `json:"parent,omitzero"`',
				'Plain *string `json:"plain,omitempty"`',
				'Tags []string `json:"tags"`',
				'XKey Nullable[int64] `json:"x-key,omitzero"`',
			),
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("goTypeOf: unions and discriminators", () => {
	it.each<UseRow>([
		// v0: b2d724f39b
		{
			schema: { oneOf: [STRING, { type: "integer" }] },
			title: "a oneOf without a discriminator is json.RawMessage",
			type: "json.RawMessage",
		},
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("goTopLevel: unions and discriminators", () => {
	it.each<TopRow>([
		// v0: 8989bc6e20
		{
			components: { Animal: ANIMAL, Cat: CAT, Dog: DOG },
			methods: [UNMARSHAL("Animal"), MARSHAL("Animal")],
			name: "Animal",
			title: "a discriminated oneOf is a struct of one *Variant per value plus Raw, (un)marshalled on the tag",
			type: struct("Animal", "Dog *Dog", "Cat *Cat", "Raw json.RawMessage"),
		},
		{
			decls: {
				PetLizard: struct("PetLizard", 'Type string `json:"type"`'),
				PetVariant3: struct("PetVariant3", 'Type *int64 `json:"type,omitempty"`'),
				PetVariant4: struct("PetVariant4", 'Type *string `json:"type,omitempty"`'),
			},
			methods: [UNMARSHAL("Pet"), MARSHAL("Pet")],
			name: "Pet",
			schema: PET,
			title: "variants: a mapped ref, a ref by its name, an inline object hoisted by its value or index, a scalar none",
			type: struct(
				"Pet",
				"Fish *Fish",
				"Code *Code",
				"Lizard *PetLizard",
				"PetVariant3 *PetVariant3",
				"PetVariant4 *PetVariant4",
				"Raw json.RawMessage",
			),
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("goTypeOf: allOf", () => {
	it.each<UseRow>([
		{ schema: { allOf: [ref("Base")] }, title: "an allOf of one $ref is that ref", type: "Base" },
		{
			decls: { TV: struct("TV", 'X *string `json:"x,omitempty"`') },
			schema: { allOf: [{ properties: { x: STRING } }] },
			title: "an allOf of one inline object hoists that object",
			type: "TV",
		},
		{ schema: { allOf: [] }, title: "an empty allOf is json.RawMessage", type: "json.RawMessage" },
		// v0: d929f3c537
		{
			decls: { TV: struct("TV", "Base", 'X *string `json:"x,omitempty"`') },
			schema: { allOf: [ref("Base"), { properties: { x: STRING } }] },
			title: "an allOf of a $ref and an object hoists a struct embedding the ref",
			type: "TV",
		},
		// v0: 43d0792bcb
		{
			decls: { TV: struct("TV", 'X *string `json:"x,omitempty"`', 'Y *string `json:"y,omitempty"`') },
			schema: { allOf: [{ properties: { x: STRING } }, { properties: { y: STRING } }] },
			title: "an allOf of inline objects hoists one struct of all their fields",
			type: "TV",
		},
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("goTopLevel: allOf", () => {
	it.each<TopRow>([
		// v0: 5dfd9485b3
		{
			name: "Ext",
			schema: { allOf: [ref("Base"), { properties: { y: STRING }, type: "object" }] },
			title: "a top-level allOf embeds its refs and inlines the object fields",
			type: struct("Ext", "Base", 'Y *string `json:"y,omitempty"`'),
		},
		{
			components: { Keyed: { properties: { 'q"k': STRING }, required: ['q"k'], type: "object" } },
			methods: [UNMARSHAL("Wrapped"), MARSHAL("Wrapped")],
			name: "Wrapped",
			schema: { allOf: [ref("Keyed"), { properties: { y: STRING }, type: "object" }] },
			title: "a top-level allOf embedding a part with its own (un)marshal methods (un)marshals each part itself",
			type: struct("Wrapped", "Keyed", 'Y *string `json:"y,omitempty"`'),
		},
		{
			components: { Base: { properties: { id: STRING }, required: ["id"], type: "object" } },
			name: "Plain",
			schema: { allOf: [ref("Base"), { properties: { y: STRING }, type: "object" }] },
			title: "a top-level allOf over plain object parts leaves encoding/json to the embedding",
			type: struct("Plain", "Base", 'Y *string `json:"y,omitempty"`'),
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("goTypeOf: refs and cycles", () => {
	it.each<UseRow>([
		// v0: b80fe84ad2
		{ schema: ref("user_profile"), title: "a $ref is the component's exported Go name", type: "UserProfile" },
		{
			components: { Comment: COMMENT },
			schema: ref("Missing"),
			title: "a $ref to no component is its exported Go name",
			type: "Missing",
		},
		// v0: 1431b8a97b
		{
			components: { Comment: COMMENT },
			schema: ref("Comment"),
			title: "a $ref into a cycle is *Name",
			type: "*Comment",
		},
		{
			components: { Comment: COMMENT },
			schema: { items: ref("Comment"), type: "array" },
			title: "a slice of a cyclic ref needs no pointer",
			type: "[]Comment",
		},
		{
			components: { Comment: COMMENT },
			schema: { additionalProperties: ref("Comment"), type: "object" },
			title: "a map of a cyclic ref needs no pointer",
			type: "map[string]Comment",
		},
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("goTopLevel: refs and cycles", () => {
	it.each<TopRow>([
		// v0: d1952e89cc
		{
			name: "Comment",
			schema: COMMENT,
			title: "a self-referencing field is a pointer to the component",
			type: struct("Comment", 'Parent *Comment `json:"parent,omitempty"`'),
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("goTypeOf: hoisting and naming", () => {
	it.each<UseRow>([
		// v0: b08d1e39e8
		{
			decls: { TV: struct("TV", ID) },
			schema: { properties: { id: STRING }, required: ["id"], type: "object" },
			title: "an inline object hoists a named <Parent><Field> struct, required fields bare",
			type: "TV",
		},
		// v0: 8ada6f0de9
		{
			decls: { TV: struct("TV", ID) },
			schema: { additionalProperties: false, properties: { id: STRING }, required: ["id"], type: "object" },
			title: "an inline closed object hoists the struct of its properties alone",
			type: "TV",
		},
		{
			components: { Config: { type: "object" } },
			schema: ref("Config"),
			title: "a component named like a runtime identifier is <Name>Model",
			type: "ConfigModel",
		},
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})

	it("hoists one declaration per parent field, reused on every use", () => {
		const ctx = { ...goTypeContext(), fieldName: "status", parentName: "User" }
		const status = schemaToIR({ enum: ["a"], type: "string" })
		expect([goTypeOf(status, ctx), goTypeOf(status, ctx), [...ctx.decls.keys()]]).toEqual([
			"UserStatus",
			"UserStatus",
			["UserStatus"],
		])
	})
})

describe("goTopLevel: hoisting and naming", () => {
	it.each<TopRow>([
		// v0: 422cc644e3
		{
			decls: {
				DefinitionFilters: struct(
					"DefinitionFilters",
					'Limit int64 `json:"limit"`',
					'Search *string `json:"search,omitempty"`',
				),
			},
			name: "Definition",
			schema: DEFINITION,
			title: "an inline object field hoists <Parent><Field> and the field uses it",
			type: struct("Definition", 'Filters DefinitionFilters `json:"filters"`'),
		},
		// v0: 4e97821eb6
		{
			decls: { FeedItemsItem: struct("FeedItemsItem", ID, 'Score *float64 `json:"score,omitempty"`') },
			methods: [MARSHAL("Feed")],
			name: "Feed",
			schema: FEED,
			title: "an array of inline objects is []<Parent><Field>Item with the item struct hoisted",
			type: struct("Feed", 'Items []FeedItemsItem `json:"items"`'),
		},
		// v0: 56561e5a8b
		{
			name: "User",
			schema: { properties: { email: STRING, name: STRING }, required: ["email"], type: "object" },
			title: "a struct sorts fields by JSON key: required bare, optional *T omitempty",
			type: struct("User", 'Email string `json:"email"`', 'Name *string `json:"name,omitempty"`'),
		},
		// v0: 01fc22f1ba
		{
			name: "X",
			schema: { properties: { "bad-key": STRING }, type: "object" },
			title: "a non-identifier key is an exported field whose json tag keeps the key",
			type: struct("X", 'BadKey *string `json:"bad-key,omitempty"`'),
		},
		// v0: 5b5c823123
		{
			name: "Reserved",
			schema: RESERVED,
			title: "Go keyword keys are exported fields with their original json tags",
			type: struct("Reserved", 'Chan string `json:"chan"`', 'Func string `json:"func"`', 'Type string `json:"type"`'),
		},
		{
			components: {
				User: { properties: { status: { enum: ["a"], type: "string" } }, required: ["status"], type: "object" },
				UserStatus: STRING,
			},
			decls: { UserStatus2: enumDecl("UserStatus2", "string", ["A", '"a"']) },
			name: "User",
			title: "a hoisted name a component already holds takes the next free suffix",
			type: struct("User", 'Status UserStatus2 `json:"status"`'),
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("goTopLevel: keys no json tag can name", () => {
	it.each<TopRow>([
		{
			methods: [UNMARSHAL("Untagged"), MARSHAL("Untagged")],
			name: "Untagged",
			schema: UNTAGGED,
			title: "a key no json tag can name is (un)marshalled by hand; its tag names it unless empty or holding a comma",
			type: struct("Untagged", 'X Nullable[int64] `json:"-"`', 'AB string `json:"-"`', 'CD []string `json:"c\\"d"`'),
		},
		{
			methods: [UNMARSHAL("Ticked"), MARSHAL("Ticked")],
			name: "Ticked",
			schema: { properties: { "a`b": STRING }, required: ["a`b"], type: "object" },
			title: "a key holding a backtick names itself in an interpreted-string tag",
			type: struct("Ticked", 'AB string "json:\\"a`b\\""'),
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("goTopLevel: the key -", () => {
	it.each<TopRow>([
		{
			name: "Dash",
			schema: { properties: { "-": STRING }, required: ["-"], type: "object" },
			title: 'a required key - is tagged json:"-," (json:"-" would skip the field)',
			type: struct("Dash", 'X string `json:"-,"`'),
		},
		{
			name: "MaybeDash",
			schema: { properties: { "-": STRING }, type: "object" },
			title: "an optional key - keeps its omitempty tag",
			type: struct("MaybeDash", 'X *string `json:"-,omitempty"`'),
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})
