import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { timeout } from "../../../src/timeout.ts"

describe("timeout middleware — internal", () => {
	it("handler exceeding timeout → 504", async () => {
		const app = honey<{}>().use(timeout({ duration: 50 }))
		app.get("/slow").handler(async (ctx) => {
			await new Promise((r) => setTimeout(r, 200))
			return ctx.res.text("ok", "done")
		})

		const res = await app.fetch(new Request("http://localhost/slow"), {})
		expect(res.status).toBe(504)
	})

	it("fast handler → normal response", async () => {
		const app = honey<{}>().use(timeout({ duration: 100 }))
		app.get("/fast").handler((ctx) => ctx.res.text("ok", "fast"))

		const res = await app.fetch(new Request("http://localhost/fast"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("fast")
	})

	it("timeout through nested middleware chain", async () => {
		const app = honey<{}>().use(timeout({ duration: 50 }))
		const chain = app.use(async (_ctx, next) => next())
		chain.get("/deep").handler(async (ctx) => {
			await new Promise((r) => setTimeout(r, 200))
			return ctx.res.text("ok", "done")
		})

		const res = await app.fetch(new Request("http://localhost/deep"), {})
		expect(res.status).toBe(504)
	})

	it("handler error (not timeout) propagates normally", async () => {
		const app = honey<{}>().use(timeout({ duration: 500 }))
		app.get("/err").handler(() => {
			throw new Error("handler crash")
		})

		const res = await app.fetch(new Request("http://localhost/err"), {})
		expect(res.status).toBe(500)
	})
})

describe("timeout middleware — consumer", () => {
	it("timeout error has request_timeout error key", async () => {
		const app = honey<{}>().use(timeout({ duration: 30 }))
		app.get("/slow").handler(async (ctx) => {
			await new Promise((r) => setTimeout(r, 200))
			return ctx.res.text("ok", "done")
		})

		const res = await app.fetch(new Request("http://localhost/slow"), {})
		expect(res.status).toBe(504)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("request_timeout")
	})

	it("fast endpoint unaffected", async () => {
		const app = honey<{}>().use(timeout({ duration: 1000 }))
		app.get("/ok").handler((ctx) => ctx.res.json("ok", { fast: true }))

		const res = await app.fetch(new Request("http://localhost/ok"), {})
		expect(res.status).toBe(200)
	})
})
