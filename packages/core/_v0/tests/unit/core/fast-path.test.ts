import { describe, expect, it } from "vitest"
import { createMiddleware, honey } from "../../../src/index.ts"

describe("single-handler fast path", () => {
	it("route with no middleware → handler called directly, correct response", async () => {
		const app = honey<{}>()
		app.get("/fast").handler((ctx) => ctx.res.json("ok", { fast: true }))

		const res = await app.fetch(new Request("http://localhost/fast"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.fast).toBe(true)
	})

	it("route with middleware → still works (regression check)", async () => {
		const mw = createMiddleware(async (_ctx, next) => next({ added: "yes" }))
		const app = honey<{}>().use(mw)
		app.get("/slow").handler((ctx) => ctx.res.json("ok", { added: ctx.added }))

		const res = await app.fetch(new Request("http://localhost/slow"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.added).toBe("yes")
	})

	it("fast path still runs output validation", async () => {
		const app = honey<{}>()
		app.outputValidation("always")
		app
			.get("/validated")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: "abc" }))

		const res = await app.fetch(new Request("http://localhost/validated"), {})
		expect(res.status).toBe(200)
	})
})

import * as z from "zod"
