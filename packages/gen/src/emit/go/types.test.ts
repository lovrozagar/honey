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
const SETTINGS = { additionalProperties: STRING, properties: { id: STRING }, required: ["id"], type: "object" }
const REGISTRY = {
	properties: {
		entries: {
			additionalProperties: {
				properties: { active: { type: "boolean" }, version: STRING },
				required: ["version"],
				type: "object",
			},
			type: "object",
		},
	},
	required: ["entries"],
	type: "object",
}

const nest = (depth: number): Json => (depth === 0 ? STRING : { items: nest(depth - 1), type: "array" })

const userStatus = { UserStatus: enumDecl("UserStatus", "string", ["A", '"a"'], ["B", '"b"']) }
const postScore = { PostScore: enumDecl("PostScore", "int", ["1", "1"], ["2", "2"]) }

describe("goTypeOf: scalars and formats", () => {
	it.each<UseRow>([
		// v0: b5c25f6295
		{ schema: STRING, title: "string is string", type: "string" },
		// v0: a53ccae189
		{ schema: { type: "integer" }, title: "integer is int64", type: "int64" },
		// v0: 432f5cb27b
		{ schema: { type: "number" }, title: "number is float64", type: "float64" },
		// v0: da1ac0e666
		{ schema: { type: "boolean" }, title: "boolean is bool", type: "bool" },
		// v0: 7d05131851
		{ schema: { type: "null" }, title: "null alone is json.RawMessage", type: "json.RawMessage" },
		// v0: 24e2b2b258
		{ schema: undefined, title: "no schema is json.RawMessage", type: "json.RawMessage" },
		// v0: 303bb2c3b8
		{ schema: {}, title: "the empty schema is json.RawMessage", type: "json.RawMessage" },
		// v0: af31478931
		{ schema: { format: "binary", type: "string" }, title: "a binary string inside JSON is string", type: "string" },
		// v0: 12e715094e
		{ schema: { format: "binary" }, title: "a bare binary format is string", type: "string" },
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})

	// v0: 340a4055fa
	it("renders a schema nested past depth 12 as json.RawMessage", () => {
		expect([
			use({ schema: nest(12), title: "", type: "" }).type,
			use({ schema: nest(13), title: "", type: "" }).type,
		]).toEqual([`${"[]".repeat(12)}string`, `${"[]".repeat(13)}json.RawMessage`])
	})
})

