import { describe, expect, it } from "vitest"
import { honey } from "../routing/app.ts"
import { SCALAR } from "./docs-page.ts"
import { scalar } from "./scalar.ts"

/** The HTML `handler` answers at /docs. */
async function page(handler: unknown): Promise<Response> {
	const app = honey<{}>()
	app.get("/docs").handler(handler as never)
	return app.fetch(new Request("http://x/docs"), {})
}

describe("scalar(): the Scalar API reference page", () => {
	// v0: 1869939a4f
	// v0: 1218278023
	// v0: fa4f3f7a15
	it("is a handler answering HTML that loads the pinned Scalar script with its integrity hash", async () => {
		const handler = scalar({ url: "/openapi.json" })
		const res = await page(handler)
		expect([
			typeof handler,
			res.status,
			res.headers.get("content-type"),
			(await res.text()).includes(`src="${SCALAR.js.url}" integrity="${SCALAR.js.integrity}"`),
			SCALAR.js.url,
		]).toEqual([
			"function",
			200,
			expect.stringContaining("text/html"),
			true,
			expect.stringMatching(/@scalar\/api-reference@\d+\.\d+\.\d+\//),
		])
	})

	// v0: bf82ad0a0f
	// v0: 6c85324da4
	it("points at the document URL it is given and embeds the rest of its config", async () => {
		const html = await (await page(scalar({ theme: "purple", url: "/api/spec.json" }))).text()
		expect([html.includes('"url":"/api/spec.json"'), html.includes('"theme":"purple"')]).toEqual([true, true])
	})
})
