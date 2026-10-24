import { describe, expect, it } from "vitest"
import { toIR } from "./build.ts"
import type { IROperation, IRSchema } from "./model.ts"
import { bodiesOf, openApiPathParams } from "./slots.ts"

type Json = Record<string, unknown>

const STRING: IRSchema = { kind: "scalar", type: "string" }
const OBJECT: IRSchema = { fields: [], kind: "object" }

/** The IR of one operation `op` at `method path`, its path item adding `item`. */
function operation(op: Json, path = "/items", method = "post", item: Json = {}): IROperation {
	const spec = {
		info: { title: "T", version: "1" },
		openapi: "3.1.0",
		paths: { [path]: { ...item, [method]: { operationId: "op", responses: {}, ...op } } },
	}
	return toIR(spec).operations[0] as IROperation
}

const form = (ref: string) => ({ requestBody: { content: { "multipart/form-data": { schema: { $ref: ref } } } } })
const json = (schema: Json = { type: "object" }) => ({ content: { "application/json": { schema } } })

describe("parameters, by where they travel", () => {
	// v0: c2d91470b1
	// v0: 00675a9a5f
	// v0: 2010d3e1a8
	// v0: 5738d84816
	// v0: 1d0402353d
	// v0: ff9e147c1e
	it("buckets path, query, header and cookie params; path ones in template order, undeclared ones back-filled as strings", () => {
		const op = operation(
			{
				parameters: [
					{ in: "path", name: "id", schema: { type: "integer" } },
					{ description: "page size", in: "query", name: "limit", schema: { default: 20, type: "integer" } },
					{ in: "header", name: "x-trace", required: true },
					{ in: "cookie", name: "sid", required: true, schema: { type: "string" } },
					{ in: "path", name: "gone", schema: { type: "string" } },
				],
			},
			"/orgs/{org}/items/{id}/{rest}",
			"get",
			{
				parameters: [
					{ in: "path", name: "rest", required: true, schema: { type: "string" }, "x-honey-wildcard": true },
				],
			},
		)
		expect(op.params).toEqual({
			cookie: [{ name: "sid", required: true, schema: STRING }],
			header: [{ name: "x-trace", required: true, schema: STRING }],
			path: [
				{ name: "org", required: true, schema: STRING },
				{ name: "id", required: true, schema: { kind: "scalar", type: "integer" } },
				{ name: "rest", required: true, schema: STRING, wildcard: true },
			],
			query: [
				{
					default: 20,
					description: "page size",
					name: "limit",
					required: false,
					schema: { kind: "scalar", type: "integer" },
				},
			],
		})
		expect([openApiPathParams("/a/{x}/{y}/{x}"), openApiPathParams("{a}{b}"), operation({}).params.cookie]).toEqual([
			["x", "y"],
			["a", "b"],
			undefined,
		])
	})
})

describe("parameters: overrides and refs", () => {
	it("lets an operation's parameter override its path item's, and follows a parameter $ref", () => {
		const components = { parameters: { Limit: { in: "query", name: "limit", schema: { type: "integer" } } } }
		const spec = {
			components,
			info: { title: "T", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/a": {
					get: {
						operationId: "a",
						parameters: [
							{ in: "query", name: "q", schema: { type: "number" } },
							{ $ref: "#/components/parameters/Limit" },
						],
						responses: {},
					},
					parameters: [{ in: "query", name: "q", schema: { type: "string" } }, { $ref: "#/components/nothing/Here" }],
				},
			},
		}
		expect((toIR(spec).operations[0] as IROperation).params.query.map(({ name, schema }) => [name, schema])).toEqual([
			["q", { kind: "scalar", type: "number" }],
			["limit", { kind: "scalar", type: "integer" }],
		])
	})
})

/** The preferred body of an operation whose one request body is `schema` under `contentType`. */
function body(contentType: string, schema: Json, required = true) {
	return operation({ requestBody: { content: { [contentType]: { schema } }, required } }).body
}

const BINARY = { format: "binary", type: "string" }

describe("request bodies: raw and streamed", () => {
	// v0: a690362fb3
	// v0: b0c2486399
	// v0: 0c4a22d57b
	// v0: 1489be85e4
	// v0: 1fdb76c034
	// v0: 1dc791c60c
	// v0: 60db0ca2d7
	// v0: cd65c3633f
	it("reads JSON, a form and a text-only multipart as raw, and octet-stream as a stream", () => {
		expect([
			body("application/json", { type: "object" }),
			body("application/x-www-form-urlencoded", { type: "object" }, false),
			body("multipart/form-data", { properties: { note: { type: "string" } }, type: "object" }),
			body("application/octet-stream", BINARY),
			operation({}).body,
		]).toEqual([
			{ contentType: "application/json", kind: "raw", required: true, schema: OBJECT },
			{ contentType: "application/x-www-form-urlencoded", kind: "raw", required: false, schema: OBJECT },
			{
				contentType: "multipart/form-data",
				kind: "raw",
				required: true,
				schema: { fields: [{ name: "note", required: false, schema: STRING }], kind: "object" },
			},
			{ contentType: "application/octet-stream", kind: "stream", required: true },
			undefined,
		])
	})
})

