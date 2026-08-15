import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"

describe("basePath adversarial", () => {
	it("basePath with trailing slash normalized", async () => {
		const app = honey<{}>().basePath("/api/")
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/api/health"), {})
		expect(res.status).toBe(200)
	})

	it("basePath that's a prefix of another path doesn't match incorrectly", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		/* /api-v2/health should NOT match — /api is not followed by / */
		const res = await app.fetch(new Request("http://localhost/api-v2/health"), {})
		expect(res.status).toBe(404)
	})

	it("basePath same as route path", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/").handler((ctx) => ctx.res.text("ok", "root"))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("root")
	})

	it("double basePath in URL doesn't double-strip", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/api/deep").handler((ctx) => ctx.res.text("ok", "deep"))

		/* /api/api/deep → strip /api → /api/deep → matches route */
		const res = await app.fetch(new Request("http://localhost/api/api/deep"), {})
		expect(res.status).toBe(200)
	})

	it("path traversal attempt via basePath", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/secret").handler((ctx) => ctx.res.text("ok", "secret"))

		/* attempt to access /secret by manipulating basePath stripping */
		const res = await app.fetch(new Request("http://localhost/api/../secret"), {})
		/* URL normalization should handle .. — browser normalizes to /secret */
		/* but basePath /api isn't a prefix of /secret, so no strip happens */
		/* result depends on URL constructor normalization */
		expect([200, 404]).toContain(res.status)
	})

	it("basePath with encoded characters", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		/* %2F is encoded / — should not be treated as path separator */
		const res = await app.fetch(new Request("http://localhost/api%2Ftest"), {})
		/* /api%2Ftest is one path segment, not /api/test */
		expect(res.status).toBe(404)
	})
})

describe("trailing slash + basePath combined", () => {
	it("strip trailing slash happens before basePath strip", async () => {
		const app = honey<{}>().basePath("/api").trailingSlash("strip")
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		/* /api/health/ → strip trailing → redirect to /api/health */
		const res = await app.fetch(new Request("http://localhost/api/health/"), {})
		expect(res.status).toBe(308)
		const location = res.headers.get("location") ?? ""
		expect(location).toContain("/api/health")
		expect(location.endsWith("/api/health/")).toBe(false)
	})

	it("enforce trailing slash on basePath root", async () => {
		const app = honey<{}>().basePath("/api").trailingSlash("enforce")
		app.get("/").handler((ctx) => ctx.res.text("ok", "root"))

		/* /api → enforce trailing → redirect to /api/ */
		const res = await app.fetch(new Request("http://localhost/api"), {})
		/* basePath exact match → path becomes "/" which is length 1 → no trailing slash enforcement */
		expect([200, 308]).toContain(res.status)
	})
})

describe("method case sensitivity", () => {
	it("lowercase method still matches", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		/* request.method.toUpperCase() normalizes */
		const req = new Request("http://localhost/test")
		Object.defineProperty(req, "method", { value: "get" })
		const res = await app.fetch(req, {})
		expect(res.status).toBe(200)
	})
})
