import { describe, expect, it } from "vitest"
import * as z from "zod"
import { createMiddleware, honey } from "../../../src/index.ts"

describe("input validation ordering", () => {
	it("input is validated and available in handler", async () => {
		const app = honey<{}>()
		app
			.post("/test")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", { name: ctx.input.json.name }))

		const res = await app.fetch(
			new Request("http://localhost/test", {
				body: JSON.stringify({ name: "Alice" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.name).toBe("Alice")
	})

	it("middleware runs and input is still available in handler", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			return next({ fromMw: true })
		})

		const app = honey<{}>()
		app
			.use(mw)
			.post("/test")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", { fromMw: ctx.fromMw, name: ctx.input.json.name }))

		const res = await app.fetch(
			new Request("http://localhost/test", {
				body: JSON.stringify({ name: "Bob" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.name).toBe("Bob")
		expect(body.fromMw).toBe(true)
	})

	it("invalid input rejected even with middleware in chain", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			return next({ fromMw: true })
		})

		const app = honey<{}>()
		app
			.use(mw)
			.post("/test")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", { name: ctx.input.json.name }))

		const res = await app.fetch(
			new Request("http://localhost/test", {
				body: JSON.stringify({ name: 123 }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(400)
	})

	it("route-level middleware + input both work", async () => {
		const routeMw = createMiddleware(async (_ctx, next) => {
			return next({ routeFlag: "yes" })
		})

		const app = honey<{}>()
		app
			.post("/test")
			.use(routeMw)
			.input({ json: z.object({ value: z.number() }) })
			.handler((ctx) => ctx.res.json("ok", { flag: ctx.routeFlag, value: ctx.input.json.value }))

		const res = await app.fetch(
			new Request("http://localhost/test", {
				body: JSON.stringify({ value: 42 }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.value).toBe(42)
		expect(body.flag).toBe("yes")
	})
})
