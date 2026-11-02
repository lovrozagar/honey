import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { deriveOperationId, type OpenApiDocument, specAuth, toIR } from "./build.ts"

type Json = Record<string, unknown>

const INFO = { description: "Shop API", title: "Shop", version: "1" }

function doc(paths: Json, components?: Json): OpenApiDocument {
	return { components, info: INFO, openapi: "3.1.0", paths } as OpenApiDocument
}

const ok = { responses: {} }

describe("toIR: operation ids", () => {
	// v0: 09921cc26c
	// v0: b252201aa9
	// v0: 729dd7d3b6
	// v0: 701ad1506e
	// v0: b4d6166ec6
	// v0: 8486a385c0
	// v0: 9ccdae947a
	// v0: c332fd86ff
	// v0: c56800236d
	// v0: dde5e96145
	it("skips an operation without an id, refuses a shared one, and derives ids only when asked", () => {
		const paths = { "/nothing/{id}": { delete: ok, get: { ...ok, operationId: "get" } } }
		expect([toIR(doc(paths)).operations.map(({ id }) => id), deriveOperationId("delete", "/nothing/{id}")]).toEqual([
			["get"],
			"deleteNothingById",
		])
		expect(() =>
			toIR(doc({ "/a": { get: { ...ok, operationId: "x" } }, "/b": { get: { ...ok, operationId: "x" } } })),
		).toThrow('Duplicate operationId: "x"')
		expect(toIR(doc(paths), { deriveOperationIds: true }).operations.map(({ id }) => id)).toEqual([
			"get",
			"deleteNothingById",
		])
	})

	it("suffixes a shared id by method when deriving, and keeps a derived id clear of explicit ids and namespaces", () => {
		const paths = {
			"/a": { get: { ...ok, operationId: "x" }, post: { ...ok, operationId: "x" }, put: { ...ok, operationId: "x" } },
			"/b": { put: { ...ok, operationId: "x" } },
			"/": { get: ok },
			"/users": { delete: { ...ok, operationId: "deleteUsers.all" }, post: ok },
			"/users/": { delete: ok },
		}
		expect(toIR(doc(paths), { deriveOperationIds: true }).operations.map(({ id }) => id)).toEqual([
			"x",
			"xPost",
			"xPut",
			"xPut2",
			"deleteUsers.all",
			"getRoot",
			"postUsers",
			"deleteUsers2",
		])
		expect(() => toIR(doc(paths), { deriveOperationIds: true, duplicateOperationIds: "throw" })).toThrow(
			"Duplicate operationId",
		)
		expect(deriveOperationId("get", "/orgs/{orgId}/users/{user-id}")).toBe("getOrgsUsersByOrgIdAndUserId")
	})
})

describe("toIR: the document as a whole", () => {
	// v0: 35275eea4f
	// v0: c026990e10
	// v0: 4a135c02a9
	// v0: 524414e9b5
	// v0: a3b0b97f3f
	// v0: eff39c20e2
	it("converts components, lists operations path by path in method order, and is pure over frozen input", () => {
		const spec = Object.freeze(
			doc(
				{
					"/a": Object.freeze({ get: { ...ok, operationId: "getA" }, post: { ...ok, operationId: "postA" } }),
					"/b": { get: { ...ok, operationId: "getB" } },
				},
				{ schemas: { Maybe: { type: ["string", "number", "null"] } } },
			),
		)
		const ir = toIR(spec)
		expect([ir.operations.map(({ id }) => id), ir.schemas, toIR(doc({})).schemas]).toEqual([
			["getA", "postA", "getB"],
			{
				Maybe: {
					inner: {
						kind: "union",
						variants: [
							{ kind: "scalar", type: "string" },
							{ kind: "scalar", type: "number" },
						],
					},
					kind: "nullable",
				},
			},
			{},
		])
		expect(JSON.stringify(toIR(spec))).toBe(JSON.stringify(ir))
	})
})

