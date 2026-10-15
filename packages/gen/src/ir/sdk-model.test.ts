import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "./build.ts"
import { type IRSchema, irResolver, schemaToIR } from "./model.ts"
import {
	irErrorEnvelope,
	isJsonMedia,
	isTextMedia,
	mediaEssence,
	type SdkOp,
	sdkModel,
	valueCycleSchemas,
} from "./sdk-model.ts"

type Json = Record<string, unknown>

/** The SDK model of one operation `op` at `POST /a/{id}`. */
function one(op: Json, components?: Json): SdkOp {
	const doc = { components, info: { title: "T", version: "1" }, openapi: "3.1.0", paths: { "/a/{id}": { post: op } } }
	return sdkModel(toIR(doc as OpenApiDocument, { deriveOperationIds: true })).ops[0] as SdkOp
}

const ref = (name: string): IRSchema => ({ kind: "ref", name })
const field = (schema: IRSchema): IRSchema => ({ fields: [{ name: "f", required: true, schema }], kind: "object" })
const content = (type: string, schema: Json = { type: "string" }) => ({ content: { [type]: { schema } } })

describe("media types", () => {
	it("reads a media type's essence, and whether it is JSON or text", () => {
		expect([mediaEssence(" Application/JSON; charset=utf-8"), mediaEssence("")]).toEqual(["application/json", ""])
		const types = [
			"application/json",
			"application/vnd.api+json",
			"text/csv",
			"application/xml",
			"image/svg+xml",
			"image/png",
			"text",
		]
		expect(types.map((type) => [isJsonMedia(type), isTextMedia(type)])).toEqual([
			[true, false],
			[true, false],
			[false, true],
			[false, true],
			[false, true],
			[false, false],
			[false, false],
		])
	})
})

describe("sdkModel: what a call answers", () => {
	it("takes the lowest 2xx with a body, reading it as JSON, text, bytes or nothing", () => {
		const success = (responses: Json) => one({ operationId: "a", responses }).success
		expect([
			success({ 200: { description: "" }, 201: content("application/json"), 400: content("application/json") }),
			success({ 200: content("text/csv") }),
			success({ 200: content("image/png") }),
			success({ 200: content("text/event-stream") }),
			success({ 204: { description: "" } }),
			success({ 205: content("application/json") }),
		]).toEqual([
			{ contentType: "application/json", kind: "json", schema: { kind: "scalar", type: "string" }, status: "201" },
			{ contentType: "text/csv", kind: "text", status: "200" },
			{ contentType: "image/png", kind: "binary", status: "200" },
			{ contentType: "text/event-stream", kind: "none", status: "200" },
			{ kind: "none", status: "204" },
			{ contentType: "application/json", kind: "none", status: "205" },
		])
	})

	it("falls back to a JSON 2XX or default answer, else JSON for none at all and nothing for the rest", () => {
		const success = (responses: Json) => one({ operationId: "a", responses }).success
		expect([
			success({ "2XX": content("application/json") }),
			success({ default: { content: { "application/json": {} } } }),
			success({}),
			success({ default: content("text/plain") }),
		]).toEqual([
			{ contentType: "application/json", kind: "json", schema: { kind: "scalar", type: "string" }, status: "2XX" },
			{ contentType: "application/json", kind: "json", status: "default" },
			{ kind: "json", status: "200" },
			{ kind: "none", status: "200" },
		])
	})
})

describe("sdkModel: what a call sends", () => {
	it("sends JSON, a form, multipart parts, text or bytes, a text-only multipart as text parts", () => {
		const body = (type: string, schema?: Json) =>
			one({ operationId: "a", requestBody: { content: { [type]: { schema } } } }).body
		const STRING: IRSchema = { kind: "scalar", type: "string" }
		expect([
			body("application/vnd.api+json", { type: "string" }),
			body("application/x-www-form-urlencoded", { type: "string" }),
			body("multipart/form-data", { properties: { f: { format: "binary", type: "string" } } }),
			body("multipart/form-data", { properties: { note: { type: "string" } } }),
			body("multipart/form-data", { type: "string" }),
			body("text/plain"),
			body("application/octet-stream"),
			body("image/png"),
			one({ operationId: "a" }).body,
		]).toEqual([
			{ contentType: "application/vnd.api+json", kind: "json", required: false, schema: STRING },
			{ contentType: "application/x-www-form-urlencoded", kind: "form", required: false, schema: STRING },
			{
				contentType: "multipart/form-data",
				kind: "multipart",
				parts: [{ name: "f", schema: { kind: "binary" }, type: "file" }],
				required: false,
			},
			{
				contentType: "multipart/form-data",
				kind: "multipart",
				parts: [{ name: "note", schema: STRING, type: "text" }],
				required: false,
			},
			{ contentType: "multipart/form-data", kind: "multipart", parts: [], required: false },
			{ contentType: "text/plain", kind: "text", required: false },
			{ contentType: "application/octet-stream", kind: "binary", required: false },
			{ contentType: "image/png", kind: "binary", required: false },
			undefined,
		])
	})
})

