import { describe, expect, it } from "vitest"
import * as z from "zod"
import { generateOpenApi } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"
import { testClient } from "../../../src/testing.ts"

describe("redirect output", () => {
	it("handler returning redirect responds with 302 and Location header", async () => {
		const app = honey<{}>()
		app
			.get("/go")
			.output({ redirect: { found: true } })
			.handler((c) => c.res.redirect("https://example.com/target"))

		const client = testClient(app, { env: {} })
		const res = await client.get("/go", { redirect: "manual" })

		expect(res.status).toBe(302)
		expect(res.headers.get("location")).toBe("https://example.com/target")
	})

	it("mixed JSON + redirect output generates both response codes", async () => {
		const app = honey<{}>()
		app
			.post("/login")
			.output({
				"application/json": { ok: z.object({ token: z.string() }) },
				"redirect": { found: true },
			})
			.handler((c) => c.res.json("ok", { token: "abc" }))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1.0" },
		})

		const responses = spec.paths["/login"]?.post?.responses
		expect(responses["200"]).toBeDefined()
		expect(responses["200"].content["application/json"]).toBeDefined()
		expect(responses["302"]).toEqual({
			description: "found",
			headers: {
				Location: {
					description: "Redirect target URL",
					schema: { format: "uri", type: "string" },
				},
			},
		})
	})

	it("redirect with non-302 status key generates correct code", async () => {
		const app = honey<{}>()
		app
			.get("/old-page")
			.output({ redirect: { moved_permanently: true } })
			.handler((c) => c.res.redirect("https://example.com/new", { status: 301 }))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1.0" },
		})

		const responses = spec.paths["/old-page"]?.get?.responses
		expect(responses["301"]).toEqual({
			description: "moved permanently",
			headers: {
				Location: {
					description: "Redirect target URL",
					schema: { format: "uri", type: "string" },
				},
			},
		})
	})

	it("generates OpenAPI 302 response with Location header", async () => {
		const app = honey<{}>()
		app
			.get("/oauth/callback")
			.output({ redirect: { found: true } })
			.handler((c) => c.res.redirect("https://example.com"))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1.0" },
		})

		const responses = spec.paths["/oauth/callback"]?.get?.responses
		expect(responses).toBeDefined()
		expect(responses["302"]).toEqual({
			description: "found",
			headers: {
				Location: {
					description: "Redirect target URL",
					schema: { format: "uri", type: "string" },
				},
			},
		})
	})
})
