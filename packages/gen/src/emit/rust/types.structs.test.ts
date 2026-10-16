import { describe, expect, it } from "vitest"
import nestedStringEnum from "../../ir/__fixtures__/specs/go/nested-string-enum-field.json" with { type: "json" }
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import { schemaToIR } from "../../ir/schema.ts"
import { goTopLevel, goTypeContext } from "../go/types.ts"
import { rustTopLevel, rustTypeContext } from "./types.ts"

type Json = Record<string, unknown>

/** A declaration's type text (comments dropped) and the header of each trait impl after it. */
type Declared = { type: string; impls: string[] }

/** A top-level row: component `name` declares `type` (comments dropped) with `impls`, hoisting `decls`. */
type TopRow = {
	title: string
	name: string
	/** defaults to `components[name]` */
	schema?: Json
	components?: Record<string, Json>
	type: string
	impls?: string[]
	decls?: Record<string, Declared>
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

/** Every declaration a context hoisted, by name. */
const hoisted = (decls: Map<string, string>) =>
	Object.fromEntries([...decls].map(([name, text]) => [name, declared(text)]))

/** A component's declaration as its type text (comments dropped), its impl headers, and what it hoisted. */
function top({ name, schema, components }: TopRow) {
	const ctx = context(components)
	return {
		...declared(rustTopLevel(name, schemaToIR(schema ?? components?.[name]), ctx)),
		decls: hoisted(ctx.decls),
	}
}

/** What a top-level row expects: its type, its impl headers and exactly the declarations it hoists. */
const declaredAs = (row: TopRow) => ({ decls: row.decls ?? {}, impls: row.impls ?? [], type: row.type })

const DERIVE = "#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]"
const SKIP = 'skip_serializing_if = "Option::is_none"'
/** an optional nullable field: absent, null and a value are three states */
const TRI = ["default", 'deserialize_with = "crate::nullable::deserialize"', SKIP]
const rename = (key: string) => `rename = "${key}"`
const indent = (lines: string[]) => lines.flatMap((line) => line.split("\n").map((l) => `    ${l}`))

/** One struct field: its `#[serde(…)]` keys when any, then `pub <decl>,`. */
const field = (decl: string, ...serde: string[]) =>
	[...(serde.length > 0 ? [`#[serde(${serde.join(", ")})]`] : []), `pub ${decl},`].join("\n")

/** A struct declaration with its derives, one 4-space-indented field per line; `X {}` without fields. */
const struct = (name: string, ...fields: string[]) =>
	fields.length === 0
		? [DERIVE, `pub struct ${name} {}`].join("\n")
		: [DERIVE, `pub struct ${name} {`, ...indent(fields), "}"].join("\n")

/** A string enum: the first variant is `#[default]`; a variant renames itself only when its value differs. */
const stringEnum = (name: string, ...variants: [variant: string, value: string][]) =>
	[
		"#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, serde::Serialize, serde::Deserialize)]",
		`pub enum ${name} {`,
		...variants.flatMap(([variant, value], i) => [
			...(i === 0 ? ["    #[default]"] : []),
			...(variant === value ? [] : [`    #[serde(rename = "${value}")]`]),
			`    ${variant},`,
		]),
		"}",
	].join("\n")

/** An integer enum: `#[repr(i64)]`, the first variant `#[default]`; serde is implemented by hand (SERDE). */
const intEnum = (name: string, ...variants: [variant: string, value: number][]) =>
	[
		"#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]",
		"#[repr(i64)]",
		`pub enum ${name} {`,
		...variants.flatMap(([variant, value], i) => [
			...(i === 0 ? ["    #[default]"] : []),
			`    ${variant} = ${value},`,
		]),
		"}",
	].join("\n")

/** The hand-written serde impls of an integer enum or a discriminated union. */
const SERDE = (name: string) => [`impl serde::Serialize for ${name}`, `impl<'de> serde::Deserialize<'de> for ${name}`]

/** An untagged enum over its variants, serde trying each in order. */
const untagged = (name: string, ...variants: string[]) =>
	[DERIVE, "#[serde(untagged)]", `pub enum ${name} {`, ...indent(variants.map((v) => `${v},`)), "}"].join("\n")

/** A discriminated enum: one payload variant per mapped value, then Unknown keeping any other payload. */
const discriminated = (name: string, ...variants: string[]) =>
	[
		"#[derive(Debug, Clone, PartialEq)]",
		`pub enum ${name} {`,
		...indent([...variants, "Unknown(serde_json::Value)"].map((v) => `${v},`)),
		"}",
	].join("\n")

/** A top-level const: a newtype over its scalar. */
const newtype = (name: string, inner: string) => [DERIVE, `pub struct ${name}(pub ${inner});`].join("\n")

const plain = (type: string): Declared => ({ impls: [], type })

const STRING = { type: "string" }
const MAP = "std::collections::HashMap"
const BASE = { properties: { id: STRING }, required: ["id"], type: "object" }
const COMMENT = { properties: { parent: ref("Comment") }, type: "object" }
const DOG = { properties: { kind: STRING, name: STRING }, required: ["kind", "name"], type: "object" }
const CAT = { properties: { kind: STRING, lives: { type: "integer" } }, required: ["kind"], type: "object" }
const ANIMAL = {
	discriminator: {
		mapping: { cat: "#/components/schemas/Cat", dog: "#/components/schemas/Dog" },
		propertyName: "kind",
	},
	oneOf: [ref("Dog"), ref("Cat")],
}
/** v0 tests/fixtures/tri-state-spec.ts:3-38 */
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

describe("rustTopLevel: enums", () => {
	it.each<TopRow>([
		// v0: a1ff2ec4ed
		{
			name: "Role",
			schema: { enum: ["a", "b"], type: "string" },
			title: "a string enum renames each variant to its value, the first the default",
			type: stringEnum("Role", ["A", "a"], ["B", "b"]),
		},
		// v0: 4b2edd336d
		{
			impls: SERDE("Kind"),
			name: "Kind",
			schema: { enum: [1, 2], type: "integer" },
			title: "an integer enum is repr(i64) with L<n> variants and hand-written serde impls",
			type: intEnum("Kind", ["L1", 1], ["L2", 2]),
		},
		// v0: 784a6dbdf7
		{
			decls: {
				QSort: plain(
					stringEnum(
						"QSort",
						["CreatedAt", "-created_at"],
						["CreatedAt2", "created_at"],
						["Empty", ""],
						["SelfValue", "self"],
					),
				),
			},
			name: "Q",
			schema: { properties: { sort: { enum: ["-created_at", "created_at", "", "self"], type: "string" } } },
			title: "enum values become unique variants: a repeat takes …2, the empty string Empty, self SelfValue",
			type: struct("Q", field("sort: Option<QSort>", SKIP)),
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("rustTopLevel: consts", () => {
	it.each<TopRow>([
		// v0: 43ad8ae959
		{
			name: "Role",
			schema: { const: "admin" },
			title: "a string const is a String newtype",
			type: newtype("Role", "String"),
		},
		// v0: 70143fa86b
		{
			name: "Success",
			schema: { const: false, type: "boolean" },
			title: "a boolean const is a bool newtype",
			type: newtype("Success", "bool"),
		},
		// v0: ece2a23e15
		{
			name: "Mag",
			schema: { const: 42, type: "number" },
			title: "a const declared number is an f64 newtype, integral or not",
			type: newtype("Mag", "f64"),
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("rustTopLevel: struct fields", () => {
	it.each<TopRow>([
		// v0: 38585367eb
		{
			name: "User",
			schema: { properties: { email: STRING, name: STRING }, required: ["email"] },
			title: "fields sort by JSON key: required bare, optional Option<T> skipped when None",
			type: struct("User", field("email: String"), field("name: Option<String>", SKIP)),
		},
		// v0: 9d62f4a19f
		{
			name: "Resp",
			schema: { properties: { "bad-key": STRING }, required: ["bad-key"] },
			title: "a non-identifier key is a snake_case field renamed to the key",
			type: struct("Resp", field("bad_key: String", rename("bad-key"))),
		},
		// v0: d1f09dc336
		{
			name: "Person",
			schema: { properties: { firstName: STRING } },
			title: "a camelCase key is a snake_case field: the rename first, then the skip, in one attribute",
			type: struct("Person", field("first_name: Option<String>", rename("firstName"), SKIP)),
		},
		// v0: f265fd24a2
		{
			name: "Thing",
			schema: { properties: { fn: STRING, match: STRING, type: STRING }, required: ["type", "fn", "match"] },
			title: "keyword keys are raw identifiers that serialize under the key with no rename",
			type: struct("Thing", field("r#fn: String"), field("r#match: String"), field("r#type: String")),
		},
		// v0: 047b5225e0
		{
			components: { Thing: THING },
			name: "Thing",
			title: "optional-nullable is Option<Option<T>> through the null-preserving deserializer; optional is Option<T>",
			type: struct(
				"Thing",
				field(`attrs: ${MAP}<String, String>`),
				field("note: Option<Option<String>>", ...TRI),
				field("parent: Option<Option<Box<Thing>>>", ...TRI),
				field("plain: Option<String>", SKIP),
				field("tags: Vec<String>"),
				field("x_key: Option<Option<i64>>", rename("x-key"), ...TRI),
			),
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("rustTopLevel: flatten", () => {
	it.each<TopRow>([
		// v0: 14810e27af
		{
			components: { Base: BASE },
			name: "Ext",
			schema: { allOf: [ref("Base"), { properties: { y: STRING }, type: "object" }] },
			title: "an allOf flattens its $ref into a field and inlines the object's fields",
			type: struct("Ext", field("base: Base", "flatten"), field("y: Option<String>", SKIP)),
		},
		// v0: f902313a30
		{
			name: "Mixed",
			schema: { additionalProperties: STRING, properties: { id: STRING }, required: ["id"], type: "object" },
			title: "properties plus additionalProperties flatten the rest into extra, after the fields",
			type: struct("Mixed", field("id: String"), field(`extra: ${MAP}<String, String>`, "flatten")),
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("rustTopLevel: refs and cycles", () => {
	it.each<TopRow>([
		// v0: f3d1e57751
		{
			components: { Comment: COMMENT },
			name: "Comment",
			title: "a self-referencing field is an Option of a Box of the component",
			type: struct("Comment", field("parent: Option<Box<Comment>>", SKIP)),
		},
		// v0: fdac715f3f
		{
			components: {
				A: { properties: { b: ref("B") }, type: "object" },
				B: { properties: { a: ref("A") }, type: "object" },
			},
			name: "A",
			title: "mutual recursion boxes the field on the cycle (A.b)",
			type: struct("A", field("b: Option<Box<B>>", SKIP)),
		},
		// v0: fdac715f3f
		{
			components: {
				A: { properties: { b: ref("B") }, type: "object" },
				B: { properties: { a: ref("A") }, type: "object" },
			},
			name: "B",
			title: "mutual recursion boxes the field on the cycle (B.a)",
			type: struct("B", field("a: Option<Box<A>>", SKIP)),
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("rustTopLevel: aliases and empty objects", () => {
	it.each<TopRow>([
		// v0: 67af54d346
		{
			name: "Attrs",
			schema: { additionalProperties: STRING, type: "object" },
			title: "a map alone is a HashMap alias",
			type: `pub type Attrs = ${MAP}<String, String>;`,
		},
		// v0: e9146e472d
		{
			name: "X",
			schema: { type: "object" },
			title: "an open empty object is a HashMap of serde_json::Value alias",
			type: `pub type X = ${MAP}<String, serde_json::Value>;`,
		},
		/* V0BUG: v0 emitted the unit struct `pub struct X;`, which serde_json encodes as null and which rejects {} */
		// v0: 5a7811ce38
		{
			name: "X",
			schema: { additionalProperties: false, type: "object" },
			title: "a closed empty object is a braced struct, which serde encodes as {} (a unit struct is null)",
			type: struct("X"),
		},
		// v0: da702fc127
		{
			name: "Names",
			schema: { items: STRING, type: "array" },
			title: "an array is a Vec alias",
			type: "pub type Names = Vec<String>;",
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("rustTopLevel: unions", () => {
	it.each<TopRow>([
		// v0: 455da764a5
		{
			name: "AB",
			schema: { oneOf: [ref("A"), ref("B")] },
			title: "a oneOf without a discriminator is an untagged enum of Variant<i>",
			type: untagged("AB", "Variant0(A)", "Variant1(B)"),
		},
		/* V0BUG: v0's #[serde(tag = "kind")] consumed the discriminator a variant's required kind field needs */
		// v0: 2fda8aac06
		{
			components: { Animal: ANIMAL, Cat: CAT, Dog: DOG },
			impls: SERDE("Animal"),
			name: "Animal",
			title: "a discriminated oneOf is one payload variant per mapped value plus Unknown, (de)serialized by hand",
			type: discriminated("Animal", "Dog(Dog)", "Cat(Cat)"),
		},
		// v0: 1f2d0b3088
		{
			decls: { MixedLiteral: plain(stringEnum("MixedLiteral", ["A", "a"], ["B", "b"])) },
			name: "Mixed",
			schema: { oneOf: [{ const: "a", type: "string" }, { const: "b", type: "string" }, { type: "integer" }] },
			title: "const-string variants gather into one Literal variant over a hoisted string enum",
			type: untagged("Mixed", "Literal(MixedLiteral)", "Variant2(i64)"),
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("rustTopLevel: hoisted names", () => {
	// v0: 1f7c2435c9
	it("never merges two inline objects that hoist to one name: the later claim is …2", () => {
		const components = {
			User: { properties: { profile_settings: { properties: { theme: STRING }, type: "object" } }, type: "object" },
			UserProfile: { properties: { settings: { properties: { color: STRING }, type: "object" } }, type: "object" },
		}
		const ctx = context(components)
		const types = Object.entries(components).map(([name, schema]) =>
			declared(rustTopLevel(name, schemaToIR(schema), ctx)),
		)
		expect({ decls: hoisted(ctx.decls), types: types.map((t) => t.type) }).toEqual({
			decls: {
				UserProfileSettings: plain(struct("UserProfileSettings", field("theme: Option<String>", SKIP))),
				UserProfileSettings2: plain(struct("UserProfileSettings2", field("color: Option<String>", SKIP))),
			},
			types: [
				struct("User", field("profile_settings: Option<UserProfileSettings>", SKIP)),
				struct("UserProfile", field("settings: Option<UserProfileSettings2>", SKIP)),
			],
		})
	})

	// v0: 1f7c2435c9
	it("never merges an inline object with a component of its hoisted name: the hoist takes …2", () => {
		expect(
			top({
				components: {
					User: { properties: { profile_settings: { properties: { theme: STRING }, type: "object" } }, type: "object" },
					UserProfileSettings: BASE,
				},
				name: "User",
				title: "",
				type: "",
			}),
		).toEqual({
			decls: { UserProfileSettings2: plain(struct("UserProfileSettings2", field("theme: Option<String>", SKIP))) },
			impls: [],
			type: struct("User", field("profile_settings: Option<UserProfileSettings2>", SKIP)),
		})
	})

	// v0: 6452f07ffa
	it("hoists a nested string enum field under the name Go gives it", () => {
		const ir = toIR(nestedStringEnum as OpenApiDocument)
		const audience = schemaToIR(nestedStringEnum.components.schemas.Audience)
		const rust = rustTypeContext(ir)
		const go = goTypeContext(ir)
		rustTopLevel("Audience", audience, rust)
		goTopLevel("Audience", audience, go)
		expect({ go: [...go.decls.keys()], rust: [...rust.decls.keys()] }).toEqual({
			go: ["AudienceEngagement"],
			rust: ["AudienceEngagement"],
		})
	})
})
