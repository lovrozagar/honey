import { describe, expect, it } from "vitest"
import { rawBodyOf } from "../response/builder.ts"
import { HoneyError } from "./error.ts"
import { defineErrors } from "./errors.ts"
import { asHoneyError, boundaryError, createErrorResponse, projectThrown, safeErrorResponse } from "./projector.ts"

/** A minimal Standard Schema that accepts anything and types its output as `T`. */
function schemaOf<T>() {
	return {
		"~standard": {
			types: undefined as unknown as { input: T; output: T },
			validate: (value: unknown) => ({ value }),
			vendor: "test",
			version: 1 as const,
		},
	}
}

const errors = defineErrors({
	api_error: "internal_server_error",
	email_taken: "conflict",
	item_not_found: { schema: schemaOf<{ reason: string; suggestions: string[] }>(), status: "not_found" },
	rate_limited: { schema: schemaOf<{ retry_after: number }>(), status: "too_many_requests" },
	unauthorized: "unauthorized",
})

const identity = (_e: HoneyError, shape: Record<string, unknown>) => shape

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>
}

const defaultFormatter = (_error: HoneyError, defaultShape: Record<string, unknown>) => ({
	...defaultShape,
	timestamp: 1234567890,
})
const customFormatter = (_error: HoneyError, data: Record<string, unknown>) => ({ ...data, timestamp: 1234567890 })
const crashingFormatter = () => {
	throw new Error("formatter crashed")
}

describe("createErrorResponse with dual formatters", () => {
	// v0: f290147486
	it("standard error uses defaultFormatter", async () => {
		const res = createErrorResponse(
			new HoneyError({ errorKey: "email_taken", status: "conflict" }),
			defaultFormatter,
			null,
		)
		expect(res.status).toBe(409)
		const body = await bodyOf(res)
		expect(body.error_key).toBe("email_taken")
		expect(body.timestamp).toBe(1234567890)
		expect(body.success).toBe(false)
	})

	// v0: 17f03fe815
	it("custom schema error uses data as-is when no customFormatter", async () => {
		const err = new HoneyError({
			data: { reason: "not found", suggestions: ["/a"] },
			errorKey: "item_not_found",
			status: "not_found",
		})
		const res = createErrorResponse(err, defaultFormatter, null)
		expect(res.status).toBe(404)
		expect(await bodyOf(res)).toEqual({ reason: "not found", suggestions: ["/a"] })
	})

	// v0: af9d5715eb
	it("custom schema error uses customFormatter when provided", async () => {
		const err = new HoneyError({
			data: { reason: "not found", suggestions: [] },
			errorKey: "item_not_found",
			status: "not_found",
		})
		const body = await bodyOf(createErrorResponse(err, defaultFormatter, customFormatter))
		expect(body.reason).toBe("not found")
		expect(body.timestamp).toBe(1234567890)
	})

	// v0: 90cc980f6a
	it("customFormatter crash falls back to raw data", async () => {
		const err = new HoneyError({ data: { reason: "not found" }, errorKey: "item_not_found", status: "not_found" })
		expect((await bodyOf(createErrorResponse(err, defaultFormatter, crashingFormatter))).reason).toBe("not found")
	})

	// v0: f259315ca0
	it("defaultFormatter crash falls back to default shape", async () => {
		const err = new HoneyError({ errorKey: "email_taken", status: "conflict" })
		const body = await bodyOf(createErrorResponse(err, crashingFormatter, null))
		expect(body.error_key).toBe("email_taken")
		expect(body.success).toBe(false)
	})
})