describe("sdkModel: the operation as every emitter reads it", () => {
	it("gathers id segments, path pieces, sorted query, error statuses, stream kind and flags", () => {
		const op = one({
			description: "D",
			operationId: "users.create",
			parameters: [
				{ in: "query", name: "b" },
				{ in: "query", name: "B" },
				{ in: "query", name: "a" },
				{ in: "header", name: "x-h" },
			],
			responses: { 200: content("application/json"), 404: {}, "4XX": {}, 400: {}, 302: {}, default: {} },
			summary: "S",
			"x-deprecated": true,
			"x-idempotency-key": true,
			"x-invalidate": ["users"],
			"x-realtime": true,
			"x-websocket": true,
		})
		expect({ ...op, body: undefined, ir: undefined, success: undefined }).toEqual({
			deprecated: true,
			description: "D",
			errorStatuses: [400, 404],
			headers: [{ name: "x-h", required: false, schema: { kind: "scalar", type: "string" } }],
			id: "users.create",
			idempotent: true,
			invalidates: ["users"],
			method: "POST",
			path: "/a/{id}",
			pathParams: [{ name: "id", required: true, schema: { kind: "scalar", type: "string" } }],
			pathSegments: [
				{ kind: "literal", text: "/a/" },
				{ kind: "param", name: "id" },
			],
			query: ["B", "a", "b"].map((name) => ({ name, required: false, schema: { kind: "scalar", type: "string" } })),
			segments: ["users", "create"],
			stream: "realtime",
			summary: "S",
		})
		const plain = one({ responses: {} })
		expect([
			plain.id,
			plain.stream,
			plain.deprecated,
			plain.idempotent,
			plain.invalidates,
			plain.summary,
			plain.description,
		]).toEqual(["postAById", null, false, false, [], "", ""])
		expect([
			one({ operationId: "a", "x-websocket": true }).stream,
			one({ operationId: "a", responses: { 200: content("text/event-stream") } }).stream,
		]).toEqual(["ws", "sse"])
	})
})

describe("sdkModel: the model as a whole", () => {
	it("indexes operations by id, lists schema names in code-unit order, and resolves refs", () => {
		const doc = {
			components: { schemas: { b: { type: "string" }, A: { $ref: "#/components/schemas/b" } } },
			openapi: "3.1.0",
			paths: { "/x": { get: { operationId: "x", responses: {} } } },
		}
		const model = sdkModel(toIR(doc as OpenApiDocument))
		expect([
			model.opsById.get("x")?.id,
			model.schemaNames,
			model.resolve({ kind: "ref", name: "A" }),
			model.ir.operations.length,
		]).toEqual(["x", ["A", "b"], { kind: "scalar", type: "string" }, 1])
	})
})

describe("valueCycleSchemas: what needs a pointer", () => {
	it("finds schemas on a by-value cycle, direct or mutual, through fields, allOf, nullable and unions, never through a container", () => {
		expect(
			[
				...valueCycleSchemas({
					Self: field(ref("Self")),
					A: { kind: "allOf", parts: [ref("B")] },
					B: { inner: { kind: "union", variants: [ref("A")] }, kind: "nullable" },
					Listed: field({ items: ref("Listed"), kind: "array" }),
					Leaf: { kind: "scalar", type: "string" },
					Dangling: field(ref("Nowhere")),
					ToSelf: field(ref("Self")),
				}),
			].sort(),
		).toEqual(["A", "B", "Self"])
	})
})

type Schema = Record<string, unknown>

/** honey's error envelope for `status` and `keys`, its field list behind a ref. */
function envelope(status: unknown, keys: unknown[]): IRSchema {
	return schemaToIR({
		properties: {
			error_key: { enum: keys, type: "string" },
			fields: {
				additionalProperties: { items: { $ref: "#/components/schemas/Field" }, type: "array" },
				type: "object",
			},
			message: { type: "string" },
			status: { enum: [status], type: "integer" },
			status_key: { type: "string" },
			success: { const: false },
		},
		type: "object",
	})
}

/** `object` with the fields named in `properties` replaced. */
function withFields(object: IRSchema, properties: Record<string, unknown>): IRSchema {
	if (object.kind !== "object") return object
	const replaced = Object.entries(properties).map(([name, schema]) => ({
		name,
		required: false,
		schema: schemaToIR(schema as Schema),
	}))
	return { ...object, fields: [...object.fields.filter((f) => !Object.hasOwn(properties, f.name)), ...replaced] }
}

describe("irErrorEnvelope: honey's error body, read through refs", () => {
	// v0: 658fb508a5
	// v0: 2f4c85dc90
	// v0: a6591bd427
	it("reads honey's error envelope through refs, and nothing else as one", () => {
		const fieldList = schemaToIR({
			properties: { error_key: { type: "string" }, message: { type: "string" }, path: { type: "string" } },
		})
		const resolve = irResolver({ Envelope: envelope(404, ["not_found", "gone"]), Field: fieldList })
		expect([
			irErrorEnvelope(ref("Envelope"), resolve),
			irErrorEnvelope(envelope("404", ["a"]), resolve),
			irErrorEnvelope(envelope(404, []), resolve),
			irErrorEnvelope({ kind: "scalar", type: "string" } as IRSchema, resolve),
		]).toEqual([{ keys: ["not_found", "gone"], status: 404 }, null, null, null])
		const broken = (properties: Record<string, unknown>) =>
			irErrorEnvelope(withFields(envelope(404, ["a"]), properties), resolve)
		expect([
			broken({ message: { type: "number" } }),
			broken({ fields: { type: "string" } }),
			broken({ fields: { additionalProperties: { type: "string" }, type: "object" } }),
			broken({ error_key: { enum: [1], type: "string" } }),
			/* the default envelope, its status an unconstrained integer */
			broken({ status: { type: "integer" } }),
		]).toEqual([null, null, null, null, null])
	})
})
