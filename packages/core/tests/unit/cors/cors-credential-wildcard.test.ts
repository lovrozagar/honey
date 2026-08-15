import { describe, expect, it } from "vitest"
import { cors } from "../../../src/cors.ts"
import { honey } from "../../../src/index.ts"

describe("CORS credentials + wildcard origin", () => {
	it("credentials:true with origin:* should NOT send Allow-Origin: *", async () => {
		const h = honey<{}>()
		const chain = h.use(cors({ credentials: true, origin: "*" }))
		chain.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await h.fetch(
			new Request("http://localhost/test", {
				headers: { origin: "http://example.com" },
			}),
			{},
		)

		/* Must echo back the specific origin, not * */
		expect(res.headers.get("access-control-allow-origin")).not.toBe("*")
		expect(res.headers.get("access-control-allow-origin")).toBe("http://example.com")
		expect(res.headers.get("access-control-allow-credentials")).toBe("true")
		expect(res.headers.get("vary")).toContain("Origin")
	})

	it("credentials:true with origin:* preflight should NOT send Allow-Origin: *", async () => {
		const h = honey<{}>()
		const chain = h.use(cors({ credentials: true, origin: "*" }))
		chain.all("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await h.fetch(
			new Request("http://localhost/test", {
				headers: {
					"access-control-request-method": "POST",
					origin: "http://example.com",
				},
				method: "OPTIONS",
			}),
			{},
		)

		expect(res.status).toBe(204)
		expect(res.headers.get("access-control-allow-origin")).not.toBe("*")
		expect(res.headers.get("access-control-allow-origin")).toBe("http://example.com")
		expect(res.headers.get("vary")).toContain("Origin")
	})

	it("credentials:true with origin:undefined (default) should NOT send Allow-Origin: *", async () => {
		const h = honey<{}>()
		const chain = h.use(cors({ credentials: true }))
		chain.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await h.fetch(
			new Request("http://localhost/test", {
				headers: { origin: "http://example.com" },
			}),
			{},
		)

		expect(res.headers.get("access-control-allow-origin")).not.toBe("*")
		expect(res.headers.get("access-control-allow-origin")).toBe("http://example.com")
	})
})
