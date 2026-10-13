import { describe, expect, it, vi } from "vitest"
import { honey } from "../../src/index.ts"
import type { LogData } from "../../src/logger.ts"
import { logger } from "../../src/logger.ts"

describe("logger middleware — integration", () => {
	it("logs on real HTTP request through full app", async () => {
		const logFn = vi.fn()
		const app = honey<{}>().use(logger({ log: logFn }))
		app.get("/api/users").handler((ctx) => ctx.res.json("ok", { users: [] }))
		app.get("/api/users/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))
		app.post("/api/users").handler((ctx) => ctx.res.json("created", { id: "new" }))

		await app.fetch(new Request("http://localhost/api/users"), {})
		expect(logFn).toHaveBeenCalledTimes(1)
		const d1 = logFn.mock.calls[0][0] as LogData
		expect(d1.method).toBe("GET")
		expect(d1.path).toBe("/api/users")
		expect(d1.status).toBe(200)

		await app.fetch(new Request("http://localhost/api/users/42"), {})
		expect(logFn).toHaveBeenCalledTimes(2)
		const d2 = logFn.mock.calls[1][0] as LogData
		expect(d2.path).toBe("/api/users/42")

		await app.fetch(new Request("http://localhost/api/users", { method: "POST" }), {})
		expect(logFn).toHaveBeenCalledTimes(3)
		const d3 = logFn.mock.calls[2][0] as LogData
		expect(d3.method).toBe("POST")
		expect(d3.status).toBe(201)
	})

	it("logger composes with other middleware", async () => {
		const logFn = vi.fn()
		const app = honey<{}>().use(logger({ log: logFn }))
		app.get("/test").handler((ctx) => ctx.res.json("ok", { ok: true }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		expect(logFn).toHaveBeenCalledOnce()
	})
})