describe("request bodies: multipart with files", () => {
	// v0: f7ac92d06c
	// v0: 9a8c74b152
	// v0: 352fbeafc2
	it("splits a multipart with a file, or a list of files, into its parts", () => {
		const files = { items: { kind: "binary" }, kind: "array" } as const
		expect([
			body("multipart/form-data", { properties: { file: BINARY, note: { type: "string" } }, type: "object" }),
			body("multipart/form-data", { properties: { files: { items: BINARY, type: "array" } }, type: "object" }),
		]).toEqual([
			{
				contentType: "multipart/form-data",
				kind: "multipart",
				parts: [
					{ name: "file", schema: { kind: "binary" }, type: "file" },
					{ name: "note", schema: STRING, type: "text" },
				],
				required: true,
				schema: {
					fields: [
						{ name: "file", required: false, schema: { kind: "binary" } },
						{ name: "note", required: false, schema: STRING },
					],
					kind: "object",
				},
			},
			{
				contentType: "multipart/form-data",
				kind: "multipart",
				parts: [{ name: "files", schema: files, type: "file" }],
				required: true,
				schema: { fields: [{ name: "files", required: false, schema: files }], kind: "object" },
			},
		])
	})
})

describe("request bodies: order and refs", () => {
	it("lists every body in preference order, JSON-like before the rest, and follows body and schema refs", () => {
		const components = {
			requestBodies: {
				Upload: { content: { "multipart/form-data": { schema: { $ref: "#/components/schemas/Form" } } } },
			},
			schemas: {
				File: { format: "binary", type: "string" },
				Form: { properties: { f: { $ref: "#/components/schemas/File" } } },
			},
		}
		const spec = {
			components,
			info: { title: "T", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/u": { put: { operationId: "u", requestBody: { $ref: "#/components/requestBodies/Upload" }, responses: {} } },
			},
		}
		const op = operation({
			requestBody: {
				content: {
					"text/plain": {},
					"text/csv": {},
					"application/vnd.api+json": {},
					"multipart/form-data": {},
					"application/json": {},
				},
			},
		})
		expect([
			bodiesOf(op).map(({ contentType }) => contentType),
			(toIR(spec).operations[0] as IROperation).body?.kind,
		]).toEqual([
			["application/json", "multipart/form-data", "application/vnd.api+json", "text/plain", "text/csv"],
			"multipart",
		])
		expect([bodiesOf(operation({ requestBody: json() })).length, bodiesOf(operation({})).length]).toEqual([1, 0])
		const missing = {
			...spec,
			paths: { "/m": { put: { ...form("#/components/schemas/Missing"), operationId: "m", responses: {} } } },
		}
		expect([operation(form("#/components/schemas/Form")).body?.kind, toIR(missing).operations[0]?.body?.kind]).toEqual([
			"raw",
			"raw",
		])
	})
})

const URLENCODED = "application/x-www-form-urlencoded"

/** A form of `properties` offered urlencoded and multipart, and as JSON too when `withJson`. */
function offered(properties: Json, withJson = false): Json {
	const schema = { properties, type: "object" }
	const content = { [URLENCODED]: { schema }, "multipart/form-data": { schema } }
	return { requestBody: { content: withJson ? { ...content, "application/json": { schema } } : content } }
}

const order = (op: IROperation) => bodiesOf(op).map(({ contentType, kind }) => `${contentType} ${kind}`)

describe("request bodies: a form offered both ways", () => {
	it("prefers multipart when the form has a file part, since urlencoded cannot carry one", () => {
		const file = { file: { format: "binary", type: "string" } }
		expect([order(operation(offered(file))), order(operation(offered(file, true)))]).toEqual([
			["multipart/form-data multipart", `${URLENCODED} raw`],
			["application/json raw", "multipart/form-data multipart", `${URLENCODED} raw`],
		])
	})

	it("keeps urlencoded first when the form has no file part", () => {
		expect(order(operation(offered({ note: { type: "string" } })))).toEqual([
			`${URLENCODED} raw`,
			"multipart/form-data raw",
		])
	})
})