describe("toIR: info and authentication", () => {
	// v0: 26fd8e090e
	it("carries the document's info, its component descriptions and how a client authenticates", () => {
		const ir = toIR(
			doc({}, { schemas: { Tag: { type: "string" }, User: { description: "A shop user", type: "object" } } }),
		)
		const bare = toIR({ openapi: "3.1.0" } as OpenApiDocument)
		expect([ir.info, ir.schemaDescriptions, bare.info, bare.operations]).toEqual([
			INFO,
			{ User: "A shop user" },
			{},
			[],
		])
	})

	it("authenticates by the first scheme in code-unit order, defaulting to a bearer token", () => {
		const auth = (securitySchemes: Json) => specAuth(doc({}, { securitySchemes }))
		expect([
			auth({}),
			auth({ b: { scheme: "basic", type: "http" } }),
			auth({ a: { scheme: "bearer", type: "http" }, b: { type: "apiKey" } }),
			auth({ key: { description: "Format: Token {token}", in: "header", name: "X-Api-Key", type: "apiKey" } }),
			auth({ key: { in: "header", type: "apiKey" } }),
			auth({ q: { in: "query", name: "k", type: "apiKey" } }),
			specAuth({ openapi: "3.1.0", paths: {} } as OpenApiDocument),
		]).toEqual([
			{ headerName: "Authorization", prefix: "Bearer " },
			{ headerName: "Authorization", prefix: "Basic " },
			{ headerName: "Authorization", prefix: "Bearer " },
			{ headerName: "X-Api-Key", prefix: "Token " },
			{ headerName: "Authorization", prefix: "" },
			{ headerName: "Authorization", prefix: "Bearer " },
			{ headerName: "Authorization", prefix: "Bearer " },
		])
	})
})

describe("toIR: servers", () => {
	it("lists each server URL in order, its variables filled with their defaults, and none when the document has none", () => {
		const servers = [
			{
				url: "https://{region}.api.test/{version}/{region}",
				variables: { region: { default: "eu", enum: ["eu", "us"] }, version: { default: "v1" } },
			},
			{ url: "/api/{undeclared}" },
		]
		expect([toIR({ ...doc({}), servers } as OpenApiDocument).servers, toIR(doc({})).servers]).toEqual([
			["https://eu.api.test/v1/eu", "/api/{undeclared}"],
			[],
		])
	})
})

/** A document of one route and `webhooks`. */
const withWebhooks = (webhooks: Json) =>
	({ ...doc({ "/a": { get: { ...ok, operationId: "a" } } }), webhooks }) as OpenApiDocument

/** A webhook that POSTs `{ id }`, its operation carrying `extra` beside. */
const posted = (extra: Json = {}) => ({
	post: {
		requestBody: {
			content: { "application/json": { schema: { properties: { id: { type: "string" } }, type: "object" } } },
		},
		responses: { "200": { description: "Received" } },
		summary: "Paid",
		...extra,
	},
})

describe("toIR: webhooks", () => {
	it("reads each webhook by name: its method, body and summary, no body when it sends none", () => {
		const ir = toIR(
			withWebhooks({
				"a.ping": { post: { responses: {} } },
				"order.shipped": {
					put: { description: "Sent per parcel.", requestBody: posted().post.requestBody, responses: {} },
				},
				"invoice.paid": posted(),
			}),
		)
		expect([ir.webhooks, toIR(doc({})).webhooks]).toEqual([
			[
				{ method: "POST", name: "a.ping" },
				{
					body: {
						fields: [{ name: "id", required: false, schema: { kind: "scalar", type: "string" } }],
						kind: "object",
					},
					method: "POST",
					name: "invoice.paid",
					summary: "Paid",
				},
				{
					body: {
						fields: [{ name: "id", required: false, schema: { kind: "scalar", type: "string" } }],
						kind: "object",
					},
					description: "Sent per parcel.",
					method: "PUT",
					name: "order.shipped",
				},
			],
			[],
		])
	})

	it("reads an x-honey-signature in a document it did not write as any unknown extension: ignored, never refused", () => {
		const plain = toIR(withWebhooks({ hook: posted() })).webhooks
		for (const signature of [
			{ algorithm: "hmac-sha256", encoding: "hex", header: "X-Signature" },
			{ algorithm: "md5" },
			"hmac",
		])
			expect(toIR(withWebhooks({ hook: posted({ "x-honey-signature": signature }) })).webhooks).toEqual(plain)
	})
})

const SPECS = join(import.meta.dirname, "__fixtures__/specs")

