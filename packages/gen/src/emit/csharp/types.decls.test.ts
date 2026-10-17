/**
 * C# declarations beyond the record (contract 45 §4.5, §4.7, §7.3): a string enum with its own exact converter, an
 * integer enum through `IntEnumConverter<T>`, a const-string union as a string enum, a discriminated union as Go's
 * record of variants plus `Raw` (Fb7), `allOf` as one record, the components C# declares nothing for, and the one
 * type scope: a component named like a runtime, BCL or client type is `<Name>Model`, and a hoist never merges.
 */
import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import { schemaToIR } from "../../ir/schema.ts"
import { generateCSharpSdk } from "./sdk.ts"
import { csTopLevel, csTypeContext, csTypeOf } from "./types.ts"

type Json = Record<string, unknown>

/** A declaration's type text (doc comments dropped) and the header of each converter class after it. */
type Declared = { type: string; converters: string[] }

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

/** Component `name`'s declaration (schema defaulting to `components[name]`) and every declaration it hoisted. */
function top(name: string, components: Record<string, Json>, schema = components[name]) {
	const ctx = context(components)
	const text = csTopLevel(name, schemaToIR(schema), ctx)
	return { decls: Object.fromEntries([...ctx.decls].map(([decl, body]) => [decl, declared(body)])), text }
}

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

/** One property: its `[JsonPropertyName]`, its other attributes, then `public <decl> { get; init; }`. */
const property = (key: string, decl: string, ...attributes: string[]) => [
	`[JsonPropertyName(${JSON.stringify(key)})]`,
	...attributes,
	`public ${decl} { get; init; }`,
]

/** A sealed record, one 4-space-indented property per member and a blank line between members. */
const record = (name: string, ...properties: string[][]): Declared => ({
	converters: [],
	type: [
		`public sealed record ${name}`,
		"{",
		...properties.flatMap((lines, i) => [...(i > 0 ? [""] : []), ...lines.map((line) => `    ${line}`)]),
		"}",
	].join("\n"),
})

/** A C# regular string literal's text, as a regex group. */
const LITERAL = String.raw`"(?:[^"\\]|\\.)*"`

/** A string enum converter's `Read` arms (`"value" => Member`) and `Write` arms (`Member => "value"`). */
const arms = (text: string, name: string) => ({
	read: [...text.matchAll(new RegExp(String.raw`^ +(${LITERAL}) => ${name}\.(\w+),$`, "gm"))].map(
		([, v, m]) => `${v} => ${m}`,
	),
	write: [...text.matchAll(new RegExp(String.raw`^ +${name}\.(\w+) => (${LITERAL}),$`, "gm"))].map(
		([, m, v]) => `${m} => ${v}`,
	),
})

