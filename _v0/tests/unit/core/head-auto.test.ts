import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"

describe("HEAD auto-handling", () => {
	it("HEAD to GET-only route → 200, empty body, correct headers", async () => {
		const app = honey<{}>()
		app.get("/health").handler((ctx) => ctx.res.json("ok", { status: "healthy" }))

		const res = await app.fetch(new Request("http://localhost/health", { method: "HEAD" }), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("application/json")
		/* HEAD must have empty body */
		expect(await res.text()).toBe("")
	})

	it("HEAD with explicit HEAD handler → uses HEAD handler", async () => {
		const app = honey<{}>()
		app.get("/data").handler((ctx) => ctx.res.json("ok", { from: "get" }))
		app.head("/data").handler((ctx) => ctx.res.noContent())

		const res = await app.fetch(new Request("http://localhost/data", { method: "HEAD" }), {})
		expect(res.status).toBe(204)
	})

	it("HEAD to unknown route → 404", async () => {
		const app = honey<{}>()
		app.get("/exists").handler((ctx) => ctx.res.text("ok", "hi"))

		const res = await app.fetch(new Request("http://localhost/nope", { method: "HEAD" }), {})
		expect(res.status).toBe(404)
	})
})
