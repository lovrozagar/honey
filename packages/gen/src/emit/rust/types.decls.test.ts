import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import { schemaToIR } from "../../ir/schema.ts"
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

/** A component's declaration as its type text (comments dropped), its impl headers, and what it hoisted. */
function top({ name, schema, components }: TopRow) {
	const ctx = context(components)
	const text = rustTopLevel(name, schemaToIR(schema ?? components?.[name]), ctx)
	return {
		...declared(text),
		decls: Object.fromEntries([...ctx.decls].map(([decl, body]) => [decl, declared(body)])),
	}
}

/** What a top-level row expects: its type, its impl headers and exactly the declarations it hoists. */
const declaredAs = (row: TopRow) => ({ decls: row.decls ?? {}, impls: row.impls ?? [], type: row.type })

const DERIVE = "#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]"
const SKIP = 'skip_serializing_if = "Option::is_none"'

/** One struct field: its `#[serde(…)]` keys when any, then `pub <decl>,`. */
const field = (decl: string, ...serde: string[]) =>
	[...(serde.length > 0 ? [`#[serde(${serde.join(", ")})]`] : []), `pub ${decl},`].join("\n")

const indent = (lines: string[]) => lines.flatMap((line) => line.split("\n").map((l) => `    ${l}`))

/** A struct declaration with its derives, one 4-space-indented field per line. */
const struct = (name: string, ...fields: string[]) =>
	[DERIVE, `pub struct ${name} {`, ...indent(fields), "}"].join("\n")

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

/** The hand-written serde impls of an integer enum or a discriminated union. */
const SERDE = (name: string) => [`impl serde::Serialize for ${name}`, `impl<'de> serde::Deserialize<'de> for ${name}`]

const plain = (type: string): Declared => ({ impls: [], type })

const STRING = { type: "string" }

/* a discriminator over a mapped ref, an unmapped ref, inline objects with a const, an enum and no
 * property, a scalar (no variant) and an inline const repeating a mapped value */
const PET = {
	discriminator: {
		mapping: { dog: "#/components/schemas/Dog", hound: "#/components/schemas/Dog" },
		propertyName: "kind",
	},
	oneOf: [
		ref("Dog"),
		ref("Bird"),
		{ properties: { fins: { type: "integer" }, kind: { const: "fish" } }, required: ["kind"], type: "object" },
		{ properties: { kind: { enum: ["eel", "ray"], type: "string" } }, type: "object" },
		{ properties: { x: STRING }, type: "object" },
		STRING,
		{ properties: { kind: { const: "dog" } }, required: ["kind"], type: "object" },
	],
}

describe("rustTopLevel: enum spellings", () => {
	it.each<TopRow>([
		{
			name: "Status",
			schema: { enum: ["Active", "inactive"], type: "string" },
			title: "a value already spelled as its variant needs no rename",
			type: stringEnum("Status", ["Active", "Active"], ["Inactive", "inactive"]),
		},
		{
			impls: SERDE("Level"),
			name: "Level",
			schema: { enum: [-1, 0, 2], type: "integer" },
			title: "a negative integer's variant is Neg<n>",
			type: [
				"#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]",
				"#[repr(i64)]",
				"pub enum Level {",
				"    #[default]",
				"    Neg1 = -1,",
				"    L0 = 0,",
				"    L2 = 2,",
				"}",
			].join("\n"),
		},
		{
			name: "Lits",
			schema: { oneOf: [{ const: "x" }, { const: "Y" }] },
			title: "a union of const strings alone is a string enum",
			type: stringEnum("Lits", ["X", "x"], ["Y", "Y"]),
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("rustTopLevel: discriminated variants", () => {
	it("names a variant by its mapping, its property's const or enum, else its ref or its hoisted type", () => {
		expect(top({ name: "Pet", schema: PET, title: "", type: "" })).toEqual({
			decls: {
				PetDog: plain(struct("PetDog", field("kind: String"))),
				PetEel: plain(struct("PetEel", field("kind: Option<PetEelKind>", SKIP))),
				PetEelKind: plain(stringEnum("PetEelKind", ["Eel", "eel"], ["Ray", "ray"])),
				PetFish: plain(struct("PetFish", field("fins: Option<i64>", SKIP), field("kind: String"))),
				PetVariant4: plain(struct("PetVariant4", field("x: Option<String>", SKIP))),
			},
			impls: SERDE("Pet"),
			type: [
				"#[derive(Debug, Clone, PartialEq)]",
				"pub enum Pet {",
				...indent(
					["Dog(Dog)", "Bird(Bird)", "Fish(PetFish)", "Eel(PetEel)", "PetVariant4(PetVariant4)", "Dog2(PetDog)"].map(
						(v) => `${v},`,
					),
				),
				"    Unknown(serde_json::Value),",
				"}",
			].join("\n"),
		})
	})

	it("selects each variant by its values, each value once: a repeat selects the first variant only", () => {
		const text = rustTopLevel("Pet", schemaToIR(PET), context())
		const arms = [...text.matchAll(/^ {12}Some\((.*)\) => serde_json::from_value\(value\)\.map\(Self::(\w+)\),$/gm)]
		expect(arms.map(([, values, variant]) => `${variant}: ${values}`)).toEqual([
			'Dog: "dog" | "hound"',
			'Bird: "Bird"',
			'Fish: "fish"',
			'Eel: "eel" | "ray"',
		])
	})
})

describe("rustTopLevel: claimed names", () => {
	it("declares a component the runtime or the prelude owns as <Name>Model, and a ref follows it", () => {
		const components = {
			Error: { properties: { v: STRING }, type: "object" },
			Option: { properties: { v: STRING }, type: "object" },
			User: { properties: { e: ref("Error"), o: ref("Option") }, type: "object" },
		}
		expect(top({ components, name: "User", title: "", type: "" })).toEqual({
			decls: {},
			impls: [],
			type: struct("User", field("e: Option<ErrorModel>", SKIP), field("o: Option<OptionModel>", SKIP)),
		})
	})

	it("moves a hoisted name that spells a prelude type on to …2", () => {
		const components = {
			Hash: { properties: { map: { properties: { k: STRING }, type: "object" } }, type: "object" },
		}
		expect(top({ components, name: "Hash", title: "", type: "" })).toEqual({
			decls: { HashMap2: plain(struct("HashMap2", field("k: Option<String>", SKIP))) },
			impls: [],
			type: struct("Hash", field("map: Option<HashMap2>", SKIP)),
		})
	})

	it("claims a declaration's name clear of the runtime under an IR, and as asked without one", () => {
		expect([context({}).names.claim("Client"), context().names.claim("Client")]).toEqual(["Client2", "Client"])
	})
})
