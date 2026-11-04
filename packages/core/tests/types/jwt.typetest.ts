/**
 * `verifyJwt` as typed (plan 39 7.3): with a `schema`, a success's payload is the schema's output; without one, it is
 * the raw claims. A refusal carries no payload either way. Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import * as z from "zod"
import { type JwtPayload, type JwtVerifyError, type JwtVerifyResult, verifyJwt } from "../../src/security/jwt.ts"

const claims = z.object({ role: z.enum(["admin", "member"]), sub: z.string() })
const options = { algorithms: ["HS256"], secret: "s" } as const

describe("verifyJwt: the payload's type", () => {
	it("is the schema's output with a schema, and the raw claims without one", () => {
		expectTypeOf(verifyJwt("t", { ...options, schema: claims })).resolves.toEqualTypeOf<
			JwtVerifyResult<{ role: "admin" | "member"; sub: string }>
		>()
		expectTypeOf(verifyJwt("t", options)).resolves.toEqualTypeOf<JwtVerifyResult<JwtPayload>>()
		expectTypeOf<JwtVerifyResult>().toEqualTypeOf<JwtVerifyResult<JwtPayload>>()
	})

	it("narrows to the payload on success and to the error on refusal", async () => {
		const result = await verifyJwt("t", { ...options, schema: claims })
		if (result.success) expectTypeOf(result.payload.role).toEqualTypeOf<"admin" | "member">()
		else expectTypeOf(result.error).toEqualTypeOf<JwtVerifyError>()
	})

	it("refuses a schema that is not a Standard Schema", () => {
		// @ts-expect-error: a schema is a Standard Schema
		expectTypeOf(verifyJwt("t", { ...options, schema: { parse: () => ({}) } })).resolves.toBeObject()
	})
})
