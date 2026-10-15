import { describe, expect, it } from "vitest"
import { honey } from "../routing/app.ts"
import { SWAGGER_UI } from "./docs-page.ts"
import { swagger } from "./swagger.ts"

/** The HTML `handler` answers at /docs. */
async function page(handler: unknown): Promise<Response> {
	const app = honey<{}>()
	app.get("/docs").handler(handler as never)
	return app.fetch(new Request("http://x/docs"), {})
}

describe("swagger(): the Swagger UI page", () => {
	// v0: ce4f4208dc
	// v0: f69747f897
	// v0: 5cd02031b8
	// v0: 1779526a3b
	it("is a handler answering HTML that loads the pinned Swagger UI CSS and script with their integrity hashes, under CSP and nosniff", async () => {
		const handler = swagger({ url: "/openapi.json" })
		const res = await page(handler)
		const html = await res.text()
		expect([
			typeof handler,
			res.status,
			res.headers.get("content-type"),
			html.includes(`href="${SWAGGER_UI.css.url}" integrity="${SWAGGER_UI.css.integrity}"`),
			html.includes(`src="${SWAGGER_UI.js.url}" integrity="${SWAGGER_UI.js.integrity}"`),
			SWAGGER_UI.js.url,
			res.headers.get("content-security-policy") !== null,
			res.headers.get("x-content-type-options"),
		]).toEqual([
			"function",
			200,
			expect.stringContaining("text/html"),
			true,
			true,
			expect.stringMatching(/swagger-ui-dist@\d+\.\d+\.\d+\//),
			true,
			"nosniff",
		])
	})

	// v0: 828861313f
	// v0: 26d82bbb98
	it("points at the document URL it is given and embeds the rest of its config", async () => {
		const html = await (await page(swagger({ deepLinking: true, url: "/api/spec.json" }))).text()
		expect([html.includes('"url":"/api/spec.json"'), html.includes('"deepLinking":true')]).toEqual([true, true])
	})
})