describe("createErrorResponse: deep coverage", () => {
	// v0: 1d09eb9809
	it("standard error: full default shape fields present", async () => {
		const err = errors.email_taken({ vars: { email: "a@b.com" } })
		const res = createErrorResponse(err, identity, null)
		expect(await bodyOf(res)).toEqual({
			error_key: "email_taken",
			fields: {},
			message: "email_taken",
			status: 409,
			status_key: "conflict",
			success: false,
		})
		/* vars are ICU input on HoneyError, not part of the public envelope */
		expect(err.vars).toEqual({ email: "a@b.com" })
		expect(res.headers.get("content-type")).toBe("application/json")
	})

	// v0: 1ac45aa6b8
	it("standard error without vars: no vars key in body", async () => {
		expect((await bodyOf(createErrorResponse(errors.email_taken(), identity, null))).vars).toBeUndefined()
	})

	// v0: eacca419c3
	it("custom error: data serialized as-is, no default shape fields", async () => {
		const err = errors.item_not_found({ reason: "deleted", suggestions: ["/other"] })
		expect(await bodyOf(createErrorResponse(err, identity, null))).toEqual({
			reason: "deleted",
			suggestions: ["/other"],
		})
	})

	// v0: 74f1a6b55c
	it("customFormatter receives correct HoneyError and data", async () => {
		const seen: unknown[] = []
		const customFmt = (error: HoneyError, data: Record<string, unknown>) => {
			seen.push(error, data)
			return { ...data, injected: true }
		}
		const err = errors.item_not_found({ reason: "test", suggestions: ["a"] })
		const body = await bodyOf(createErrorResponse(err, identity, customFmt))
		expect(seen).toEqual([err, { reason: "test", suggestions: ["a"] }])
		expect(body).toEqual({ injected: true, reason: "test", suggestions: ["a"] })
	})

	// v0: 030f58a717
})

describe("createErrorResponse: deep coverage, formatter routing", () => {
	it("customFormatter does NOT fire for standard errors", () => {
		let customCalled = false
		createErrorResponse(errors.email_taken(), identity, (_e, data) => {
			customCalled = true
			return data
		})
		expect(customCalled).toBe(false)
	})

	// v0: f2812b3db6
	it("defaultFormatter does NOT fire for custom schema errors", () => {
		let defaultCalled = false
		const defaultFmt = (_e: HoneyError, shape: Record<string, unknown>) => {
			defaultCalled = true
			return shape
		}
		createErrorResponse(errors.item_not_found({ reason: "x", suggestions: [] }), defaultFmt, null)
		expect(defaultCalled).toBe(false)
	})

	// v0: 3b076f4db0
	it("custom error with data={} produces empty JSON object", async () => {
		const err = new HoneyError({ data: {}, errorKey: "empty", status: "bad_request" })
		expect(await bodyOf(createErrorResponse(err, identity, null))).toEqual({})
	})

	// v0: ac5d0bef7b
	it("response status matches error status for both types", () => {
		expect(createErrorResponse(errors.email_taken(), identity, null).status).toBe(409)
		expect(createErrorResponse(errors.rate_limited({ retry_after: 30 }), identity, null).status).toBe(429)
	})
})

const withRequestId = (_e: HoneyError, data: Record<string, unknown>) => ({ ...data, request_id: "req-abc" })

describe("integration: customErrorFormatter via createErrorResponse", () => {
	// v0: f33d557eb6
	it("adds fields to custom error responses", async () => {
		const appErrors = defineErrors({ item_gone: { schema: schemaOf<{ reason: string }>(), status: "gone" } })
		const body = await bodyOf(createErrorResponse(appErrors.item_gone({ reason: "removed" }), identity, withRequestId))
		expect(body).toEqual({ reason: "removed", request_id: "req-abc" })
	})
})

describe("createErrorResponse headers and raw body", () => {
	it("adds the error's headers and records the raw body", async () => {
		const err = errors.unauthorized({ headers: { "www-authenticate": "Bearer" } })
		const res = createErrorResponse(err, identity)
		expect(res.headers.get("www-authenticate")).toBe("Bearer")
		expect(res.headers.get("content-type")).toBe("application/json")
		expect(JSON.parse(String(rawBodyOf(res)))).toMatchObject({ error_key: "unauthorized" })
	})
})

