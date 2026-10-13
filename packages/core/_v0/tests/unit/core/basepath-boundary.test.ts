import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"

describe("basePath boundary matching", () => {
	it("basePath /api should NOT strip /api-docs (route /-docs should not match)", async () => {
		const h = honey<{}>().basePath("/api")
		/* register a route that would match the incorrectly-stripped remainder */
		h.get("/-docs").handler((ctx) => ctx.res.text("ok", "wrong"))

		const res = await h.fetch(new Request("http://localhost/api-docs"), {})
		/* /api-docs is NOT under /api — should be 404, not match /-docs */
		expect(res.status).toBe(404)
	})

	it("basePath /api should NOT strip /apiary (route /ary should not match)", async () => {
		const h = honey<{}>().basePath("/api")
		h.get("/ary").handler((ctx) => ctx.res.text("ok", "wrong"))

		const res = await h.fetch(new Request("http://localhost/apiary"), {})
		expect(res.status).toBe(404)
	})

	it("basePath /api should strip /api/health correctly", async () => {
		const h = honey<{}>().basePath("/api")
		h.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await h.fetch(new Request("http://localhost/api/health"), {})
		expect(res.status).toBe(200)
	})

	it("basePath /api should match exact /api as root /", async () => {
		const h = honey<{}>().basePath("/api")
		h.get("/").handler((ctx) => ctx.res.text("ok", "root"))

		const res = await h.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("root")
	})
})
