import { describe, expect, it } from "vitest"
import { cors } from "../../../src/cors.ts"
import { honey } from "../../../src/index.ts"

describe("CORS Vary header with array origin", () => {
	it("array origin should set Vary: Origin on actual request", async () => {
		const h = honey<{}>()
		const chain = h.use(cors({ origin: ["http://a.com", "http://b.com"] }))
		chain.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await h.fetch(
			new Request("http://localhost/test", {
				headers: { origin: "http://a.com" },
			}),
			{},
		)

		expect(res.headers.get("access-control-allow-origin")).toBe("http://a.com")
		expect(res.headers.get("vary")).toContain("Origin")
	})

	it("array origin should set Vary: Origin on preflight", async () => {
		const h = honey<{}>()
		const chain = h.use(cors({ origin: ["http://a.com", "http://b.com"] }))
		chain.all("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await h.fetch(
			new Request("http://localhost/test", {
				headers: {
					"access-control-request-method": "POST",
					origin: "http://a.com",
				},
				method: "OPTIONS",
			}),
			{},
		)

		expect(res.status).toBe(204)
		expect(res.headers.get("vary")).toContain("Origin")
	})
})
