import { describe, expect, it } from "vitest"
import * as z from "zod"
import { honey } from "../../../src/index.ts"
import { defineErrors } from "../../../src/errors.ts"
import { generateTypes } from "../../../src/codegen.ts"

describe("generateTypes: error shapes in codegen output", () => {
	it("standard errors emit string union for errors field", () => {
		const errors = defineErrors({
			api_error: "internal_server_error",
			email_taken: "conflict",
			not_found: "not_found",
		})

		const app = honey()
			.errorFactory(errors)
			.defaultBoundary("api_error")
			.get("/test")
			.errors("email_taken", "not_found")
			.handler((c) => c.res.json("ok", {}))

		const output = generateTypes(app, {
			appExport: "app",
			appImport: "../app",
		})

		/* errors field should still have the string union */
		expect(output).toContain('"email_taken" | "not_found"')
	})

	it("emits errorShapes with per-error-key shape map", () => {
		const errors = defineErrors({
			api_error: "internal_server_error",
			email_taken: "conflict",
			item_not_found: {
				schema: z.object({
					reason: z.string(),
					suggestions: z.array(z.string()),
				}),
				status: "not_found",
			},
		})

		const app = honey()
			.errorFactory(errors)
			.defaultBoundary("api_error")
			.get("/items/:id")
			.errors("email_taken", "item_not_found")
			.handler((c) => c.res.json("ok", {}))

		const output = generateTypes(app, {
			appExport: "app",
			appImport: "../app",
		})

		/* should contain errorShapes field */
		expect(output).toContain("errorShapes:")
		/* item_not_found should have the custom schema shape */
		expect(output).toContain("item_not_found:")
		expect(output).toContain("reason:")
		expect(output).toContain("suggestions:")
	})

	it("emits errorsByStatus mapping status codes to shapes", () => {
		const errors = defineErrors({
			api_error: "internal_server_error",
			email_taken: "conflict",
			item_not_found: {
				schema: z.object({ reason: z.string() }),
				status: "not_found",
			},
		})

		const app = honey()
			.errorFactory(errors)
			.defaultBoundary("api_error")
			.get("/items/:id")
			.errors("email_taken", "item_not_found")
			.handler((c) => c.res.json("ok", {}))

		const output = generateTypes(app, {
			appExport: "app",
			appImport: "../app",
		})

		/* should contain errorsByStatus mapping */
		expect(output).toContain("errorsByStatus:")
		expect(output).toContain("404:")
		expect(output).toContain("409:")
	})

	it("RouteErrorShapes extractor type is emitted", () => {
		const errors = defineErrors({
			api_error: "internal_server_error",
			not_found: "not_found",
		})

		const app = honey()
			.errorFactory(errors)
			.defaultBoundary("api_error")
			.get("/test")
			.errors("not_found")
			.handler((c) => c.res.json("ok", {}))

		const output = generateTypes(app, {
			appExport: "app",
			appImport: "../app",
		})

		expect(output).toContain("RouteErrorShapes")
	})

	it("standard-only routes emit null for custom shapes", () => {
		const errors = defineErrors({
			api_error: "internal_server_error",
			email_taken: "conflict",
		})

		const app = honey()
			.errorFactory(errors)
			.defaultBoundary("api_error")
			.get("/test")
			.errors("email_taken")
			.handler((c) => c.res.json("ok", {}))

		const output = generateTypes(app, {
			appExport: "app",
			appImport: "../app",
		})

		/* standard errors should have null shape in errorShapes */
		expect(output).toContain("errorShapes:")
		expect(output).toContain("email_taken: null")
	})

	it("no errors declared: errors stays never, no errorShapes in route entry", () => {
		const app = honey()
			.get("/test")
			.handler((c) => c.res.json("ok", {}))

		const output = generateTypes(app, {
			appExport: "app",
			appImport: "../app",
		})

		expect(output).toContain("errors: never")
		/* route entry should NOT have errorShapes (only the extractor type is emitted) */
		const routeBlock = output.split("export type Routes")[1].split("}")[0]
		expect(routeBlock).not.toContain("errorShapes:")
	})
})
