import { describe, expect, it } from "vitest"
import { honey } from "../../src/routing/app.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"

describe("error handling stress", () => {
	// v0: 3bffd4af3d
	it("error in middleware → caught by framework", async () => {
		const app = honey<{}>()
		const badMw = createMiddleware(async () => {
			throw new Error("middleware exploded")
		})

		app
			.use(badMw)
			.get("/test")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
	})
})

describe("handler returns null/undefined", () => {
	// v0: 866c9b8ca8
	it("handler returning undefined → middleware catches with helpful error", async () => {
		const app = honey<{}>()
		app.get("/test").handler(() => {
			/* forgot to return */
			return undefined as never
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
	})
})
