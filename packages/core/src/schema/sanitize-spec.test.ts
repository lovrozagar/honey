import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { sanitizeOpenApiSpec } from "./sanitize-spec.ts"
import type { SchemaSpec } from "./slots.ts"

const SCHEMES = {
	apiKey: { in: "header", name: "k", type: "apiKey" },
	internalKey: { in: "header", name: "i", type: "apiKey" },
	jwt: { scheme: "bearer", type: "http" },
}

/** A spec whose one operation carries `operation`, with the three schemes above. */
function spec(operation: Record<string, unknown>, extra: Record<string, unknown> = {}): SchemaSpec {
	return {
		components: { schemas: { A: { type: "string" } }, securitySchemes: { ...SCHEMES } },
		info: { title: "t", version: "1" },
		openapi: "3.1.0",
		paths: { "/a": { get: { responses: {}, ...operation }, parameters: [] } },
		...extra,
	}
}

describe("sanitizeOpenApiSpec: security a published document leaves out", () => {
	// v0: f1b57279bc
	// v0: b9d9518864
	it("drops each requirement that names a stripped scheme, and the list when none is left, on operations and the root", () => {
		const options = { stripSecurityRequirements: ["jwt"] }
		const some = sanitizeOpenApiSpec(
			spec({ security: [{ jwt: [] }, { apiKey: [] }, { jwt: [], internalKey: [] }] }),
			options,
		)
		const none = sanitizeOpenApiSpec(spec({ security: [{ jwt: [] }] }, { security: [{ jwt: [] }] }), options)
		expect([some.paths["/a"]?.get, none.paths["/a"]?.get, Object.hasOwn(none, "security")]).toEqual([
			{ responses: {}, security: [{ apiKey: [] }] },
			{ responses: {} },
			false,
		])
	})

	// v0: 39c1c1076b
	// v0: 8c9de52e88
	it("drops each stripped scheme, and securitySchemes when none is left, keeping the other components", () => {
		const some = sanitizeOpenApiSpec(spec({}), { stripSecuritySchemes: ["jwt", "internalKey"] })
		const all = sanitizeOpenApiSpec(spec({}), { stripSecuritySchemes: ["apiKey", "internalKey", "jwt"] })
		expect([some.components, all.components]).toEqual([
			{ schemas: { A: { type: "string" } }, securitySchemes: { apiKey: SCHEMES.apiKey } },
			{ schemas: { A: { type: "string" } } },
		])
	})
})

describe("sanitizeOpenApiSpec: operation extensions", () => {
	// v0: fe9a9c69f1
	// v0: cd67ad4f4f
	it("drops every x- key of an operation honey does not read, or only the ones named", () => {
		const operation = { operationId: "a", "x-admin": true, "x-internal": true, "x-invalidate": ["b"] }
		expect([
			sanitizeOpenApiSpec(spec(operation), { stripXExtensions: true }).paths["/a"]?.get,
			sanitizeOpenApiSpec(spec(operation), { stripXExtensions: ["x-invalidate"] }).paths["/a"]?.get,
		]).toEqual([
			{ operationId: "a", responses: {}, "x-invalidate": ["b"] },
			{ operationId: "a", responses: {}, "x-admin": true, "x-internal": true },
		])
	})

	it("keeps the keys honey and its generators read: on operations, responses, parameters and schemas", () => {
		const operation = {
			parameters: [{ in: "path", name: "rest", schema: { type: "string" }, "x-honey-wildcard": true }],
			responses: { "409": { description: "taken", "x-honey-error": true } },
			"x-honey-errors": { taken: { status: 409 } },
			"x-honey-route": "GET /a",
			"x-mcp": true,
		}
		const file = { properties: { data: { type: "string" } }, type: "object", "x-mcp-file": {} }
		const out = sanitizeOpenApiSpec(spec(operation, { components: { schemas: { File: file } } }), {
			stripXExtensions: true,
		})
		expect([out.paths["/a"]?.get, out.components?.schemas]).toEqual([operation, { File: file }])
	})
})

