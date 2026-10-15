import { type } from "arktype"
import * as v from "valibot"
import * as y from "yup"
import { JSONSchema, Schema } from "effect"
import { describe, expect, it, vi } from "vitest"
import * as z from "zod"
import { type ConversionIssue, jsonSchemaOf } from "./to-json-schema.ts"

/** A report that records each issue it hears. */
function recording() {
	const issues: ConversionIssue[] = []
	return { issues, report: (issue: ConversionIssue) => void issues.push(issue) }
}

/** A Standard Schema of `vendor` with nothing else: no JSON Schema to give. */
const bare = (vendor: string) => ({ "~standard": { validate: (value: unknown) => ({ value }), vendor, version: 1 } })

describe("jsonSchemaOf: what is not a schema", () => {
	it("hands a JSON Schema back as given, and anything else that is no object as {}", () => {
		const given = { properties: { id: { type: "string" } }, type: "object" }
		expect([given, "text", null, [given], () => given].map((schema) => jsonSchemaOf(schema, "output"))).toEqual([
			given,
			{},
			{},
			{},
			{},
		])
	})
})

describe("jsonSchemaOf: Standard JSON Schema first", () => {
	// v0: 547a1815bc
	// v0: 93d8abd988
	it("converts a zod schema through its own Standard JSON Schema, Date and BigInt as they cross the wire", () => {
		const schema = z.object({ at: z.date(), big: z.bigint().optional(), name: z.string().min(2) })
		expect(jsonSchemaOf(schema, "output")).toEqual({
			additionalProperties: false,
			properties: {
				at: { format: "date-time", type: "string" },
				big: { format: "int64", type: "integer" },
				name: { minLength: 2, type: "string" },
			},
			required: ["at", "name"],
			type: "object",
		})
	})

	it("reads input and output apart: a default is optional going in, always there coming out", () => {
		const schema = z.object({ page: z.number().default(1) })
		expect([jsonSchemaOf(schema, "input").required, jsonSchemaOf(schema, "output").required]).toEqual([
			undefined,
			["page"],
		])
	})

	// v0: 839d43975f
	// v0: 92e1a4f8fa
	// v0: adad9cbadc
	it("converts arktype and any other vendor that publishes Standard JSON Schema", () => {
		const own = {
			"~standard": {
				jsonSchema: { input: () => ({ type: "number" }), output: () => ({ type: "string" }) },
				validate: (value: unknown) => ({ value }),
				vendor: "other",
				version: 1,
			},
		}
		expect([
			jsonSchemaOf(type({ id: "string" }), "output"),
			jsonSchemaOf(own, "input"),
			jsonSchemaOf(own, "output"),
		]).toEqual([
			{ properties: { id: { type: "string" } }, required: ["id"], type: "object" },
			{ type: "number" },
			{ type: "string" },
		])
	})
})

describe("jsonSchemaOf: the vendors that publish none, walked", () => {
	it("walks valibot and yup, and reads an older ArkType through its instance converter", () => {
		const olderArk = {
			"~standard": { validate: (value: unknown) => ({ value }), vendor: "arktype", version: 1 },
			toJsonSchema: () => ({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "string" }),
		}
		expect([
			jsonSchemaOf(v.object({ id: v.string() }), "output"),
			jsonSchemaOf(y.object({ id: y.string().required() }), "output"),
			jsonSchemaOf(olderArk, "output"),
		]).toEqual([
			{ properties: { id: { type: "string" } }, required: ["id"], type: "object" },
			{ properties: { id: { type: "string" } }, required: ["id"], type: "object" },
			{ type: "string" },
		])
	})
})

describe("jsonSchemaOf: what it cannot express, reported once", () => {
	// v0: 855fbc6198
	it("degrades only a node JSON Schema has no word for, and names it", () => {
		const { issues, report } = recording()
		const schema = z.object({ count: z.number(), data: z.custom<{ raw: unknown }>(), id: z.string() })
		expect(jsonSchemaOf(schema, "output", { report })).toEqual({
			additionalProperties: false,
			properties: { count: { type: "number" }, data: {}, id: { type: "string" } },
			required: ["count", "data", "id"],
			type: "object",
		})
		expect(issues).toEqual([{ io: "output", kind: "degraded", nodes: ["custom"], vendor: "zod" }])
	})

	it("answers {} for a vendor it has no converter for, and for one whose converter throws", () => {
		const { issues, report } = recording()
		const throwing = {
			"~standard": {
				jsonSchema: {
					input: () => ({}),
					output: () => {
						throw new Error("cannot")
					},
				},
				validate: (value: unknown) => ({ value }),
				vendor: "other",
				version: 1,
			},
		}
		expect([jsonSchemaOf(bare("nobody"), "output", { report }), jsonSchemaOf(throwing, "output", { report })]).toEqual([
			{},
			{},
		])
		expect(issues).toEqual([
			{ io: "output", kind: "unsupported", vendor: "nobody" },
			{ error: new Error("cannot"), io: "output", kind: "failed", vendor: "other" },
		])
	})

	it("reports nothing without a report, and never writes to the console", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		expect(jsonSchemaOf(bare("nobody"), "output")).toEqual({})
		expect(warn).not.toHaveBeenCalled()
		warn.mockRestore()
	})
})

describe("jsonSchemaOf: Effect, through the converter its caller passes", () => {
	const effect = Schema.standardSchemaV1(Schema.Struct({ a: Schema.String }))

	it("uses JSONSchema.make when given it, and answers {} reported once without it", () => {
		const { issues, report } = recording()
		expect([
			jsonSchemaOf(effect, "output", { converters: { effect: JSONSchema.make }, report }),
			jsonSchemaOf(effect, "output", { report }),
		]).toEqual([
			{ additionalProperties: false, properties: { a: { type: "string" } }, required: ["a"], type: "object" },
			{},
		])
		expect(issues).toEqual([{ io: "output", kind: "unsupported", vendor: "effect" }])
	})
})

describe("jsonSchemaOf: the keywords a converter adds", () => {
	// v0: 6896219ca5
	it("drops $schema wherever a schema sits, and leaves a payload such as an example as it is", () => {
		const own = {
			"~standard": {
				jsonSchema: {
					input: () => ({}),
					output: () => ({
						$schema: "https://json-schema.org/draft/2020-12/schema",
						$defs: { Id: { $schema: "drop", type: "string" } },
						anyOf: [{ $schema: "drop", type: "object" }],
						example: { $schema: "keep", nested: { $schema: "keep-too" } },
						items: false,
						properties: { id: { $schema: "drop", type: "string" } },
						type: "object",
					}),
				},
				validate: (value: unknown) => ({ value }),
				vendor: "other",
				version: 1,
			},
		}
		expect(jsonSchemaOf(own, "output")).toEqual({
			$defs: { Id: { type: "string" } },
			anyOf: [{ type: "object" }],
			example: { $schema: "keep", nested: { $schema: "keep-too" } },
			items: false,
			properties: { id: { type: "string" } },
			type: "object",
		})
	})
})
