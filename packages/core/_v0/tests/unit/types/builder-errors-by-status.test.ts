import { describe, expectTypeOf, it } from "vitest"
import * as z from "zod"
import { honey, defineErrors } from "../../../src/index.ts"
import type { InferRoutes } from "../../../src/types.ts"
import type { ClientResult } from "../../../src/client/types.ts"
import { createClient } from "../../../src/client/index.ts"

describe("builder-inferred errorsByStatus", () => {
	const errors = defineErrors({
		api_error: "internal_server_error",
		email_taken: "conflict",
		item_not_found: {
			schema: z.object({
				reason: z.string(),
				suggestions: z.array(z.string()),
			}),
			status: "not_found",
		},
		rate_limited: {
			schema: z.object({ retry_after: z.number() }),
			status: "too_many_requests",
		},
	})

	const app = honey()
		.errorFactory(errors)
		.defaultBoundary("api_error")

		.get("/items/:id")
		.output({ "application/json": { ok: z.object({ name: z.string() }) } })
		.errors("item_not_found")
		.handler((c) => c.res.json("ok", { name: "test" }))

		.post("/register")
		.output({ "application/json": { created: z.object({ id: z.string() }) } })
		.errors("email_taken", "rate_limited")
		.handler((c) => c.res.json("created", { id: "1" }))

	type Routes = InferRoutes<typeof app>

	it("route with custom error has errorsByStatus with correct status code", () => {
		type ItemRoute = Routes["/items/:id"]["get"]
		type EBS = ItemRoute["errorsByStatus"]

		/* 404 should map to the custom schema output */
		expectTypeOf<EBS>().toHaveProperty("404")
	})

	it("route with mixed errors has multiple status codes", () => {
		type RegisterRoute = Routes["/register"]["post"]
		type EBS = RegisterRoute["errorsByStatus"]

		/* 409 for email_taken (standard → null), 429 for rate_limited (custom) */
		expectTypeOf<EBS>().toHaveProperty("409")
		expectTypeOf<EBS>().toHaveProperty("429")
	})

	it("custom error shape is inferred from schema", () => {
		type ItemRoute = Routes["/items/:id"]["get"]
		type EBS = ItemRoute["errorsByStatus"]
		type Shape404 = EBS extends { 404: infer S } ? S : never

		expectTypeOf<Shape404>().toMatchTypeOf<{
			reason: string
			suggestions: string[]
		}>()
	})

	it("standard error shape is null", () => {
		type RegisterRoute = Routes["/register"]["post"]
		type EBS = RegisterRoute["errorsByStatus"]
		type Shape409 = EBS extends { 409: infer S } ? S : never

		expectTypeOf<Shape409>().toEqualTypeOf<null>()
	})

	it("createClient safe mode error discriminates by status via errorsByStatus", () => {
		type Client = ReturnType<typeof createClient<typeof app>>

		/* This verifies the type flows through createClient → ReturnFor → ClientResult → ErrorsByStatusFor */
		type GetResult = Awaited<ReturnType<Client["get"]>>

		/* success branch */
		type SuccessBranch = Extract<GetResult, { error: null }>
		expectTypeOf<SuccessBranch["data"]>().toMatchTypeOf<{ name: string }>()

		/* error branch should include 404 */
		type ErrorBranch = Extract<GetResult, { status: 404 }>
		type Error404 = ErrorBranch["error"]
		expectTypeOf<Error404>().toMatchTypeOf<{
			reason: string
			suggestions: string[]
		}>()
	})
})