describe("goTypeOf: consts", () => {
	it.each<UseRow>([
		// v0: a3ca746c32
		{ schema: { const: "admin" }, title: "an untyped string const is string", type: "string" },
		// v0: ba12715c80
		{ schema: { const: 42 }, title: "an untyped integer const is int64", type: "int64" },
		// v0: dee5cf6552
		{ schema: { const: 3.14 }, title: "an untyped fractional const is float64", type: "float64" },
		// v0: 132b9c602b
		{ schema: { const: true }, title: "an untyped boolean const is bool", type: "bool" },
		// v0: 2791b0cdc6
		{ schema: { const: "admin", type: "string" }, title: "a typed string const is string", type: "string" },
		{
			schema: { const: 1, type: "number" },
			title: "a const declared number is float64, integral or not",
			type: "float64",
		},
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("goTopLevel: consts", () => {
	it.each<TopRow>([
		// v0: 4cdf01e418
		{
			name: "Role",
			schema: { const: "admin" },
			title: "a top-level string const is a named string with its Value const",
			type: 'type Role string\nconst RoleValue Role = "admin"',
		},
		// v0: 413f4e463d
		{
			name: "Success",
			schema: { const: false, type: "boolean" },
			title: "a top-level boolean const is a named bool with its Value const",
			type: "type Success bool\nconst SuccessValue Success = false",
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("goTypeOf: enums", () => {
	it.each<UseRow>([
		// v0: cb473200f4
		{
			at: ["User", "status"],
			decls: userStatus,
			schema: { enum: ["a", "b"], type: "string" },
			title: "a string enum field hoists <Parent><Field> with one const per value",
			type: "UserStatus",
		},
		// v0: f37da8983e
		{
			at: ["User", "status"],
			decls: userStatus,
			schema: { enum: ["a", "b"] },
			title: "an untyped all-string enum hoists as a string enum",
			type: "UserStatus",
		},
		// v0: d5a2c82053
		{
			at: ["Post", "score"],
			decls: postScore,
			schema: { enum: [1, 2], type: "integer" },
			title: "an integer enum field hoists an int type with int consts",
			type: "PostScore",
		},
		// v0: 200f2dcf07
		{
			at: ["Post", "score"],
			decls: postScore,
			schema: { enum: [1, 2] },
			title: "an untyped all-integer enum hoists as an int enum",
			type: "PostScore",
		},
		// v0: 7e8696c46f
		{
			at: ["User", "status"],
			decls: userStatus,
			schema: { enum: ["a", "b"], nullable: true, type: "string" },
			title: "a nullable string enum is a pointer to the hoisted type",
			type: "*UserStatus",
		},
		// v0: 761be8d4eb
		{
			at: ["User", "status"],
			decls: userStatus,
			schema: { enum: ["a", "b"], type: ["string", "null"] },
			title: "a string enum typed [string, null] is a pointer to the hoisted type",
			type: "*UserStatus",
		},
		// v0: 4b4b5dbecd
		{ schema: { enum: ["active", 1] }, title: "a mixed enum is json.RawMessage", type: "json.RawMessage" },
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("goTopLevel: enums", () => {
	it.each<TopRow>([
		// v0: 5a01436e9a
		{
			name: "Role",
			schema: { enum: ["a", "b"], type: "string" },
			title: "a top-level string enum is a named string with a const block",
			type: enumDecl("Role", "string", ["A", '"a"'], ["B", '"b"']),
		},
		// v0: e46a711678
		{
			name: "Status",
			schema: { enum: [1, 2], type: "integer" },
			title: "a top-level integer enum is a named int with a const block",
			type: enumDecl("Status", "int", ["1", "1"], ["2", "2"]),
		},
		// v0: c0b3372886
		{
			name: "Role",
			schema: { enum: ["x", "y", "z"], type: "string" },
			title: "a top-level enum is its one declaration and hoists nothing",
			type: enumDecl("Role", "string", ["X", '"x"'], ["Y", '"y"'], ["Z", '"z"']),
		},
		{
			name: "Sign",
			schema: { enum: [-1, 1.5, 2], type: "integer" },
			title: "an integer enum labels a negative value Neg<n> and has no constant for a fraction",
			type: enumDecl("Sign", "int", ["Neg1", "-1"], ["2", "2"]),
		},
		{
			name: "Labels",
			schema: { enum: ["", "a-b", "a_b", null], type: "string" },
			title: "a string enum labels the empty string Empty, suffixes a repeated label and has no constant for null",
			type: enumDecl("Labels", "string", ["Empty", '""'], ["AB", '"a-b"'], ["AB2", '"a_b"']),
		},
		// v0: 6b4d6666f3
		{
			decls: userStatus,
			name: "User",
			schema: { properties: { status: { enum: ["a", "b"], type: "string" } }, required: ["status"], type: "object" },
			title: "an enum field of a component hoists one <Parent><Field> type the field uses",
			type: struct("User", 'Status UserStatus `json:"status"`'),
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("goTypeOf: arrays and tuples", () => {
	it.each<UseRow>([
		// v0: 5cd1983689
		{ schema: { items: STRING, type: "array" }, title: "an array of string is []string", type: "[]string" },
		// v0: 9ced0daa99
		{ schema: { items: { type: "integer" }, type: "array" }, title: "an array of integer is []int64", type: "[]int64" },
		// v0: 89ad8352f3
		{
			schema: { items: [STRING, { type: "number" }], type: "array" },
			title: "a draft-07 tuple is [N]interface{} of its length",
			type: "[2]interface{}",
		},
		{
			schema: { prefixItems: [STRING, STRING, { type: "boolean" }], type: "array" },
			title: "a prefixItems tuple is [N]interface{} of its length",
			type: "[3]interface{}",
		},
		// v0: dacb1d78c2
		{ schema: { items: ref("User"), type: "array" }, title: "an array of $ref is a slice of the ref", type: "[]User" },
		// v0: 4645dd2069
		{
			schema: { items: { nullable: true, type: "string" }, type: "array" },
			title: "an array of nullable string is []*string",
			type: "[]*string",
		},
		// v0: 9283ca3f82
		{ schema: { type: "array" }, title: "an array without items is []json.RawMessage", type: "[]json.RawMessage" },
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("goTopLevel: arrays and tuples", () => {
	it.each<TopRow>([
		// v0: 9a192f01be
		{
			name: "Names",
			schema: { items: STRING, type: "array" },
			title: "a top-level array is a slice alias",
			type: "type Names = []string",
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("goTypeOf: maps and additionalProperties", () => {
	it.each<UseRow>([
		// v0: c9898700f4
		{
			schema: { additionalProperties: { type: "integer" }, type: "object" },
			title: "additionalProperties without properties is map[string]T",
			type: "map[string]int64",
		},
		// v0: dc4f51c41b
		{
			schema: { type: "object" },
			title: "an open object without properties is map[string]interface{}",
			type: "map[string]interface{}",
		},
		// v0: 6be1fb2ad4
		{
			schema: { additionalProperties: false, type: "object" },
			title: "a closed object without properties is struct{}",
			type: "struct{}",
		},
	])("$title", (row) => {
		expect(use(row)).toEqual(usedAs(row))
	})
})

describe("goTopLevel: maps and additionalProperties", () => {
	it.each<TopRow>([
		// v0: 077115dc27
		{
			name: "Attrs",
			schema: { additionalProperties: STRING, type: "object" },
			title: "a top-level map is a named map type",
			type: "type Attrs map[string]string",
		},
		// v0: 95c03a132b
		{
			name: "X",
			schema: { additionalProperties: false, type: "object" },
			title: "a top-level closed empty object is struct{}",
			type: "type X struct{}",
		},
		// v0: 7a491cbf9a
		{
			name: "X",
			schema: { type: "object" },
			title: "a top-level open empty object is map[string]interface{}",
			type: "type X map[string]interface{}",
		},
		// v0: 03bd08e141
		{
			methods: [UNMARSHAL("Config"), MARSHAL("Config")],
			name: "Config",
			schema: SETTINGS,
			title: "properties plus additionalProperties keep the rest in Extra with (un)marshal methods",
			type: struct("Config", 'Id string `json:"id"`', 'Extra map[string]string `json:"-"`'),
		},
		// v0: ba348bf35e
		{
			decls: {
				RegistryEntries: struct(
					"RegistryEntries",
					'Active *bool `json:"active,omitempty"`',
					'Version string `json:"version"`',
				),
			},
			methods: [MARSHAL("Registry")],
			name: "Registry",
			schema: REGISTRY,
			title: "a map of inline objects is map[string]<Hoisted> with the struct hoisted",
			type: struct("Registry", 'Entries map[string]RegistryEntries `json:"entries"`'),
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})
