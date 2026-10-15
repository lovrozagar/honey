import { describe, expect, it } from "vitest"
import * as z from "zod"
import { readableStream } from "../input/input.ts"
import { honey } from "../routing/app.ts"
import type { ConversionIssue } from "../schema/to-json-schema.ts"
import { extractSchemas } from "./extract-schemas.ts"

const STRING = { type: "string" }

/** A closed object of one required key, as zod writes an output object. */
function closed(key: string, schema: object) {
	return { additionalProperties: false, properties: { [key]: schema }, required: [key], type: "object" }
}

describe("extractSchemas: each route's schemas as JSON Schema", () => {
	// v0: 736d6435b2
	// v0: 0dfec1738a
	// v0: 9f6ab846cd
	// v0: c87c554a26
	it("keys each route by METHOD /pattern, and a route that declares nothing by an empty object", () => {
		const app = honey<{}>()
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		app.post("/v1/organizations/:orgId").handler((ctx) => ctx.res.text("ok", "ok"))
		expect(extractSchemas(app)).toEqual({ "GET /health": {}, "POST /v1/organizations/:orgId": {} })
	})

	// v0: 379c32b952
	it("converts each input source on its input side, a readableStream() body by the schema it documents", () => {
		const app = honey<{}>()
		app
			.post("/items")
			.input({ json: z.object({ page: z.number().default(1) }), search: z.object({ q: z.string() }) })
			.handler((ctx) => ctx.res.text("ok", "ok"))
		app
			.put("/raw")
			.input({ form: readableStream(z.object({ file: z.string() })) })
			.handler((ctx) => ctx.res.text("ok", "ok"))
		const schemas = extractSchemas(app)
		expect([schemas["POST /items"], schemas["PUT /raw"]]).toEqual([
			{
				input: {
					json: { properties: { page: { default: 1, type: "number" } }, type: "object" },
					search: { properties: { q: STRING }, required: ["q"], type: "object" },
				},
			},
			{ input: { form: { properties: { file: STRING }, required: ["file"], type: "object" } } },
		])
	})
})

describe("extractSchemas: answers and options", () => {
	// v0: a6253d6a8b
	it("converts each answer on its output side, by media type then status", () => {
		const app = honey<{}>()
		app
			.get("/items")
			.output({
				"application/json": { not_found: z.object({ message: z.string() }), ok: z.object({ at: z.date() }) },
				"text/plain": { ok: z.string() },
			})
			.handler((ctx) => ctx.res.text("ok", "ok"))
		expect(extractSchemas(app)["GET /items"]).toEqual({
			output: {
				"application/json": {
					not_found: closed("message", STRING),
					ok: closed("at", { format: "date-time", type: "string" }),
				},
				"text/plain": { ok: STRING },
			},
		})
	})

	it("leaves out a binary body, which names media types and no schema, and passes its options to the conversion", () => {
		const issues: ConversionIssue[] = []
		const nobody = { "~standard": { validate: (value: unknown) => ({ value }), vendor: "nobody", version: 1 as const } }
		const app = honey<{}>()
		app
			.post("/upload")
			.input({ binary: "image/png", search: nobody })
			.handler((ctx) => ctx.res.text("ok", "ok"))
		expect(extractSchemas(app, { report: (issue) => void issues.push(issue) })["POST /upload"]).toEqual({
			input: { search: {} },
		})
		expect(issues).toEqual([{ io: "input", kind: "unsupported", vendor: "nobody" }])
	})
})
