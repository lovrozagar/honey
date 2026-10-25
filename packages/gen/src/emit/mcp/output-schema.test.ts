/**
 * A tool's outputSchema (bit 18 phase d, D1): an object answer as it is, any other JSON answer wrapped `{result}`, an
 * answer with declared response headers wrapped `{result, headers}` (Q11), each header a string under its lower-case
 * name, and no outputSchema without a JSON success schema.
 */
import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import { sdkModel } from "../../ir/sdk-model.ts"
import { outputOf } from "./output-schema.ts"

const STR = { type: "string" }

/** The outputSchema of one GET answering `responses`. */
function output(responses: Record<string, unknown>, components: Record<string, unknown> = {}) {
	const ir = toIR(
		{
			components: { schemas: components },
			info: { title: "O", version: "1" },
			openapi: "3.1.0",
			paths: { "/o": { get: { operationId: "o.get", responses } } },
		} as unknown as OpenApiDocument,
		{ deriveOperationIds: true },
	)
	return outputOf(sdkModel(ir).ops[0] as NonNullable<ReturnType<typeof sdkModel>["ops"][number]>, ir)
}

/** A 200 answering `schema` as `type`, declaring `headers`. */
const answering = (schema: unknown, type = "application/json", headers?: Record<string, unknown>) => ({
	200: { content: { [type]: { schema } }, description: "ok", ...(headers ? { headers } : {}) },
})

describe("a tool's outputSchema (phase d)", () => {
	it("is an object answer's schema as it is, a ref inlined", () => {
		const item = { properties: { id: STR }, required: ["id"], type: "object" }
		expect(output(answering({ $ref: "#/components/schemas/Item" }), { Item: item })).toEqual({
			outputSchema: { properties: { id: STR }, required: ["id"], type: "object" },
		})
	})

	it.each([
		["an array", { items: STR, type: "array" }, { items: STR, type: "array" }],
		["a string", STR, STR],
		[
			"a nullable object",
			{ properties: {}, type: ["object", "null"] },
			{ anyOf: [{ properties: {}, type: "object" }, { type: "null" }] },
		],
	])("wraps %s as {result}, so structuredContent is an object", (_, schema, result) => {
		expect(output(answering(schema))).toEqual({
			outputSchema: { properties: { result }, required: ["result"], type: "object" },
			wrap: true,
		})
	})

	it("wraps an answer with declared headers as {result, headers}, each a string by its lower-case name", () => {
		/* parsed from text, so __proto__ is an own key as it is in a parsed document */
		const declared = JSON.parse(
			'{"X-Total":{"schema":{"type":"integer"}},"__proto__":{"schema":{"type":"string"}},"ETag":{"schema":{"type":"string"}}}',
		) as Record<string, unknown>
		const out = output(answering({ properties: {}, type: "object" }, "application/json", declared))
		const headers = JSON.parse(
			'{"__proto__":{"type":"string"},"etag":{"type":"string"},"x-total":{"type":"string"}}',
		) as object
		const listed = (out?.outputSchema.properties as { headers?: { properties?: object } } | undefined)?.headers
		expect([out, Object.keys(listed?.properties ?? {})]).toEqual([
			{
				outputSchema: {
					properties: { headers: { properties: headers, type: "object" }, result: { properties: {}, type: "object" } },
					required: ["result"],
					type: "object",
				},
				wrap: true,
			},
			["__proto__", "etag", "x-total"],
		])
	})

	it("is none for an answer that is not JSON, has no schema, or has no body", () => {
		expect([
			output(answering(STR, "text/plain")),
			output(answering({ format: "binary", type: "string" }, "image/png")),
			output({ 200: { content: { "application/json": {} }, description: "ok" } }),
			output({ 204: { description: "none" } }),
		]).toEqual([undefined, undefined, undefined, undefined])
	})
})
