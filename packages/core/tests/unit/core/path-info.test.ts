import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"

describe("ctx.path and ctx.routePattern", () => {
	it("static route — path and pattern are the same", async () => {
		const app = honey<{}>()
		let capturedPath: string | undefined
		let capturedPattern: string | undefined

		app.get("/health").handler((ctx) => {
			capturedPath = ctx.path
			capturedPattern = ctx.routePattern
			return ctx.res.text("ok", "ok")
		})

		await app.fetch(new Request("http://localhost/health"), {})
		expect(capturedPath).toBe("/health")
		expect(capturedPattern).toBe("/health")
	})

	it("dynamic route — path has value, pattern has :param", async () => {
		const app = honey<{}>()
		let capturedPath: string | undefined
		let capturedPattern: string | undefined

		app.get("/orgs/:orgId").handler((ctx) => {
			capturedPath = ctx.path
			capturedPattern = ctx.routePattern
			return ctx.res.text("ok", "ok")
		})

		await app.fetch(new Request("http://localhost/orgs/123"), {})
		expect(capturedPath).toBe("/orgs/123")
		expect(capturedPattern).toBe("/orgs/:orgId")
	})

	it("basePath included in ctx.path", async () => {
		const app = honey<{}>().basePath("/api")
		let capturedPath: string | undefined

		app.get("/users").handler((ctx) => {
			capturedPath = ctx.path
			return ctx.res.text("ok", "ok")
		})

		await app.fetch(new Request("http://localhost/api/users"), {})
		expect(capturedPath).toBe("/api/users")
	})
})
