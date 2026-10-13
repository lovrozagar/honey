import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { testClient } from "../../../src/testing.ts"
import { SWAGGER_UI } from "../../../src/openapi/docs-page.ts"
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
		/* pinned and integrity-checked, not just "some CDN" */
		expect(html).toContain(`href="${SWAGGER_UI.css.url}" integrity="${SWAGGER_UI.css.integrity}"`)
		expect(html).toContain(`src="${SWAGGER_UI.js.url}" integrity="${SWAGGER_UI.js.integrity}"`)
		expect(SWAGGER_UI.js.url).toMatch(/swagger-ui-dist@\d+\.\d+\.\d+\//)
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
