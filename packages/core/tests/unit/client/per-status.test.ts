import { describe, expectTypeOf, it } from "vitest"
import * as z from "zod"
import type { OutputFor } from "../../../src/client/types.ts"
import { honey } from "../../../src/index.ts"

const app = honey<{}>()
	/* single status — data is just the type */
	.get("/simple")
	.output({ "application/json": { ok: z.object({ id: z.string() }) } })
	.handler((ctx) => ctx.res.json("ok", { id: "1" }))

	/* multi status — data is union with status */
	.post("/orgs")
	.input({ json: z.object({ name: z.string() }) })
	.output({
		"application/json": {
			conflict: z.object({ existingId: z.string(), message: z.string() }),
			created: z.object({ id: z.string(), name: z.string() }),
		},
	})
	.handler((ctx) => ctx.res.json("created", { id: "1", name: ctx.input.json.name }))

	/* three statuses */
	.post("/jobs")
	.input({ json: z.object({ task: z.string() }) })
	.output({
		"application/json": {
			accepted: z.object({ eta: z.number(), jobId: z.string() }),
			bad_request: z.object({ reason: z.string() }),
			ok: z.object({ result: z.string() }),
		},
	})
	.handler((ctx) => ctx.res.json("ok", { result: "done" }))

type Routes = (typeof app)["$routes"]

describe("per-status discriminated unions", () => {
	it("single status — OutputFor is just the data type", () => {
		type O = OutputFor<Routes, "/simple", "get">
		expectTypeOf<O>().toEqualTypeOf<{ id: string }>()
	})

	it("multi status — OutputFor is union of both data types", () => {
		type O = OutputFor<Routes, "/orgs", "post">
		/* union: created | conflict */
		expectTypeOf<{ id: string; name: string }>().toMatchTypeOf<O>()
		expectTypeOf<{ existingId: string; message: string }>().toMatchTypeOf<O>()
	})

	it("three statuses — OutputFor is union of all three", () => {
		type O = OutputFor<Routes, "/jobs", "post">
		expectTypeOf<{ eta: number; jobId: string }>().toMatchTypeOf<O>()
		expectTypeOf<{ reason: string }>().toMatchTypeOf<O>()
		expectTypeOf<{ result: string }>().toMatchTypeOf<O>()
	})
})
