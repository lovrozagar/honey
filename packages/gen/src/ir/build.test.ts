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

/** A webhook that POSTs `{ id }`, signed as `signature` says. */
const signed = (signature?: Json) => ({
	post: {
		requestBody: {
			content: { "application/json": { schema: { properties: { id: { type: "string" } }, type: "object" } } },
		},
		responses: { "200": { description: "Received" } },
		summary: "Paid",
		...(signature === undefined ? {} : { "x-honey-signature": signature }),
	},
})

describe("toIR: webhooks", () => {
	it("reads each webhook by name: its method, body, summary and how it is signed, the prefix empty when unset", () => {
		const ir = toIR(
			withWebhooks({
				"order.shipped": {
					put: { description: "Sent per parcel.", requestBody: signed().post.requestBody, responses: {} },
				},
				"invoice.paid": signed({ algorithm: "hmac-sha256", encoding: "hex", header: "X-Signature" }),
			}),
		)
		expect([ir.webhooks, toIR(doc({})).webhooks]).toEqual([
			[
				{
					body: {
						fields: [{ name: "id", required: false, schema: { kind: "scalar", type: "string" } }],
						kind: "object",
					},
					method: "POST",
					name: "invoice.paid",
					signature: { algorithm: "hmac-sha256", encoding: "hex", header: "X-Signature", prefix: "" },
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

	it("refuses a signature an SDK could not verify: another algorithm or encoding, a header that is no token, a control character", () => {
		const sig = { algorithm: "hmac-sha256", encoding: "base64", header: "Sig" }
		const read = (signature: Json) => () => toIR(withWebhooks({ hook: signed(signature) }))
		expect(read({ ...sig, algorithm: "md5" })).toThrow(
			'x-honey-signature on webhook "hook": algorithm "md5" is not hmac-sha256',
		)
		expect(read({ ...sig, encoding: "utf8" })).toThrow(
			'x-honey-signature on webhook "hook": encoding "utf8" is not hex or base64',
		)
		expect(read({ ...sig, header: "X Sig" })).toThrow(
			'x-honey-signature on webhook "hook": header "X Sig" is not a header name',
		)
		expect(read({ ...sig, prefix: "sha256=" })).not.toThrow()
		expect(read({ ...sig, prefix: "v1\n" })).toThrow(
			'x-honey-signature on webhook "hook": the prefix holds a control character',
		)
		expect(read("hmac" as never)).toThrow('x-honey-signature on webhook "hook": algorithm undefined is not hmac-sha256')
		expect(read({ ...sig, prefix: 1 })).toThrow('x-honey-signature on webhook "hook": the prefix is not a string')
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
