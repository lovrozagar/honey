import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { testClient } from "../../../src/testing.ts"
import { swagger } from "../../../src/openapi/swagger.ts"

describe("swagger", () => {
	it("returns a handler function", () => {
		const handler = swagger({ url: "/openapi/json" })
		expect(typeof handler).toBe("function")
	})

	it("GET /openapi/swagger → 200 with text/html", async () => {
		const app = honey<{}>()
		app.get("/openapi/swagger").handler(swagger({ url: "/openapi/json" }))
		const client = testClient(app, { env: {} })
		const res = await client.get("/openapi/swagger")
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toContain("text/html")
	})

	it("HTML contains swagger-ui CDN references (CSS + JS)", async () => {
		const app = honey<{}>()
		app.get("/openapi/swagger").handler(swagger({ url: "/openapi/json" }))
		const client = testClient(app, { env: {} })
		const res = await client.get("/openapi/swagger")
		const html = await res.text()
		expect(html).toContain("unpkg.com/swagger-ui-dist")
		expect(html).toContain("swagger-ui.css")
		expect(html).toContain("swagger-ui-bundle.js")
	})

	it("HTML contains the spec URL from config", async () => {
		const app = honey<{}>()
		app.get("/docs").handler(swagger({ url: "/api/spec.json" }))
		const client = testClient(app, { env: {} })
		const res = await client.get("/docs")
		const html = await res.text()
		expect(html).toContain("/api/spec.json")
	})

	it("custom config (deepLinking) is embedded in HTML", async () => {
		const app = honey<{}>()
		app.get("/docs").handler(swagger({ deepLinking: true, url: "/openapi/json" }))
		const client = testClient(app, { env: {} })
		const res = await client.get("/docs")
		const html = await res.text()
		expect(html).toContain("deepLinking")
	})
})
