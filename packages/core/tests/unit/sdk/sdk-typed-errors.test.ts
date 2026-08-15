import { describe, expect, it } from "vitest"
import * as z from "zod"
import { honey, defineErrors } from "../../../src/index.ts"
import { generateOpenApi, generateSDK } from "../../../src/codegen.ts"

describe("SDK codegen: typed errors", () => {
	it("SDKResult type uses raw body (not ClientError)", async () => {
		const errors = defineErrors({
			api_error: "internal_server_error",
			not_found: "not_found",
		})

		const app = honey()
			.errorFactory(errors)
			.defaultBoundary("api_error")
			.get("/items")
			.meta({ operationId: "items.list" })
			.errors("not_found")
			.handler((c) => c.res.json("ok", {}))

		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1" } })
		const { files } = generateSDK(spec)

		/* SDKResult should use raw body, not ClientError */
		expect(files.types).toContain("type SDKResult<T")
		expect(files.types).not.toContain("error: ClientError")
		expect(files.types).toContain("error: unknown")
	})

	it("SDK methods include errorsByStatus for routes with errors", async () => {
		const errors = defineErrors({
			api_error: "internal_server_error",
			item_not_found: {
				schema: z.object({ reason: z.string() }),
				status: "not_found",
			},
		})

		const app = honey()
			.errorFactory(errors)
			.defaultBoundary("api_error")
			.get("/items/:id")
			.meta({ operationId: "items.get" })
			.output({ "application/json": { ok: z.object({ name: z.string() }) } })
			.errors("item_not_found")
			.handler((c) => c.res.json("ok", { name: "test" }))

		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1" } })
		const { files } = generateSDK(spec)

		/* method should have SDKResult with error type parameter */
		expect(files.types).toContain("SDKResult<")
		expect(files.types).toContain("404:")
	})

	it("SDK methods without errors use basic SDKResult", async () => {
		const app = honey()
			.get("/health")
			.meta({ operationId: "health.check" })
			.handler((c) => c.res.json("ok", { status: "ok" }))

		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1" } })
		const { files } = generateSDK(spec)

		/* no error type parameter */
		expect(files.types).toContain("SDKResult<")
		expect(files.types).not.toContain("404:")
	})

	it("standard errors produce error type in SDKResult", async () => {
		const errors = defineErrors({
			api_error: "internal_server_error",
			unauthorized: "unauthorized",
		})

		const app = honey()
			.errorFactory(errors)
			.defaultBoundary("api_error")
			.get("/secure")
			.meta({ operationId: "secure.get" })
			.errors("unauthorized")
			.handler((c) => c.res.json("ok", {}))

		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1" } })
		const { files } = generateSDK(spec)

		/* 401 should appear in error type */
		expect(files.types).toContain("401:")
	})
})