describe("projectThrown: the route's error boundary", () => {
	const open = { boundaryKey: null, declared: null, factory: null }

	it("a HoneyError passes through when the route does not enforce declared errors", () => {
		const err = errors.email_taken()
		expect(projectThrown(err, open)).toBe(err)
	})

	it("an unknown throw becomes a 500 carrying it as cause", () => {
		const cause = new Error("boom")
		const err = projectThrown(cause, open)
		expect(err).toMatchObject({ errorKey: "internal_server_error", status: 500 })
		expect(err.cause).toBe(cause)
	})

	it("a declared or framework key passes an enforcing route", () => {
		const policy = { boundaryKey: null, declared: new Set(["email_taken"]), factory: null }
		const declared = errors.email_taken()
		const framework = new HoneyError({ errorKey: "validation_failed", status: "bad_request" })
		expect(projectThrown(declared, policy)).toBe(declared)
		expect(projectThrown(framework, policy)).toBe(framework)
	})

	it("an undeclared key on an enforcing route becomes a 500, or the boundary error", () => {
		const undeclared = errors.unauthorized()
		const plain = projectThrown(undeclared, { boundaryKey: null, declared: new Set(["email_taken"]), factory: null })
		expect(plain).toMatchObject({ errorKey: "internal_server_error", status: 500 })
		expect(plain.cause).toBe(undeclared)
		const policy = { boundaryKey: "api_error", declared: new Set(["email_taken"]), factory: errors }
		const bounded = projectThrown(undeclared, policy)
		expect(bounded).toMatchObject({ errorKey: "api_error", status: 500 })
		expect(bounded.cause).toBe(undeclared)
	})

	it("an unknown throw takes the boundary error when one is set", () => {
		const policy = { boundaryKey: "api_error", declared: null, factory: errors }
		expect(projectThrown("oops", policy)).toMatchObject({ cause: "oops", errorKey: "api_error" })
	})
})

describe("boundaryError and asHoneyError", () => {
	it("builds the boundary from the factory's standard error", () => {
		const err = boundaryError("unauthorized", "c", errors)
		expect(err).toMatchObject({ cause: "c", errorKey: "unauthorized", status: 401 })
	})

	it("a schema error, or a key the factory lacks, becomes a plain 500 with that key", () => {
		expect(boundaryError("item_not_found", "c", errors)).toMatchObject({
			cause: "c",
			errorKey: "item_not_found",
			status: 500,
		})
		expect(boundaryError("missing", "c", errors)).toMatchObject({ errorKey: "missing", status: 500 })
		expect(boundaryError("missing", "c", null)).toMatchObject({ errorKey: "missing", status: 500 })
	})

	it("asHoneyError keeps a HoneyError and wraps anything else as a 500", () => {
		const err = errors.email_taken()
		expect(asHoneyError(err)).toBe(err)
		expect(asHoneyError(1)).toMatchObject({ cause: 1, errorKey: "internal_server_error", status: 500 })
	})
})

describe("safeErrorResponse: the last resort", () => {
	it("answers a HoneyError with its own response, anything else with a bare 500", async () => {
		expect(safeErrorResponse(errors.email_taken(), identity, null).status).toBe(409)
		const res = safeErrorResponse(new Error("secret"), identity, null)
		expect(res.status).toBe(500)
		expect(JSON.stringify(await bodyOf(res))).not.toContain("secret")
	})

	it("answers a fixed 500 when even the response cannot be built", async () => {
		const unserializable = new HoneyError({ data: { n: 1n }, errorKey: "x", status: "bad_request" })
		const res = safeErrorResponse(unserializable, identity, null)
		expect(res.status).toBe(500)
		expect(await bodyOf(res)).toEqual({ error: { errorKey: "internal_server_error" } })
	})
})
