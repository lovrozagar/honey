import { describe, expect, it } from "vitest"
import { sanitizeOpenApiSpec } from "../../../src/codegen.ts"

type Spec = Parameters<typeof sanitizeOpenApiSpec>[0]

function makeSpec(
	paths: Record<string, Record<string, Record<string, unknown>>>,
	components?: Spec["components"],
): Spec {
	return {
		components,
		info: { title: "Test", version: "1.0" },
		openapi: "3.1.0",
		paths,
	}
}

describe("sanitizeOpenApiSpec", () => {
	it("stripSecurityRequirements removes named entries from operation security arrays", () => {
		const spec = makeSpec({
			"/users": {
				get: {
					responses: {},
					security: [{ jwt: [] }, { apiKey: [] }],
				},
			},
		})

		const result = sanitizeOpenApiSpec(spec, { stripSecurityRequirements: ["jwt"] })
		const op = result.paths["/users"].get as Record<string, unknown>
		expect(op.security).toEqual([{ apiKey: [] }])
	})

	it("stripSecurityRequirements removes security field when array becomes empty", () => {
		const spec = makeSpec({
			"/internal": {
				get: {
					responses: {},
					security: [{ jwt: [] }],
				},
			},
		})

		const result = sanitizeOpenApiSpec(spec, { stripSecurityRequirements: ["jwt"] })
		const op = result.paths["/internal"].get as Record<string, unknown>
		expect(op.security).toBeUndefined()
	})

	it("stripSecuritySchemes removes named schemes from components", () => {
		const spec = makeSpec(
			{ "/a": { get: { responses: {} } } },
			{
				securitySchemes: {
					apiKey: { in: "header", type: "apiKey" },
					internalKey: { in: "header", type: "apiKey" },
					jwt: { scheme: "bearer", type: "http" },
				},
			},
		)

		const result = sanitizeOpenApiSpec(spec, { stripSecuritySchemes: ["jwt", "internalKey"] })
		expect(result.components?.securitySchemes).toEqual({ apiKey: { in: "header", type: "apiKey" } })
	})

	it("stripSecuritySchemes removes securitySchemes key when all schemes stripped", () => {
		const spec = makeSpec(
			{ "/a": { get: { responses: {} } } },
			{ securitySchemes: { jwt: { scheme: "bearer", type: "http" } } },
		)

		const result = sanitizeOpenApiSpec(spec, { stripSecuritySchemes: ["jwt"] })
		expect(result.components?.securitySchemes).toBeUndefined()
	})

	it("stripXExtensions: true removes all x-* properties from operations", () => {
		const spec = makeSpec({
			"/users": {
				post: {
					responses: {},
					"x-custom": "value",
					"x-invalidate": ["GET /users"],
				},
			},
		})

		const result = sanitizeOpenApiSpec(spec, { stripXExtensions: true })
		const op = result.paths["/users"].post as Record<string, unknown>
		expect(op["x-invalidate"]).toBeUndefined()
		expect(op["x-custom"]).toBeUndefined()
		expect(op.responses).toBeDefined()
	})

	it("stripXExtensions with array removes only listed extensions", () => {
		const spec = makeSpec({
			"/users": {
				post: {
					responses: {},
					"x-internal": true,
					"x-invalidate": ["GET /users"],
				},
			},
		})

		const result = sanitizeOpenApiSpec(spec, { stripXExtensions: ["x-invalidate"] })
		const op = result.paths["/users"].post as Record<string, unknown>
		expect(op["x-invalidate"]).toBeUndefined()
		expect(op["x-internal"]).toBe(true)
	})

	it("all options combined", () => {
		const spec = makeSpec(
			{
				"/users": {
					get: {
						responses: {},
						security: [{ jwt: [] }, { apiKey: [] }],
						"x-invalidate": ["GET /users"],
					},
				},
			},
			{
				securitySchemes: {
					apiKey: { in: "header", type: "apiKey" },
					jwt: { scheme: "bearer", type: "http" },
				},
			},
		)

		const result = sanitizeOpenApiSpec(spec, {
			stripSecurityRequirements: ["jwt"],
			stripSecuritySchemes: ["jwt"],
			stripXExtensions: true,
		})

		const op = result.paths["/users"].get as Record<string, unknown>
		expect(op.security).toEqual([{ apiKey: [] }])
		expect(op["x-invalidate"]).toBeUndefined()
		expect(result.components?.securitySchemes).toEqual({ apiKey: { in: "header", type: "apiKey" } })
	})

	it("no-op when options are empty", () => {
		const spec = makeSpec({
			"/users": {
				get: {
					responses: {},
					security: [{ jwt: [] }],
					"x-foo": "bar",
				},
			},
		})

		const result = sanitizeOpenApiSpec(spec, {})
		const op = result.paths["/users"].get as Record<string, unknown>
		expect(op.security).toEqual([{ jwt: [] }])
		expect(op["x-foo"]).toBe("bar")
	})

	it("does not mutate the input spec", () => {
		const spec = makeSpec({
			"/a": {
				get: {
					responses: {},
					security: [{ jwt: [] }, { apiKey: [] }],
					"x-invalidate": ["GET /a"],
				},
			},
		})

		sanitizeOpenApiSpec(spec, {
			stripSecurityRequirements: ["jwt"],
			stripXExtensions: true,
		})

		const op = spec.paths["/a"].get as Record<string, unknown>
		expect(op.security).toEqual([{ jwt: [] }, { apiKey: [] }])
		expect(op["x-invalidate"]).toEqual(["GET /a"])
	})
})
