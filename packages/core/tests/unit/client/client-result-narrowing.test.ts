import { describe, expect, expectTypeOf, it } from "vitest"
import * as z from "zod"
import type { ClientResult } from "../../../src/client/types.ts"
import { honey } from "../../../src/index.ts"
import { defineErrors } from "../../../src/errors.ts"
import { createClient } from "../../../src/client/index.ts"

describe("ClientResult type narrowing", () => {
	it("without TErrorsByStatus: error is unknown (raw parsed body)", () => {
		type R = ClientResult<{ id: string }>
		type ErrorBranch = Extract<R, { data: null }>

		/* error should be unknown (raw parsed body, not ClientError) */
		expectTypeOf<ErrorBranch["error"]>().toEqualTypeOf<unknown>()
	})

	it("with TErrorsByStatus: error discriminated by status", () => {
		type Errors = {
			404: { reason: string }
			409: { error_key: string; message: string }
		}
		type R = ClientResult<{ id: string }, Errors>

		/* success branch */
		type SuccessBranch = Extract<R, { error: null }>
		expectTypeOf<SuccessBranch["data"]>().toMatchTypeOf<{ id: string }>()

		/* 404 branch */
		type Branch404 = Extract<R, { status: 404 }>
		expectTypeOf<Branch404["error"]>().toMatchTypeOf<{ reason: string }>()

		/* 409 branch */
		type Branch409 = Extract<R, { status: 409 }>
		expectTypeOf<Branch409["error"]>().toMatchTypeOf<{ error_key: string; message: string }>()
	})

	it("null errorsByStatus maps to the default envelope so if (error) narrows", () => {
		type R = ClientResult<{ ping: "pong" }, { 400: null; 401: null }>

		function check(r: R) {
			if (r.error) {
				expectTypeOf(r.data).toEqualTypeOf<null>()
				expectTypeOf(r.error.error_key).toEqualTypeOf<string>()
				expectTypeOf(r.error.status).toEqualTypeOf<400 | 401>()
				return
			}
			expectTypeOf(r.data).toEqualTypeOf<{ ping: "pong" }>()
		}

		void check
	})

	it("if (!error) narrows data when errorsByStatus is present", () => {
		type R = ClientResult<{ id: string }, { 404: { reason: string } }>

		function check(r: R) {
			if (!r.error) {
				expectTypeOf(r.data).toEqualTypeOf<{ id: string }>()
				return
			}
			expectTypeOf(r.error).toEqualTypeOf<{ reason: string }>()
		}

		void check
	})
})

describe("ClientResult runtime with createClient", () => {
	const appErrors = defineErrors({
		api_error: "internal_server_error",
		email_taken: "conflict",
		item_not_found: {
			schema: z.object({ reason: z.string() }),
			status: "not_found",
		},
	})

	const app = honey()
		.errorFactory(appErrors)
		.defaultBoundary("api_error")

		.get("/items/:id")
		.output({ "application/json": { ok: z.object({ name: z.string() }) } })
		.errors("item_not_found")
		.handler((c) => c.res.json("ok", { name: "test" }))

		.post("/register")
		.output({ "application/json": { created: z.object({ id: z.string() }) } })
		.errors("email_taken")
		.handler((c) => c.res.json("created", { id: "1" }))

	const client = createClient<typeof app>({
		baseURL: "http://localhost",
		fetch: (input, init) => app.fetch(new Request(input, init)),
	})

	it("success response: data typed, error null", async () => {
		const r = await client.get("/items/:id", { params: { id: "1" } })
		if (r.data) {
			expect(r.data.name).toBe("test")
			expect(r.error).toBeNull()
		}
	})

	it("custom error: error has schema payload directly", async () => {
		/* make it fail by overriding the handler behavior isn't easy, so test the type */
		const appFail = honey()
			.errorFactory(appErrors)
			.defaultBoundary("api_error")
			.get("/fail")
			.errors("item_not_found")
			.handler(() => { throw appErrors.item_not_found({ reason: "deleted" }) })

		const failClient = createClient<typeof appFail>({
			baseURL: "http://localhost",
			fetch: (input, init) => appFail.fetch(new Request(input, init)),
		})

		const r = await failClient.get("/fail")
		expect(r.error).not.toBeNull()
		expect(r.status).toBe(404)
		expect(r.error.reason).toBe("deleted")
	})

	it("standard error: error has default shape directly", async () => {
		const appFail = honey()
			.errorFactory(appErrors)
			.defaultBoundary("api_error")
			.post("/fail")
			.errors("email_taken")
			.handler(() => { throw appErrors.email_taken() })

		const failClient = createClient<typeof appFail>({
			baseURL: "http://localhost",
			fetch: (input, init) => appFail.fetch(new Request(input, init)),
		})

		const r = await failClient.post("/fail")
		expect(r.error).not.toBeNull()
		expect(r.status).toBe(409)
		expect(r.error.error_key).toBe("email_taken")
	})
})