/** A union converter's `Read` arms (`"value" => Variant`) and the variants `Write` tries, in order. */
const unionArms = (text: string, name: string) => ({
	read: [...text.matchAll(new RegExp(String.raw`^ +(${LITERAL}) => new ${name} \{ (\w+) = `, "gm"))].map(
		([, v, m]) => `${v} => ${m}`,
	),
	write: [...text.matchAll(/^ +(?:else )?if \(value\.(\w+) is \{ \} /gm)].map(([, m]) => m),
})

/** Every type an emitted `Types.cs` declares, sorted. */
const declaredNames = (source: string) =>
	[...source.matchAll(/^public (?:sealed (?:record|class)|enum) (\w+)/gm)].map(([, name]) => name).sort()

/** `name`'s declaration in an emitted `Types.cs`, doc comments dropped. */
function declarationIn(source: string, name: string): string {
	const lines = source.split("\n")
	const at = lines.indexOf(`public sealed record ${name}`)
	return lines.slice(at, lines.indexOf("}", at) + 1).join("\n")
}

const STRING = { type: "string" }
const INTEGER = { type: "integer" }

describe("csTopLevel: string enums", () => {
	const values = ["red", "blue-green", "blue_green", "", 'x"y']

	it("declares one member per value: a repeat is …2, the empty string Empty", () => {
		expect(declared(top("Color", { Color: { enum: values, type: "string" } }).text)).toEqual(
			stringEnum("Color", "Red", "BlueGreen", "BlueGreen2", "Empty", "XY"),
		)
	})

	it("reads and writes each exact wire name through csString, refusing any other string and any other token", () => {
		const { text } = top("Color", { Color: { enum: values, type: "string" } })
		expect({
			arms: arms(text, "Color"),
			other: text.includes("var other => throw new JsonException("),
			token: text.includes("JsonTokenType.String"),
		}).toEqual({
			arms: {
				read: [
					'"red" => Red',
					'"blue-green" => BlueGreen',
					'"blue_green" => BlueGreen2',
					'"" => Empty',
					String.raw`"x\"y" => XY`,
				],
				write: [
					'Red => "red"',
					'BlueGreen => "blue-green"',
					'BlueGreen2 => "blue_green"',
					'Empty => ""',
					String.raw`XY => "x\"y"`,
				],
			},
			other: true,
			token: true,
		})
	})

	it("declares a union of const strings alone as a string enum", () => {
		const { text } = top("Lits", { Lits: { oneOf: [{ const: "x" }, { const: "Y" }] } })
		expect({ arms: arms(text, "Lits").read, declared: declared(text) }).toEqual({
			arms: ['"x" => X', '"Y" => Y'],
			declared: stringEnum("Lits", "X", "Y"),
		})
	})
})

describe("csTopLevel: integer enums", () => {
	it("declares L<n> and Neg<n> members through the runtime's IntEnumConverter<T>, with no converter of its own", () => {
		expect(declared(top("Level", { Level: { enum: [-1, 0, 2], type: "integer" } }).text)).toEqual({
			converters: [],
			type: [
				"[JsonConverter(typeof(IntEnumConverter<Level>))]",
				"public enum Level",
				"{",
				"    Neg1 = -1,",
				"    L0 = 0,",
				"    L2 = 2,",
				"}",
			].join("\n"),
		})
	})
})

const DOG = { properties: { bark: { type: "boolean" }, petType: STRING }, required: ["petType"], type: "object" }
const CAT = { properties: { lives: INTEGER, petType: STRING }, required: ["petType"], type: "object" }
const constant = (schema: Json, value: string): Json => ({
	...schema,
	properties: { ...(schema.properties as Json), petType: { const: value } },
})

/** Pet by its mapping, and Pet by its variants' const discriminator: one declaration. */
const PETS = {
	const: {
		Cat: constant(CAT, "cat"),
		Dog: constant(DOG, "dog"),
		Pet: { discriminator: { propertyName: "petType" }, oneOf: [ref("Dog"), ref("Cat")] },
	},
	mapping: {
		Cat: CAT,
		Dog: DOG,
		Pet: {
			discriminator: {
				mapping: { cat: "#/components/schemas/Cat", dog: "#/components/schemas/Dog" },
				propertyName: "petType",
			},
			oneOf: [ref("Dog"), ref("Cat")],
		},
	},
}

describe("csTopLevel: discriminated unions (Fb7)", () => {
	it.each(Object.entries(PETS))(
		"declares Pet by its %s as a record of variants and Raw, in order of their first value",
		(_, components) => {
			const { decls, text } = top("Pet", components)
			expect({
				declared: declared(text),
				decls,
				property: text.includes('TryGetProperty("petType", '),
				union: unionArms(text, "Pet"),
			}).toEqual({
				declared: {
					converters: ["public sealed class PetConverter : JsonConverter<Pet>"],
					type: [
						"[JsonConverter(typeof(PetConverter))]",
						...record(
							"Pet",
							["public Cat? Cat { get; init; }"],
							["public Dog? Dog { get; init; }"],
							["public JsonElement Raw { get; init; }"],
						).type.split("\n"),
					].join("\n"),
				},
				decls: {},
				property: true,
				union: { read: ['"cat" => Cat', '"dog" => Dog'], write: ["Cat", "Dog"] },
			})
		},
	)
})

/** Components C# has no declaration for (no namespace-level alias), beside the record that uses them. */
const ALIASES = {
	A: { properties: { a: STRING }, type: "object" },
	AB: { oneOf: [ref("A"), ref("B")] },
	Attrs: { additionalProperties: INTEGER, type: "object" },
	B: { properties: { b: STRING }, type: "object" },
	Id: STRING,
	Loop: { items: ref("Loop"), type: "array" },
	Role: { const: "admin" },
	Tags: { items: STRING, type: "array" },
	User: { properties: { ab: ref("AB"), tags: ref("Tags") }, type: "object" },
}

describe("csTopLevel: components C# declares nothing for", () => {
	it("declares no type for a non-discriminated union, a scalar, an array, a map or a const component", () => {
		const source = generateCSharpSdk(doc(ALIASES)).files["Types.cs"] as string
		expect({ names: declaredNames(source), user: declarationIn(source, "User") }).toEqual({
			names: ["A", "B", "User"],
			user: record(
				"User",
				property("ab", "JsonElement Ab", "[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]"),
				property("tags", "IReadOnlyList<string>? Tags"),
			).type,
		})
	})

	it.each([
		["AB", "JsonElement"],
		["Attrs", "IReadOnlyDictionary<string, long>"],
		["Id", "string"],
		["Role", "string"],
		["Tags", "IReadOnlyList<string>"],
	])("types a ref to %s as that component's use type: %s", (name, type) => {
		const ctx = { ...context(ALIASES), fieldName: "v", parentName: "T" }
		expect({ decls: [...ctx.decls.keys()], type: csTypeOf(schemaToIR(ref(name)), ctx) }).toEqual({ decls: [], type })
	})

	it("ends a cycle through an alias at the depth cap as JsonElement", () => {
		const ctx = { ...context(ALIASES), fieldName: "v", parentName: "T" }
		expect(csTypeOf(schemaToIR(ref("Loop")), ctx)).toMatch(/^(?:IReadOnlyList<)+JsonElement>+$/)
	})
})

describe("csTopLevel: allOf is one record", () => {
	it.each<{ components: Record<string, Json>; expected: Declared; title: string }>([
		{
			components: {
				Base: { properties: { x: STRING }, type: "object" },
				Ext: { allOf: [ref("Base"), { properties: { y: STRING }, type: "object" }] },
			},
			expected: record("Ext", property("x", "string? X"), property("y", "string? Y")),
			title: "an allOf of a ref and an object holds the ref's fields and its own",
		},
		{
			components: {
				Base: { properties: { id: STRING }, required: ["id"], type: "object" },
				Ext: { allOf: [ref("Base"), { properties: { id: INTEGER, z: { type: "boolean" } } }] },
			},
			expected: record("Ext", property("id", "required string Id"), property("z", "bool? Z")),
			title: "on a repeated key the first part wins",
		},
		{
			components: {
				Ext: {
					allOf: [
						{ properties: { a: STRING }, required: ["a"] },
						{ properties: { b: INTEGER }, required: ["b"] },
					],
				},
			},
			expected: record("Ext", property("a", "required string A"), property("b", "required long B")),
			title: "an allOf of two inline objects holds both",
		},
	])("$title", ({ components, expected }) => {
		const { decls, text } = top("Ext", components)
		expect({ declared: declared(text), decls }).toEqual({ declared: expected, decls: {} })
	})
})

describe("names: the one type scope (H52)", () => {
	const TAKEN = ["AcmeClient", "ClientConfig", "JsonElement", "NotFoundException", "String", "Task"]

	it("declares a component named like a runtime, BCL or client type as <Name>Model, and a ref follows it", () => {
		const keys = "abcdef"
		const schemas = {
			...Object.fromEntries(TAKEN.map((name) => [name, { properties: { id: STRING }, type: "object" }])),
			User: { properties: Object.fromEntries(TAKEN.map((name, i) => [keys[i], ref(name)])), type: "object" },
		}
		const source = generateCSharpSdk(doc(schemas), { packageId: "Acme.Sdk", rootNamespace: "Acme" }).files[
			"Types.cs"
		] as string
		expect({ names: declaredNames(source), user: declarationIn(source, "User") }).toEqual({
			names: [...TAKEN.map((name) => `${name}Model`), "User"],
			user: record(
				"User",
				...TAKEN.map((name, i) => property(keys[i] as string, `${name}Model? ${(keys[i] as string).toUpperCase()}`)),
			).type,
		})
	})
})

describe("names: a hoist never merges (H52)", () => {
	it("never merges two inline objects that hoist to one name: the later claim is …2", () => {
		const components = {
			User: { properties: { profile_settings: { properties: { theme: STRING }, type: "object" } }, type: "object" },
			UserProfile: { properties: { settings: { properties: { color: STRING }, type: "object" } }, type: "object" },
		}
		const ctx = context(components)
		const texts = Object.entries(components).map(([name, schema]) =>
			declared(csTopLevel(name, schemaToIR(schema), ctx)),
		)
		expect({ decls: Object.fromEntries([...ctx.decls].map(([n, t]) => [n, declared(t)])), texts }).toEqual({
			decls: {
				UserProfileSettings: record("UserProfileSettings", property("theme", "string? Theme")),
				UserProfileSettings2: record("UserProfileSettings2", property("color", "string? Color")),
			},
			texts: [
				record("User", property("profile_settings", "UserProfileSettings? ProfileSettings")),
				record("UserProfile", property("settings", "UserProfileSettings2? Settings")),
			],
		})
	})

	it("never merges an inline object with a component of its hoisted name, nor with a reserved name: the hoist takes …2", () => {
		const components = {
			Json: { properties: { element: { properties: { k: STRING }, type: "object" } }, type: "object" },
			User: { properties: { profile_settings: { properties: { theme: STRING }, type: "object" } }, type: "object" },
			UserProfileSettings: { properties: { id: STRING }, type: "object" },
		}
		const declaredTop = (name: string) => {
			const { decls, text } = top(name, components)
			return { declared: declared(text), decls }
		}
		expect([declaredTop("User"), declaredTop("Json")]).toEqual([
			{
				declared: record("User", property("profile_settings", "UserProfileSettings2? ProfileSettings")),
				decls: { UserProfileSettings2: record("UserProfileSettings2", property("theme", "string? Theme")) },
			},
			{
				declared: record("Json", property("element", "JsonElement2? Element")),
				decls: { JsonElement2: record("JsonElement2", property("k", "string? K")) },
			},
		])
	})
})
