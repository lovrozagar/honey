/**
 * The C# type shapes beyond the writers' legs (contract 45 §4.5, Fb7): how a discriminated union selects each
 * variant without a mapping (a variant's const or enum property, an allOf variant's merged one, else its
 * component's name), an inline object variant hoisted as `<Union><Value>`, a value two variants claim kept by the
 * first, a variant no value selects named by its place; an allOf over another allOf flattened into one record; and
 * a ref to a component the document lacks typed as any JSON value.
 */
import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import { schemaToIR } from "../../ir/schema.ts"
import { csTopLevel, csTypeContext, csTypeOf } from "./types.ts"

type Json = Record<string, unknown>

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` })
const STRING = { type: "string" }
const object = (properties: Json): Json => ({ properties, type: "object" })

/** A context over these components. */
const context = (schemas: Record<string, Json>) =>
	csTypeContext(
		toIR({
			components: { schemas },
			info: { title: "Shapes", version: "1" },
			openapi: "3.1.0",
			paths: {},
		} as OpenApiDocument),
	)

/** The variants of `U`: each selected another way, a scalar with no property, a value taken twice, one with none. */
const UNION = {
	A: object({ kind: { const: "a" } }),
	A2: object({ kind: { const: "a" } }),
	B: object({ kind: { enum: ["b1", "b2"], type: "string" } }),
	Base: object({ kind: { const: "d" } }),
	C: object({ x: STRING }),
	D: { allOf: [ref("Base"), object({ y: STRING })] },
	U: {
		discriminator: { propertyName: "kind" },
		oneOf: [
			ref("A"),
			ref("B"),
			ref("C"),
			ref("D"),
			object({ kind: { const: "e" }, n: { type: "integer" } }),
			STRING,
			ref("A2"),
			object({ m: STRING }),
		],
	},
}

describe("csTopLevel: how a discriminated union selects its variants (Fb7)", () => {
	const ctx = context(UNION)
	const text = csTopLevel("U", schemaToIR(UNION.U), ctx)
	const lines = text.split("\n")

	it("names each variant after its first value, a variant no value selects after its place, in code-unit order of the value", () => {
		expect(lines.filter((line) => /^ {4}public \S+\? \w+ \{ get; init; \}$/.test(line))).toEqual([
			"    public A2? Variant6 { get; init; }",
			"    public UVariant7? Variant7 { get; init; }",
			"    public C? C { get; init; }",
			"    public A? A { get; init; }",
			"    public B? B1 { get; init; }",
			"    public D? D { get; init; }",
			"    public UE? E { get; init; }",
		])
	})

	it("reads each value into its variant: a const, every enum value, an allOf's merged const, else the component's name", () => {
		expect(
			lines.flatMap((line) => /^ {12}("\w+") => new U \{ (\w+) = /.exec(line)?.slice(1, 3).join(" => ") ?? []),
		).toEqual(['"C" => C', '"a" => A', '"b1" => B1', '"b2" => B1', '"d" => D', '"e" => E'])
	})

	it("writes whichever variant is set, in the same order, then Raw", () => {
		expect(lines.flatMap((line) => /^ {8}(?:else )?if \(value\.(\w+)/.exec(line)?.[1] ?? [])).toEqual([
			"Variant6",
			"Variant7",
			"C",
			"A",
			"B1",
			"D",
			"E",
			"Raw",
		])
	})

	it("hoists each inline object variant as <Union><Value>, or <Union>Variant<i> without a value, and lists every variant type", () => {
		expect({ decls: [...ctx.decls.keys()], serialized: [...ctx.serialized].sort() }).toEqual({
			decls: ["UE", "UVariant7"],
			serialized: ["A", "A2", "B", "C", "D", "UE", "UVariant7"],
		})
	})
})

describe("csTopLevel: an allOf over another allOf", () => {
	it("flattens a ref to an allOf into one record, a part that is no object adding nothing", () => {
		const components = {
			Base: object({ x: STRING }),
			Ext: { allOf: [ref("Base"), object({ y: STRING })] },
			Ext2: { allOf: [ref("Ext"), ref("Name"), object({ z: STRING })] },
			Name: STRING,
		}
		const text = csTopLevel("Ext2", schemaToIR(components.Ext2), context(components))
		expect(text.split("\n").filter((line) => line.includes("{ get; init; }"))).toEqual([
			"    public string? X { get; init; }",
			"    public string? Y { get; init; }",
			"    public string? Z { get; init; }",
		])
	})
})

describe("csTypeOf: a ref to a component the document lacks", () => {
	it("types it as any JSON value, with components and without, declaring nothing", () => {
		const withComponents = { ...context({ User: object({ id: STRING }) }), fieldName: "v", parentName: "T" }
		const without = { ...csTypeContext(), fieldName: "v", parentName: "T" }
		expect([
			csTypeOf(schemaToIR(ref("Missing")), withComponents),
			csTypeOf(schemaToIR(ref("User")), without),
			[...withComponents.decls.keys(), ...without.decls.keys()],
		]).toEqual(["JsonElement", "JsonElement", []])
	})
})
