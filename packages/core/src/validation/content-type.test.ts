import { describe, expect, it } from "vitest"
import { HoneyError } from "../errors/error.ts"
import { assertBodySchemaAllowed, assertRequestContentType } from "./content-type.ts"

/** What a route declares, by source. */
type Declared = Record<string, unknown>

const schema = { "~standard": { validate: (value: unknown) => ({ value }), vendor: "test", version: 1 as const } }

/** The error `run` throws. */
function thrown(run: () => unknown): HoneyError {
	try {
		run()
	} catch (error) {
		return error as HoneyError
	}
	throw new Error("did not throw")
}

describe("assertRequestContentType: the request's media type against the declared body", () => {
	// v0: ce623025bb
	// v0: 9762fb29e6
	// v0: a61103ff4b
	// v0: 8cd96a7dcc
	it("selects the declared parser by essence, whatever the case, suffix or parameters, without reading the body", () => {
		expect(
			[
				["application/json", { json: schema }],
				["Application/JSON; charset=utf-8", { json: schema }],
				["application/vnd.api+json; v=2", { json: schema }],
				["multipart/form-data; boundary=x", { form: schema }],
				["application/x-www-form-urlencoded;charset=UTF-8", { form: schema }],
			].map(([type, schemas]) => assertRequestContentType(schemas as Declared, type as string)),
		).toEqual(["json", "json", "json", "multipart", "urlencoded"])
	})

	// v0: 5cd2919a23
	it("is nothing to check when no body is declared, whatever the request sends", () => {
		expect([assertRequestContentType({ params: schema }, null), assertRequestContentType({}, "text/plain")]).toEqual([
			null,
			null,
		])
	})

	// v0: 9ac7557424
	// v0: 25619bfc94
	// v0: 5bc2a22732
	// v0: 3269311f19
	// v0: 9b8b8cb2ae
	// v0: c677f09f6a
	// v0: 057408633c
	// v0: fa158866cc
	it.each<[string | null, Declared]>([
		["text/plain", { json: schema }],
		[null, { json: schema }],
		["application/jsonx", { json: schema }],
		["application/json-patch", { json: schema }],
		["json", { json: schema }],
		["application/json, text/plain", { json: schema }],
		["text/plain", { form: schema }],
		["application/json", { form: schema }],
		["multipart/mixed; boundary=x", { form: schema }],
	])("%j where %o is declared is a 415 unsupported_media_type", (type, schemas) => {
		const error = thrown(() => assertRequestContentType(schemas, type))
		expect([error instanceof HoneyError, error.status, error.errorKey]).toEqual([true, 415, "unsupported_media_type"])
	})
})

describe("assertBodySchemaAllowed: a body schema the route can never receive", () => {
	// v0: 5c9fc8be95
	it("refuses a json or form schema on a route only GET or HEAD reach, naming the route", () => {
		expect([
			thrown(() => assertBodySchemaAllowed({ json: schema }, ["GET"], "/x")).message,
			thrown(() => assertBodySchemaAllowed({ form: schema }, ["HEAD"], "/x")).message,
			thrown(() => assertBodySchemaAllowed({ json: schema }, ["GET", "HEAD"], "/y")).message,
		]).toEqual([
			"GET /x declares a json body schema, but GET requests have no body. Validate query data with `search`, or register the route for a method that carries a body.",
			"HEAD /x declares a form body schema, but HEAD requests have no body. Validate query data with `search`, or register the route for a method that carries a body.",
			"GET /y declares a json body schema, but GET requests have no body. Validate query data with `search`, or register the route for a method that carries a body.",
		])
	})

	it("allows a body schema on every other method, on a route that also takes GET, and any non-body schema on GET", () => {
		expect(() => {
			assertBodySchemaAllowed({ json: schema }, ["DELETE"], "/x")
			assertBodySchemaAllowed({ form: schema }, ["OPTIONS"], "/x")
			assertBodySchemaAllowed({ json: schema }, ["GET", "POST"], "/x")
			assertBodySchemaAllowed({ cookies: schema, headers: schema, params: schema, search: schema }, ["GET"], "/x")
		}).not.toThrow()
	})

	it("refuses json and form together: a request carries one body", () => {
		expect(thrown(() => assertBodySchemaAllowed({ form: schema, json: schema }, ["POST"], "/x")).message).toBe(
			"POST /x declares more than one body (form, json); a request carries one body.",
		)
	})
})
