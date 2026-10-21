/**
 * C# records (contract 45 §4.5, §7.3): a component object is a nominal `public sealed record` of `{ get; init; }`
 * properties in code-unit order of the JSON key, each under its `[JsonPropertyName]`, with `required` for a required
 * field, `T?` for an optional one, `Opt<T?>` for an optional nullable one and a bare `JsonElement` for an open value;
 * no property has an initializer; a member name the record synthesizes, or its own name, moves on to `…2`; and a
 * component description is a `/// <summary>` through `csDocLines`.
 */
import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import type { IRSchema } from "../../ir/model.ts"
import { schemaToIR } from "../../ir/schema.ts"
import { types } from "./__fixtures__/documents-specs.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { generateCSharpSdk } from "./sdk.ts"
import { csTopLevel, csTypeContext } from "./types.ts"

type Json = Record<string, unknown>

/** A top-level row: component `name` declares `text`, hoisting the declarations named `decls`. */
type TopRow = {
	title: string
	name: string
	/** defaults to `components[name]` */
	schema?: Json
	components?: Record<string, Json>
	text: string
	decls?: string[]
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

/** A component's declaration text and the names of the declarations it hoisted. */
function top({ name, schema, components }: Pick<TopRow, "components" | "name" | "schema">) {
	const ctx = context(components)
	const text = csTopLevel(name, schemaToIR(schema ?? components?.[name]), ctx)
	return { decls: [...ctx.decls.keys()], text }
}

/** What a top-level row expects: its text and exactly the declarations it hoists. */
const declaredAs = (row: TopRow) => ({ decls: row.decls ?? [], text: row.text })

/** One property: its `[JsonPropertyName]`, its other attributes, then `public <decl> { get; init; }`. */
const property = (key: string, decl: string, ...attributes: string[]) => [
	`[JsonPropertyName(${JSON.stringify(key)})]`,
	...attributes,
	`public ${decl} { get; init; }`,
]

/** A sealed record, one 4-space-indented property per field and a blank line between properties. */
const record = (name: string, ...properties: string[][]) =>
	[
		`public sealed record ${name}`,
		"{",
		...properties.flatMap((lines, i) => [...(i > 0 ? [""] : []), ...lines.map((line) => `    ${line}`)]),
		"}",
	].join("\n")

/** a required nullable member is written even when null */
const NEVER = "[JsonIgnore(Condition = JsonIgnoreCondition.Never)]"
/** an absent tri-state or open value is not written */
const UNSET = "[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]"
/** an optional nullable member: absent, null and a value are three states */
const tri = (key: string, inner: string, name: string) =>
	property(key, `Opt<${inner}> ${name}`, `[JsonConverter(typeof(OptConverter<${inner}>))]`, UNSET)

const STRING = { type: "string" }
const INTEGER = { type: "integer" }

/** `name`'s declaration in an emitted `Types.cs`, with the `///` lines right above it. */
function declarationIn(source: string, name: string): string[] {
	const lines = source.split("\n")
	const at = lines.indexOf(`public sealed record ${name}`)
	let from = at
	while (from > 0 && (lines[from - 1] as string).startsWith("///")) from -= 1
	return lines.slice(from, lines.indexOf("}", at) + 1)
}

/** The `Types.cs` an SDK of these components holds. */
const typesOf = (schemas: Record<string, Json>) => generateCSharpSdk(doc(schemas)).files["Types.cs"] as string

describe("csTopLevel: each field kind", () => {
	it.each<TopRow>([
		{
			name: "X",
			schema: { properties: { id: STRING }, required: ["id"] },
			text: record("X", property("id", "required string Id")),
			title: "a required non-nullable field is required T",
		},
		{
			name: "X",
			schema: { properties: { parent: { type: ["string", "null"] } }, required: ["parent"] },
			text: record("X", property("parent", "required string? Parent", NEVER)),
			title: "a required nullable field is required T?, written even when null",
		},
		{
			name: "X",
			schema: { properties: { size: { type: ["integer", "null"] } }, required: ["size"] },
			text: record("X", property("size", "required long? Size", NEVER)),
			title: "a required nullable value type is required long?, written even when null",
		},
		{
			name: "X",
			schema: {
				properties: { flag: { type: "boolean" }, ratio: { type: "number" }, tags: { items: STRING, type: "array" } },
			},
			text: record(
				"X",
				property("flag", "bool? Flag"),
				property("ratio", "double? Ratio"),
				property("tags", "IReadOnlyList<string>? Tags"),
			),
			title: "an optional field is T?, a value type and a reference type alike, with no ignore attribute",
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("csTopLevel: tri-state, open and nullable-ref fields", () => {
	it.each<TopRow>([
		{
			name: "X",
			schema: { properties: { count: { type: ["integer", "null"] }, note: { type: ["string", "null"] } } },
			text: record("X", tri("count", "long?", "Count"), tri("note", "string?", "Note")),
			title: "an optional nullable field is Opt<T?> through OptConverter<T?>, unwritten when unset",
		},
		{
			name: "X",
			schema: { properties: { extra: {}, mixed: { type: ["string", "number", "null"] } } },
			text: record("X", property("extra", "JsonElement Extra", UNSET), property("mixed", "JsonElement Mixed", UNSET)),
			title: "an optional JsonElement is already tri-state: bare, unwritten when undefined, nullable or not",
		},
		{
			name: "X",
			schema: { properties: { extra: {} }, required: ["extra"] },
			text: record("X", property("extra", "required JsonElement Extra")),
			title: "a required JsonElement is required JsonElement",
		},
		{
			components: {
				Thing: { properties: { parent: { anyOf: [ref("Thing"), { type: "null" }] } }, required: ["parent"] },
			},
			name: "Thing",
			text: record("Thing", property("parent", "required Thing? Parent", NEVER)),
			title: "a required nullable ref is required T?, written even when null",
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("csTopLevel: the types fixture's Thing", () => {
	it("declares every field kind at once, hoisting its inline enums as Thing<Field>", () => {
		const ir = toIR(types() as OpenApiDocument)
		const ctx = csTypeContext(ir)
		const text = csTopLevel("Thing", ir.schemas.Thing as IRSchema, ctx)
		expect({ decls: [...ctx.decls.keys()].sort(), text }).toEqual({
			decls: ["ThingColor", "ThingLevel"],
			text: record(
				"Thing",
				property("attrs", "IReadOnlyDictionary<string, long>? Attrs"),
				property("color", "ThingColor? Color"),
				property("count", "required long Count"),
				property("extra", "JsonElement Extra", UNSET),
				property("id", "required string Id"),
				property("labels", "IReadOnlyDictionary<string, string>? Labels"),
				property("level", "ThingLevel? Level"),
				tri("note", "string?", "Note"),
				property("parent", "required string? Parent", NEVER),
				property("pet", "Pet? Pet"),
				property("ratio", "double? Ratio"),
				property("tags", "IReadOnlyList<string>? Tags"),
				property("x-key", "string? XKey"),
			),
		})
	})
})

describe("csTopLevel: property order and names", () => {
	it.each<TopRow>([
		{
			name: "X",
			schema: { properties: { b: STRING, a: STRING, Z: STRING, "x-key": STRING } },
			text: record(
				"X",
				property("Z", "string? Z"),
				property("a", "string? A"),
				property("b", "string? B"),
				property("x-key", "string? XKey"),
			),
			title: "properties follow the code-unit order of the JSON key, each PascalCase with its wire name kept",
		},
		{
			name: "Status",
			schema: { properties: { status: STRING } },
			text: record("Status", property("status", "string? Status2")),
			title: "a property spelling its record's own name (CS0542) is …2, its wire name kept",
		},
		{
			name: "X",
			schema: { properties: { clone: STRING, equals: STRING, getHashCode: STRING, toString: STRING } },
			text: record(
				"X",
				property("clone", "string? Clone2"),
				property("equals", "string? Equals2"),
				property("getHashCode", "string? GetHashCode2"),
				property("toString", "string? ToString2"),
			),
			title: "a property spelling a member every record has is …2, Clone too (CS8859)",
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("csTopLevel: reserved member names", () => {
	it.each<TopRow>([
		{
			name: "X",
			schema: {
				properties: Object.fromEntries(
					["deconstruct", "equalityContract", "finalize", "getType", "memberwiseClone", "printMembers"].map((k) => [
						k,
						STRING,
					]),
				),
			},
			text: record(
				"X",
				property("deconstruct", "string? Deconstruct"),
				property("equalityContract", "string? EqualityContract2"),
				property("finalize", "string? Finalize"),
				property("getType", "string? GetType2"),
				property("memberwiseClone", "string? MemberwiseClone2"),
				property("printMembers", "string? PrintMembers2"),
			),
			title:
				"every record member a property collides with is reserved; Deconstruct and Finalize, which collide with none, are free",
		},
		{
			name: "X",
			schema: { properties: { "2fa": STRING, "a-b": STRING, a_b: STRING, class: STRING } },
			text: record(
				"X",
				property("2fa", "string? N2fa"),
				property("a-b", "string? AB"),
				property("a_b", "string? AB2"),
				property("class", "string? Class"),
			),
			title: "two keys of one name are …2 in key order; a digit first is N…; a keyword key is a PascalCase name",
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("csTopLevel: refs, hoists and the empty record", () => {
	it.each<TopRow>([
		{
			components: { Comment: { properties: { parent: ref("Comment") }, type: "object" } },
			name: "Comment",
			text: record("Comment", property("parent", "Comment? Parent")),
			title: "a self-referencing field is the record itself, nullable: a reference type needs no box",
		},
		{
			decls: ["TMeta"],
			name: "T",
			schema: { properties: { meta: { properties: { a: STRING }, type: "object" } }, required: ["meta"] },
			text: record("T", property("meta", "required TMeta Meta")),
			title: "a nested inline object hoists as <Parent><Field>",
		},
		{
			name: "Empty",
			schema: { additionalProperties: false, type: "object" },
			text: ["public sealed record Empty", "{", "}"].join("\n"),
			title: "a closed empty object is a record without members: {} on the wire",
		},
		/* honey-a8's ruling (contract 47, after 2a): additionalProperties beside fields is kept as extension data */
		{
			name: "Labels",
			schema: { additionalProperties: STRING, properties: { name: STRING }, type: "object" },
			text: record("Labels", property("name", "string? Name"), [
				"[JsonExtensionData]",
				"public IDictionary<string, JsonElement>? Extra { get; set; }",
			]),
			title: "additionalProperties beside fields keeps every other member as Extra, JsonElement-valued",
		},
		{
			name: "Open",
			schema: { additionalProperties: true, properties: { extra: STRING }, type: "object" },
			text: record("Open", property("extra", "string? Extra"), [
				"[JsonExtensionData]",
				"public IDictionary<string, JsonElement>? Extra2 { get; set; }",
			]),
			title: "the extension data claims its name after the fields: Extra2 beside a field extra",
		},
		{
			name: "Shut",
			schema: { additionalProperties: false, properties: { name: STRING }, type: "object" },
			text: record("Shut", property("name", "string? Name")),
			title: "a closed object with fields keeps no extension data",
		},
		{
			components: { Tags: { items: STRING, type: "array" } },
			name: "X",
			schema: { properties: { tags: ref("Tags") } },
			text: record("X", property("tags", "IReadOnlyList<string>? Tags")),
			title: "a ref to an array component is that component's use type",
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("csTopLevel: no initializers", () => {
	it("writes no property initializer and only { get; init; } properties in any fixture's Types.cs", () => {
		const sources = [FIXTURES.types.document(), FIXTURES.fixtures.document()].map(
			(document) => generateCSharpSdk(document).files["Types.cs"] as string,
		)
		const lines = sources.flatMap((source) => source.split("\n"))
		expect({
			initializers: lines.filter((line) => /\) = | \} = /.test(line)),
			properties: lines.filter((line) => /^ {4}public .*\{ get;/.test(line) && !line.endsWith(" { get; init; }")),
		}).toEqual({ initializers: [], properties: [] })
	})
})

describe("Types.cs: a component description", () => {
	it("is a /// <summary> escaped through csDocLines", () => {
		const source = typesOf({ Lt: { description: "a < b & c > d", properties: { id: STRING }, type: "object" } })
		expect(declarationIn(source, "Lt")).toEqual(
			["/// <summary>a &lt; b &amp; c &gt; d</summary>", record("Lt", property("id", "string? Id"))].flatMap((text) =>
				text.split("\n"),
			),
		)
	})

	it("breaks on U+2028 into two /// lines, so no line terminator ends the comment early", () => {
		const source = typesOf({ Two: { description: "first second", properties: { n: INTEGER }, type: "object" } })
		expect({
			lines: declarationIn(source, "Two").filter((line) => line.startsWith("///")),
			raw: source.includes(" "),
		}).toEqual({
			lines: ["/// <summary>first", "/// second</summary>"],
			raw: false,
		})
	})

	it("writes no /// line for a component without one", () => {
		const source = typesOf({ Bare: { properties: { id: STRING }, type: "object" } })
		expect(declarationIn(source, "Bare")[0]).toBe("public sealed record Bare")
	})
})
