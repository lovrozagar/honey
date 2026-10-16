/**
 * Python declarations (contract 28 §4.5, §7.3): a component is a total `TypedDict`, a required key a bare `T` and an
 * optional one `NotRequired[T]`; keys no class body can spell give the functional form; `allOf` inherits refs and
 * merges inline objects; any other component is a `TypeAlias` of one quoted string; and a claimed name follows
 * every reference to it.
 */
import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import { schemaToIR } from "../../ir/schema.ts"
import { types } from "./__fixtures__/documents-specs.ts"
import { generatePythonSdk } from "./sdk.ts"
import { pyTopLevel, pyTypeContext } from "./types.ts"

type Json = Record<string, unknown>

/** A top-level row: component `name` declares `text`, hoisting `decls` (name to text). */
type TopRow = {
	title: string
	name: string
	/** defaults to `components[name]` */
	schema?: Json
	components?: Record<string, Json>
	text: string
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
	components ? pyTypeContext(toIR(doc(components))) : pyTypeContext()

/** A component's declaration text and every declaration it hoisted. */
function top({ name, schema, components }: Pick<TopRow, "components" | "name" | "schema">) {
	const ctx = context(components)
	const text = pyTopLevel(name, schemaToIR(schema ?? components?.[name]), ctx)
	return { decls: Object.fromEntries(ctx.decls), text }
}

/** What a top-level row expects: its text and exactly the declarations it hoists. */
const declaredAs = (row: TopRow) => ({ decls: row.decls ?? {}, text: row.text })

/** A class-form TypedDict over `bases`, one 4-space-indented key per line, or `pass` with none. */
const dict = (name: string, keys: string[], bases = "TypedDict") =>
	[`class ${name}(${bases}):`, ...(keys.length > 0 ? keys : ["pass"]).map((key) => `    ${key}`)].join("\n")

/** A functional-form TypedDict: keys through pyString, every value one quoted string (§4.5). */
const functional = (name: string, entries: [key: string, value: string][]) =>
	[
		`${name} = TypedDict(`,
		`    "${name}",`,
		`    {${entries.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(", ")}},`,
		")",
	].join("\n")

const STRING = { type: "string" }
const INTEGER = { type: "integer" }

describe("pyTopLevel: required and optional keys of a total TypedDict", () => {
	it.each<TopRow>([
		/* V0BUG: v0 emitted total=False on every TypedDict (codegen-python.ts:154,162), typing required keys as optional; a total TypedDict keeps a required key bare */
		// v0: cbf80e6e36
		{
			name: "X",
			schema: { properties: { id: STRING }, required: ["id"] },
			text: dict("X", ["id: str"]),
			title: "a required key is a bare T in a total TypedDict, with no total=False",
		},
		// v0: e74518d440
		{
			name: "X",
			schema: { properties: { name: STRING } },
			text: dict("X", ["name: NotRequired[str]"]),
			title: "an optional key is NotRequired[T]",
		},
		{
			name: "X",
			schema: {
				properties: { a: { type: ["string", "null"] }, b: { nullable: true, type: "string" } },
				required: ["b"],
			},
			text: dict("X", ["a: NotRequired[str | None]", "b: str | None"]),
			title: "an optional nullable key is NotRequired[T | None], a required nullable one T | None",
		},
		// v0: 711d21e7a5
		{
			name: "X",
			schema: { additionalProperties: false, properties: { id: STRING }, required: ["id"] },
			text: dict("X", ["id: str"]),
			title: "additionalProperties: false keeps the declared keys only",
		},
		{
			name: "Empty",
			schema: { additionalProperties: false, type: "object" },
			text: dict("Empty", []),
			title: "a closed empty object is a TypedDict holding pass",
		},
		{
			components: { Comment: { properties: { parent: ref("Comment") }, type: "object" } },
			name: "Comment",
			text: dict("Comment", ["parent: NotRequired[Comment]"]),
			title: "a recursive key refers to its own class unquoted: annotations are lazy",
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("pyTopLevel: nested objects hoist", () => {
	// v0: 90d18a0b08
	it("hoists a nested object as <Parent><Field>, its keys in code-unit order at every depth", () => {
		const schema = {
			properties: { meta: { properties: { z: { type: "boolean" }, a: STRING }, required: ["a", "z"] } },
			required: ["meta"],
		}
		expect(top({ name: "T", schema })).toEqual({
			decls: { TMeta: dict("TMeta", ["a: str", "z: bool"]) },
			text: dict("T", ["meta: TMeta"]),
		})
	})

	it("never merges two inline objects that hoist to one name: the later claim is …2", () => {
		const components = {
			User: { properties: { profile_settings: { properties: { theme: STRING }, type: "object" } }, type: "object" },
			UserProfile: { properties: { settings: { properties: { color: STRING }, type: "object" } }, type: "object" },
		}
		const ctx = context(components)
		const texts = Object.entries(components).map(([name, schema]) => pyTopLevel(name, schemaToIR(schema), ctx))
		expect({ decls: Object.fromEntries(ctx.decls), texts }).toEqual({
			decls: {
				UserProfileSettings: dict("UserProfileSettings", ["theme: NotRequired[str]"]),
				UserProfileSettings2: dict("UserProfileSettings2", ["color: NotRequired[str]"]),
			},
			texts: [
				dict("User", ["profile_settings: NotRequired[UserProfileSettings]"]),
				dict("UserProfile", ["settings: NotRequired[UserProfileSettings2]"]),
			],
		})
	})
})

describe("pyTopLevel: keys a class body cannot spell give the functional form", () => {
	it.each<TopRow>([
		// v0: e771f861e6
		{
			name: "X",
			schema: { properties: { "content-type": STRING }, required: ["content-type"] },
			text: functional("X", [["content-type", "str"]]),
			title: "a non-identifier key keeps its spelling in the functional form",
		},
		{
			name: "X",
			schema: { properties: { class: STRING } },
			text: functional("X", [["class", "NotRequired[str]"]]),
			title: "a hard-keyword key gives the functional form",
		},
		{
			name: "Item",
			schema: { properties: { "2fa": { type: "boolean" }, "@type": STRING, class: STRING } },
			text: functional("Item", [
				["2fa", "NotRequired[bool]"],
				["@type", "NotRequired[str]"],
				["class", "NotRequired[str]"],
			]),
			title: "every key of a functional form is one quoted value, in code-unit order",
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("pyTopLevel: allOf inherits refs and merges inline objects", () => {
	it.each<TopRow>([
		// v0: 423dba5709
		{
			name: "X",
			schema: {
				allOf: [
					{ properties: { a: STRING }, required: ["a"] },
					{ properties: { b: INTEGER }, required: ["b"] },
				],
			},
			text: dict("X", ["a: str", "b: int"]),
			title: "an allOf of two inline objects is one TypedDict with both keys",
		},
		{
			components: {
				Base: { properties: { x: STRING }, type: "object" },
				Ext: { allOf: [ref("Base"), { properties: { y: STRING } }] },
			},
			name: "Ext",
			text: dict("Ext", ["y: NotRequired[str]"], "Base"),
			title: "an allOf over a ref inherits the ref's class",
		},
	])("$title", (row) => {
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("pyTopLevel: aliases are typed, as one quoted string", () => {
	// v0: 1f4d973e9f
	it("declares an array component as a typed TypeAlias, and no emitted file of the document uses NewType", () => {
		const files = Object.entries(generatePythonSdk(types()).files)
		expect({
			newType: files.filter(([, text]) => text.includes("NewType")).map(([name]) => name),
			text: top({ name: "Tags", schema: { items: STRING, type: "array" } }).text,
		}).toEqual({ newType: [], text: 'Tags: TypeAlias = "list[str]"' })
	})

	it("declares an enum component as a TypeAlias of its Literal", () => {
		expect(top({ name: "Role", schema: { enum: ["admin", "user"], type: "string" } })).toEqual({
			decls: {},
			text: 'Role: TypeAlias = "Literal[\\"admin\\", \\"user\\"]"',
		})
	})
})

describe("pyTopLevel: claimed names", () => {
	it("declares a component the typing module owns as <Name>Model, and a ref follows it", () => {
		const components = {
			Any: { properties: { v: STRING }, type: "object" },
			User: { properties: { a: ref("Any") }, type: "object" },
		}
		expect(top({ components, name: "User" })).toEqual({ decls: {}, text: dict("User", ["a: NotRequired[AnyModel]"]) })
	})
})
