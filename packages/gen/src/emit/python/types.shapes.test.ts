/**
 * The type shapes the registry documents do not reach (contract 28 §4.5): inline union variants hoisted under
 * `<Parent><Field>Variant<i>` or their discriminator's const, allOf in use position and over a closed ref, the
 * one cycle an allOf cannot inherit through, a rest-only tuple, a typed enum holding null, a ref to no
 * component, and each declaration form's description.
 */
import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import { schemaToIR } from "../../ir/schema.ts"
import { pyTopLevel, pyTypeContext, pyTypeOf } from "./types.ts"

type Json = Record<string, unknown>

const STRING = { type: "string" }
const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` })
const object = (properties: Json, required: string[] = []): Json => ({ properties, required, type: "object" })

/** A context over a document holding `schemas`, or plain names without one. */
const context = (schemas?: Record<string, Json>) =>
	schemas === undefined
		? pyTypeContext()
		: pyTypeContext(
				toIR({
					components: { schemas },
					info: { title: "T", version: "1" },
					openapi: "3.1.0",
					paths: {},
				} as OpenApiDocument),
			)

/** `schema`'s type at `T.v`, every declaration it hoists, and the typing names it spells. */
function use(schema: Json, schemas?: Record<string, Json>) {
	const ctx = { ...context(schemas), fieldName: "v", parentName: "T" }
	const type = pyTypeOf(schemaToIR(schema), ctx)
	return { decls: Object.fromEntries(ctx.decls), type, typing: [...ctx.typing].sort() }
}

/** Component `name`'s declaration (described as `doc`) and what it hoists. */
function top(name: string, schemas: Record<string, Json>, doc?: string) {
	const ctx = context(schemas)
	return { decls: Object.fromEntries(ctx.decls), text: pyTopLevel(name, schemaToIR(schemas[name]), ctx, doc) }
}

describe("pyTypeOf: inline union variants", () => {
	it("hoists each inline object variant as <Parent><Field>Variant<i>, a ref or scalar staying a member", () => {
		const schema = { oneOf: [object({ a: STRING }), STRING, object({ b: { type: "integer" } }, ["b"])] }
		expect(use(schema)).toEqual({
			decls: {
				TVVariant0: "class TVVariant0(TypedDict):\n    a: NotRequired[str]",
				TVVariant2: "class TVVariant2(TypedDict):\n    b: int",
			},
			type: "TVVariant0 | str | TVVariant2",
			/* one module: what a hoisted declaration spells is imported beside the annotation */
			typing: ["NotRequired", "TypedDict"],
		})
	})

	it("names a discriminated variant by its const, and one without a const by its index", () => {
		const schema = {
			discriminator: { propertyName: "kind" },
			oneOf: [object({ kind: { const: "dog" } }, ["kind"]), object({ kind: STRING }, ["kind"])],
		}
		expect(use(schema)).toMatchObject({ type: "TVDog | TVVariant1" })
	})
})

describe("pyTypeOf: allOf in use position", () => {
	it("is its one part, an inline merge hoisted as one TypedDict, or Any when nothing inherits", () => {
		const merged = { allOf: [object({ a: STRING }), object({ b: STRING })] }
		expect([use({ allOf: [STRING] }), use(merged)]).toEqual([
			{ decls: {}, type: "str", typing: [] },
			{
				decls: { TV: "class TV(TypedDict):\n    a: NotRequired[str]\n    b: NotRequired[str]" },
				type: "TV",
				typing: ["NotRequired", "TypedDict"],
			},
		])
	})
})

describe("pyTopLevel: allOf over refs", () => {
	it("inherits a closed empty object", () => {
		const schemas = {
			Closed: { additionalProperties: false, type: "object" },
			X: { allOf: [ref("Closed"), object({ y: STRING })] },
		}
		expect(top("X", schemas).text).toBe("class X(Closed):\n    y: NotRequired[str]")
	})

	it("declares an allOf that would inherit from itself through another as Any", () => {
		const schemas = {
			A: { allOf: [ref("B"), object({ a: STRING })] },
			B: { allOf: [ref("A"), object({ b: STRING })] },
		}
		expect(top("A", schemas).text).toBe('A: TypeAlias = "Any"')
	})
})

describe("pyTypeOf: tuples, enums and refs at the edges", () => {
	it("types a tuple of only a rest as tuple[R, ...]", () => {
		expect(use({ items: STRING, prefixItems: [], type: "array" }).type).toBe("tuple[str, ...]")
	})

	it("types a typed enum holding null as its Literal, then None", () => {
		expect(use({ enum: ["a", null], type: ["string", "null"] })).toEqual({
			decls: {},
			type: 'Literal["a"] | None',
			typing: ["Literal"],
		})
	})

	it("reads a ref to no component as Any, and one to a component by its name", () => {
		expect([use(ref("Missing"), { X: object({ id: STRING }) }), use(ref("X"), { X: object({ id: STRING }) })]).toEqual([
			{ decls: {}, type: "Any", typing: ["Any"] },
			{ decls: {}, type: "X", typing: [] },
		])
	})
})

describe("pyTopLevel: a component's description", () => {
	it("is a class docstring, one line or several, then a blank line", () => {
		const schemas = { X: object({ id: STRING }) }
		expect([top("X", schemas, 'A "thing".').text, top("X", schemas, "A thing.\n\nMore.").text]).toEqual([
			'class X(TypedDict):\n    """A \\"thing\\"."""\n\n    id: NotRequired[str]',
			'class X(TypedDict):\n    """A thing.\n\n    More.\n    """\n\n    id: NotRequired[str]',
		])
	})

	it("is comment lines above a functional TypedDict and above an alias", () => {
		const schemas = { Tags: { items: STRING, type: "array" }, X: object({ "a-b": STRING }) }
		expect([top("X", schemas, "Keys.").text, top("Tags", schemas, "Tags.\nMany.").text]).toEqual([
			'# Keys.\nX = TypedDict(\n    "X",\n    {"a-b": "NotRequired[str]"},\n)',
			'# Tags.\n# Many.\nTags: TypeAlias = "list[str]"',
		])
	})
})