describe("toIR: the SDK emitters' fixture documents", () => {
	const fixtures = readdirSync(SPECS).flatMap((lang) => readdirSync(join(SPECS, lang)).map((file) => join(lang, file)))

	// v0: 2b1827582e
	it.each(fixtures)("%s keeps every operation with an id and every component", (file) => {
		const spec = JSON.parse(readFileSync(join(SPECS, file), "utf8")) as OpenApiDocument & Json
		const withId = Object.values(spec.paths ?? {}).flatMap((item) =>
			["get", "post", "put", "patch", "delete", "head", "options"].filter(
				(method) =>
					typeof (item as Json)[method] === "object" &&
					typeof ((item as Json)[method] as Json).operationId === "string",
			),
		)
		const ir = toIR(spec)
		expect([ir.operations.length, Object.keys(ir.schemas).length]).toEqual([
			withId.length,
			Object.keys(spec.components?.schemas ?? {}).length,
		])
	})
})

/** A Standard Webhooks event `type` as core documents it: the marker and the `{ type, timestamp, data }` envelope. */
const marked = (type: string, data: Json, envelope: Json = {}) => ({
	post: {
		"x-honey-webhook": "standard-webhooks",
		requestBody: {
			content: {
				"application/json": {
					schema: {
						properties: { data, timestamp: { format: "date-time", type: "string" }, type: { const: type } },
						required: ["type", "timestamp", "data"],
						type: "object",
						...envelope,
					},
				},
			},
			required: true,
		},
		responses: { "2XX": { description: "Received" } },
	},
})

const BATCH = { properties: { rows: { type: "integer" } }, required: ["rows"], type: "object" }

describe("toIR: Standard Webhooks events", () => {
	it("reads a marked webhook's event type and data, the envelope inline or a component; an unmarked one has none", () => {
		const ir = toIR({
			...withWebhooks({
				"batch.complete": marked("batch.complete", BATCH),
				"batch.failed": marked("batch.failed", { $ref: "#/components/schemas/Batch" }),
				plain: posted(),
			}),
			components: { schemas: { Batch: BATCH } },
		} as OpenApiDocument)
		expect(ir.webhooks.map((w) => [w.name, w.event])).toEqual([
			[
				"batch.complete",
				{
					data: {
						fields: [{ name: "rows", required: true, schema: { kind: "scalar", type: "integer" } }],
						kind: "object",
					},
					type: "batch.complete",
				},
			],
			["batch.failed", { data: { kind: "ref", name: "Batch" }, type: "batch.failed" }],
			["plain", undefined],
		])
	})

	it("reads an envelope behind a component reference", () => {
		const envelope = marked("ping", { type: "object" }).post.requestBody.content["application/json"].schema
		const hook = marked("ping", {})
		hook.post.requestBody.content["application/json"].schema = { $ref: "#/components/schemas/PingEvent" } as never
		const ir = toIR({
			...withWebhooks({ ping: hook }),
			components: { schemas: { PingEvent: envelope } },
		} as OpenApiDocument)
		expect(ir.webhooks[0]?.event).toEqual({ data: { fields: [], kind: "object" }, type: "ping" })
	})

	it("refuses a marked webhook it could not verify into a typed event, naming it", () => {
		const read = (hook: Json) => () => toIR(withWebhooks({ "batch.complete": hook }))
		expect(read(marked("batch.failed", BATCH))).toThrow(
			'x-honey-webhook on webhook "batch.complete": the envelope\'s type const is "batch.failed", not the webhook\'s name',
		)
		expect(read(marked("batch.complete", BATCH, { properties: { type: { const: "batch.complete" } } }))).toThrow(
			'x-honey-webhook on webhook "batch.complete": the body is not a { type, timestamp, data } envelope',
		)
		expect(read({ post: { "x-honey-webhook": "standard-webhooks", responses: {} } })).toThrow(
			'x-honey-webhook on webhook "batch.complete": the body is not a { type, timestamp, data } envelope',
		)
		expect(read({ post: { ...marked("batch.complete", BATCH).post, "x-honey-webhook": "other" } })).toThrow(
			'x-honey-webhook on webhook "batch.complete": "other" is not standard-webhooks',
		)
	})
})
