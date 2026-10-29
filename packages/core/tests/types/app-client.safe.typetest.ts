/**
 * The app-typed client's safe twin (bit 21 i1), as typed over a real app: `api.safe` answers a Result of the value
 * and the declared statuses' errors where the normal call answers the value and throws; the safe pattern the normal
 * call answered before, unchanged, and a wrong-arm read no longer compile (each `@ts-expect-error` reds the check the
 * day either does).
 */
import { describe, expectTypeOf, it } from "vitest"
import * as z from "zod"
import type { createClient } from "../../../gen/src/runtime/ts/app.ts"
import type { ErrorEnvelope } from "../../../gen/src/runtime/ts/app-types.ts"
import type { DecodeError } from "../../../gen/src/runtime/ts/error.ts"
import type { Result } from "../../../gen/src/runtime/ts/response.ts"
import { defineErrors } from "../../src/errors/errors.ts"
import { honey } from "../../src/routing/app.ts"

const row = z.object({ id: z.string(), name: z.string() })

/** A route answering a row, its 404 honey's envelope. */
const app = honey<{}>()
	.get("/users/:id")
	.output({ "application/json": { ok: row } })
	.errors(defineErrors({ not_found: "not_found" }), "not_found")
	.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id, name: "test" }))

/** A route declaring a custom-schema error from the app's factory. */
const erring = honey<{}>()
	.errorFactory(
		defineErrors({
			item_not_found: {
				schema: z.object({ reason: z.string(), suggestions: z.array(z.string()) }),
				status: "not_found",
			},
		}),
	)
	.get("/items/:id")
	.output({ "application/json": { ok: z.object({ name: z.string() }) } })
	.errors("item_not_found")
	.handler((ctx) => ctx.res.json("ok", { name: "test" }))

declare const api: ReturnType<typeof createClient<typeof app>>
declare const erringApi: ReturnType<typeof createClient<typeof erring>>

describe("the safe twin and the declared errors (bit 21 i1)", () => {
	// v0: ce81093ba0
	// v0: b797bb4a20
	it("answers a Result of the value and the declared statuses' errors; the normal call answers the value", () => {
		const id = { params: { id: "1" } }
		expectTypeOf(api.get("/users/:id", id)).toEqualTypeOf<Promise<{ id: string; name: string }>>()
		expectTypeOf(api.safe.get("/users/:id", id)).toEqualTypeOf<
			Promise<Result<{ id: string; name: string }, { 404: ErrorEnvelope<404> }>>
		>()
	})

	// v0: 680e667162
	it("narrows the Err arm by status to that status's declared error body, once DecodeError is ruled out", () => {
		type Answer = Awaited<ReturnType<typeof erringApi.safe.get<"/items/:id">>>
		expectTypeOf<Extract<Answer, { ok: true }>["data"]>().toEqualTypeOf<{ name: string }>()
		type Declared = Exclude<Extract<Answer, { ok: false }>["error"], DecodeError>
		expectTypeOf<Extract<Declared, { status: 404 }>["body"]>().toEqualTypeOf<{
			reason: string
			suggestions: string[]
		}>()
		expectTypeOf<Extract<Answer, { ok: false }>["response"]>().toEqualTypeOf<Response>()
	})

	it("refuses the safe pattern the normal client answered before, unchanged, and a wrong-arm read", async () => {
		// @ts-expect-error -- the normal client answers the value; `{ data, error }` is the safe call's no more
		const { data, error } = await api.get("/users/:id", { params: { id: "1" } })
		if (error) throw error
		void data
		const answer = await api.safe.get("/users/:id", { params: { id: "1" } })
		// @ts-expect-error -- `data` is the Ok arm's alone
		void answer.data
		expectTypeOf<Extract<typeof answer, { ok: false }>["error"]["status"]>().toEqualTypeOf<number>()
	})
})
