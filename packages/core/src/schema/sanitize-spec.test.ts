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
	it("drops every x- key of an operation, or only the ones named", () => {
		const operation = { operationId: "a", "x-internal": true, "x-invalidate": ["b"] }
		expect([
			sanitizeOpenApiSpec(spec(operation), { stripXExtensions: true }).paths["/a"]?.get,
			sanitizeOpenApiSpec(spec(operation), { stripXExtensions: ["x-invalidate"] }).paths["/a"]?.get,
		]).toEqual([
			{ operationId: "a", responses: {} },
			{ operationId: "a", responses: {}, "x-internal": true },
		])
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
	})
})