describe("responses and extensions", () => {
	// v0: bd7dffc2cb
	// v0: 87881dbcd5
	// v0: 7f21a923ab
	// v0: ae4e681c84
	// v0: c4e723f8c6
	it("keeps each status key as written, a bodiless one bare, the preferred media type's schema, and marks SSE", () => {
		const op = operation({
			responses: {
				200: json({ type: "string" }),
				204: { description: "" },
				"4XX": { content: {} },
				default: { content: { "text/plain": {} } },
				201: { content: { "text/event-stream; charset=utf-8": { schema: { type: "string" } } } },
			},
		})
		expect([op.responses, op.extensions]).toEqual([
			{
				200: {
					contentType: "application/json",
					contents: [{ contentType: "application/json", schema: STRING }],
					schema: STRING,
					status: "200",
				},
				201: {
					contentType: "text/event-stream; charset=utf-8",
					contents: [{ contentType: "text/event-stream; charset=utf-8", schema: STRING }],
					schema: STRING,
					status: "201",
				},
				204: { status: "204" },
				"4XX": { status: "4XX" },
				default: { contentType: "text/plain", contents: [{ contentType: "text/plain" }], status: "default" },
			},
			{ sse: true },
		])
	})
})

describe("operation extensions", () => {
	// v0: 455ce5bf3b
	// v0: 1c96aa5b16
	// v0: 16c7280ca1
	// v0: 9b42069403
	// v0: 18811ab3d5
	// v0: 69b672b352
	// v0: 99e977f412
	// v0: 5066dca194
	// v0: a61f2738d6
	// v0: c4b90cd813
	// v0: 5c9f93afc1
	// v0: 39ef3cbd8e
	// v0: 93c4736b18
	// v0: 7b8ac1f593
	it("reads the honey extensions, only a literal true counting as on", () => {
		const on = {
			"x-idempotency-key": true,
			"x-invalidate": ["a", 1, "b", "c"],
			"x-mcp": true,
			"x-realtime": true,
			"x-websocket": true,
		}
		expect([
			operation(on).extensions,
			operation({ "x-deprecated": true }).extensions,
			operation({ deprecated: true }).extensions,
			[false, "yes", {}].map((value) => operation({ "x-idempotency-key": value }).extensions.idempotencyKey),
			[false, "true", {}, 1].map((value) => operation({ "x-mcp": value }).extensions.mcp),
			operation({ responses: undefined }).responses,
			operation({}).extensions,
		]).toEqual([
			{ idempotencyKey: true, invalidates: ["a", "b", "c"], mcp: true, realtime: true, websocket: true },
			{ deprecated: true },
			{ deprecated: true },
			[undefined, undefined, undefined],
			[undefined, undefined, undefined, undefined],
			{},
			{},
		])
	})

	it("reads the route id an operation came from (x-honey-route), the key extracted ctx types join on", () => {
		expect([
			operation({ "x-honey-route": "GET /users/:id?" }).extensions,
			operation({ "x-honey-route": 1 }).extensions,
		]).toEqual([{ route: "GET /users/:id?" }, {}])
	})
})

describe("responses: declared headers (A2)", () => {
	it("carries a response's headers in code-unit order, refs followed, required or not, and none when it declares none", () => {
		const spec = {
			components: { headers: { Total: { required: true, schema: { type: "integer" } } } },
			info: { title: "T", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/r": {
					get: {
						operationId: "r",
						responses: {
							200: {
								description: "",
								headers: { "X-Total": { $ref: "#/components/headers/Total" }, "x-cursor": {} },
							},
							404: { description: "" },
						},
					},
				},
			},
		}
		const { responses } = toIR(spec).operations[0] as IROperation
		expect([responses["200"]?.headers, Object.hasOwn(responses["404"] ?? {}, "headers")]).toEqual([
			[
				{ name: "X-Total", required: true, schema: { kind: "scalar", type: "integer" } },
				{ name: "x-cursor", required: false, schema: { kind: "unknown" } },
			],
			false,
		])
	})
})

describe("responses and extensions: what codegen reads of declared errors (O2) and media types", () => {
	it("carries x-honey-errors per key and x-honey-error per response, and every media type with its schema", () => {
		const op = operation({
			responses: {
				201: {
					content: { "application/json": { schema: { type: "object" } }, "text/plain": { schema: { type: "string" } } },
					description: "",
				},
				409: {
					content: { "application/json": { schema: { type: "object" } } },
					description: "",
					"x-honey-error": true,
				},
			},
			"x-honey-errors": { gone: { status: null }, taken: { schema: { type: "string" }, status: 409 } },
		})
		expect([
			op.extensions.errors,
			op.responses["201"]?.contents,
			op.responses["201"]?.error,
			op.responses["409"]?.error,
		]).toEqual([
			{ gone: { status: null }, taken: { schema: STRING, status: 409 } },
			[
				{ contentType: "application/json", schema: OBJECT },
				{ contentType: "text/plain", schema: STRING },
			],
			undefined,
			true,
		])
	})

	it("drops a malformed x-honey-errors entry and leaves no field when nothing is declared", () => {
		const op = operation({
			responses: { 200: { description: "" } },
			"x-honey-errors": { bad: { status: "x" }, gone: null, list: [] },
		})
		expect([op.extensions.errors, op.responses["200"]?.contents, Object.hasOwn(op.extensions, "errors")]).toEqual([
			undefined,
			undefined,
			false,
		])
	})
})
