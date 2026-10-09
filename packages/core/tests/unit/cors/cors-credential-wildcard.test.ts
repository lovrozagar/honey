import { describe, expect, it } from "vitest"
import { cors } from "../../../src/cors.ts"
import { honey } from "../../../src/index.ts"

/* Credentialed CORS with a wildcard used to echo any Origin (including `null`)
 * with `Access-Control-Allow-Credentials: true`, so any site could read
 * authenticated responses. It now needs an explicit allow-list. */
describe("CORS credentials need an explicit origin", () => {
	it("credentials:true with origin:* throws at construction", () => {
		expect(() => cors({ credentials: true, origin: "*" })).toThrow(/explicit `origin`/)
	})

	it("credentials:true with no origin throws at construction", () => {
		expect(() => cors({ credentials: true })).toThrow(/explicit `origin`/)
	})

	it("credentials:true with an allow-list echoes only listed origins", async () => {
		const h = honey<{}>()
		const chain = h.use(cors({ credentials: true, origin: ["http://app.example.com"] }))
		chain.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const ok = await h.fetch(
			new Request("http://localhost/test", { headers: { origin: "http://app.example.com" } }),
			{},
		)
		expect(ok.headers.get("access-control-allow-origin")).toBe("http://app.example.com")
		expect(ok.headers.get("access-control-allow-credentials")).toBe("true")
		expect(ok.headers.get("vary")).toContain("Origin")

		const evil = await h.fetch(new Request("http://localhost/test", { headers: { origin: "http://evil.example" } }), {})
		expect(evil.headers.get("access-control-allow-origin")).toBeNull()
		expect(evil.headers.get("access-control-allow-credentials")).toBeNull()
		expect(evil.headers.get("vary")).toContain("Origin")
	})

	it("a predicate that accepts everything still never reflects `null`", async () => {
		const h = honey<{}>()
		const chain = h.use(cors({ credentials: true, origin: () => true }))
		chain.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await h.fetch(new Request("http://localhost/test", { headers: { origin: "null" } }), {})
		expect(res.headers.get("access-control-allow-origin")).toBeNull()
		expect(res.headers.get("access-control-allow-credentials")).toBeNull()
	})
})
