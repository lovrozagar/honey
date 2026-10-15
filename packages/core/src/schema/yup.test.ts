import { describe, expect, it } from "vitest"
import * as y from "yup"
import { yupJsonSchema } from "./yup.ts"

describe("yupJsonSchema: from the schema's own description", () => {
	it("scalars, a date on the wire, objects with their required keys, arrays, tuples and nullables", () => {
		expect(
			yupJsonSchema(
				y.object({
					at: y.date().required(),
					list: y.array(y.string().required()).required(),
					name: y.string().required(),
					note: y.string().nullable(),
					ok: y.boolean().required(),
					pair: y.tuple([y.string().required(), y.number().required()]).required(),
				}),
			),
		).toEqual({
			properties: {
				at: { format: "date-time", type: "string" },
				list: { items: { type: "string" }, type: "array" },
				name: { type: "string" },
				note: { anyOf: [{ type: "string" }, { type: "null" }] },
				ok: { type: "boolean" },
				pair: {
					items: false,
					maxItems: 2,
					minItems: 2,
					prefixItems: [{ type: "string" }, { type: "number" }],
					type: "array",
				},
			},
			required: ["at", "list", "name", "ok", "pair"],
			type: "object",
		})
	})

	it("a oneOf is an enum, an object or array says only what it knows, and anything else is unconstrained", () => {
		expect([
			yupJsonSchema(y.mixed().oneOf(["a", "b"])),
			yupJsonSchema(y.object({})),
			yupJsonSchema(y.mixed()),
			yupJsonSchema(y.object({ a: y.string() })),
			yupJsonSchema(y.array()),
			yupJsonSchema(y.lazy(() => y.string())),
			yupJsonSchema({ notYup: true }),
		]).toEqual([
			{ enum: ["a", "b"] },
			{ type: "object" },
			{},
			{ properties: { a: { type: "string" } }, type: "object" },
			{ type: "array" },
			{},
			{},
		])
	})
})