describe("sanitizeOpenApiSpec: extensions inside schemas", () => {
	it("drops the x- keys honey does not read inside every schema, and never a property or header named x-", () => {
		const consumer = { type: "string", "x-comb-text": "t" }
		const body = {
			additionalProperties: false,
			items: { ...consumer },
			properties: { "x-name": { ...consumer }, nested: { allOf: [{ ...consumer }], type: "object" } },
			type: "object",
			"x-comb": { max: 1 },
		}
		const operation = {
			parameters: [{ in: "query", name: "q", schema: { ...consumer }, "x-comb-minimum": 1 }],
			requestBody: { content: { "application/json": { schema: body } } },
			responses: {
				"200": {
					content: { "application/json": { schema: { ...consumer } } },
					description: "ok",
					headers: { "x-total": { schema: { ...consumer } } },
					"x-comb-transform": "t",
				},
			},
		}
		const out = sanitizeOpenApiSpec(spec(operation, { components: { schemas: { T: { ...consumer } } } }), {
			stripXExtensions: true,
		})
		const plain = { type: "string" }
		expect([out.paths["/a"]?.get, out.components?.schemas]).toEqual([
			{
				parameters: [{ in: "query", name: "q", schema: plain }],
				requestBody: {
					content: {
						"application/json": {
							schema: {
								additionalProperties: false,
								items: plain,
								properties: { nested: { allOf: [plain], type: "object" }, "x-name": plain },
								type: "object",
							},
						},
					},
				},
				responses: {
					"200": {
						content: { "application/json": { schema: plain } },
						description: "ok",
						headers: { "x-total": { schema: plain } },
					},
				},
			},
			{ T: plain },
		])
	})
})

describe("sanitizeOpenApiSpec: what honey's generators read", () => {
	it("keeps every x- key honey's generators read off an operation, a response, a parameter or a schema", () => {
		const read = new Set<string>()
		for (const file of ["../../../gen/src/ir/slots.ts", "../../../gen/src/emit/mcp/files.ts"])
			for (const [, key] of readFileSync(new URL(file, import.meta.url), "utf8").matchAll(/"(x-[a-z-]+)"/g))
				read.add(key as string)
		const marked = Object.fromEntries([...read].map((key) => [key, true]))
		const out = sanitizeOpenApiSpec(
			spec(
				{ ...marked, parameters: [{ in: "query", name: "q", ...marked }], responses: { "200": { ...marked } } },
				{
					components: { schemas: { S: { ...marked } } },
				},
			),
			{ stripXExtensions: true },
		)
		const get = out.paths["/a"]?.get as Record<string, Record<string, unknown>[] & Record<string, unknown>>
		expect([
			read.size > 5,
			Object.keys(get).filter((key) => key.startsWith("x-")).length,
			out.components?.schemas,
		]).toEqual([true, read.size, { S: marked }])
		expect([get.parameters?.[0], get.responses?.["200"]]).toEqual([{ in: "query", name: "q", ...marked }, marked])
	})
})

describe("sanitizeOpenApiSpec: what it leaves alone", () => {
	// v0: 6ecfb9b07d
	// v0: 804b13881b
	// v0: 6eff3c761c
	it("applies every option at once, changes nothing without one, and never touches its input", () => {
		const input = spec({ security: [{ jwt: [] }], "x-internal": true })
		const before = structuredClone(input)
		const all = sanitizeOpenApiSpec(input, {
			stripSecurityRequirements: ["jwt"],
			stripSecuritySchemes: ["jwt"],
			stripXExtensions: true,
		})
		expect(all.paths["/a"]).toEqual({ get: { responses: {} }, parameters: [] })
		expect(all.components?.securitySchemes).toEqual({ apiKey: SCHEMES.apiKey, internalKey: SCHEMES.internalKey })
		expect(sanitizeOpenApiSpec(input, {})).toEqual(before)
		expect(input).toEqual(before)
	})

	it("keeps a spec without components or security as it is", () => {
		const bare: SchemaSpec = { paths: { "/a": { get: { responses: {} } } } }
		expect(sanitizeOpenApiSpec(bare, { stripSecurityRequirements: ["jwt"], stripSecuritySchemes: ["jwt"] })).toEqual(
			bare,
		)
		expect(sanitizeOpenApiSpec(bare, { stripXExtensions: true })).toEqual(bare)
	})
})
