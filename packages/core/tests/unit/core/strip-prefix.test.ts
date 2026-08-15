import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"

describe("stripPrefix basic", () => {
	it("strips /api prefix from /api/health", async () => {
		const app = honey<{}>().stripPrefix("/api")
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/api/health"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("ok")
	})

	it("exact prefix match becomes root", async () => {
		const app = honey<{}>().stripPrefix("/api")
		app.get("/").handler((ctx) => ctx.res.text("ok", "root"))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("root")
	})

	it("no match passes through unchanged", async () => {
		const app = honey<{}>().stripPrefix("/api")
		app.get("/other/health").handler((ctx) => ctx.res.text("ok", "other"))

		const res = await app.fetch(new Request("http://localhost/other/health"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("other")
	})

	it("non-prefixed path returns 404 for unrelated routes", async () => {
		const app = honey<{}>().stripPrefix("/api")
		app.get("/users").handler((ctx) => ctx.res.text("ok", "users"))

		const res = await app.fetch(new Request("http://localhost/other/users"), {})
		expect(res.status).toBe(404)
	})

	it("multi-segment prefix", async () => {
		const app = honey<{}>().stripPrefix("/api/v1")
		app.get("/users").handler((ctx) => ctx.res.text("ok", "users"))

		const res = await app.fetch(new Request("http://localhost/api/v1/users"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("users")
	})
})

describe("stripPrefix boundary safety", () => {
	it("does NOT strip prefix that is substring of segment", async () => {
		const app = honey<{}>().stripPrefix("/api")
		app.get("/-docs").handler((ctx) => ctx.res.text("ok", "wrong"))

		const res = await app.fetch(new Request("http://localhost/api-docs"), {})
		expect(res.status).toBe(404)
	})

	it("does NOT strip /apiary", async () => {
		const app = honey<{}>().stripPrefix("/api")
		app.get("/ary").handler((ctx) => ctx.res.text("ok", "wrong"))

		const res = await app.fetch(new Request("http://localhost/apiary"), {})
		expect(res.status).toBe(404)
	})

	it("strips /api from /api/ correctly", async () => {
		const app = honey<{}>().stripPrefix("/api")
		app.get("/").handler((ctx) => ctx.res.text("ok", "root"))

		const res = await app.fetch(new Request("http://localhost/api/"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("root")
	})
})

describe("stripPrefix normalization", () => {
	it("trailing slash on prefix is normalized", async () => {
		const app = honey<{}>().stripPrefix("/api/")
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/api/health"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("ok")
	})

	it("prefix without leading slash gets normalized", async () => {
		const app = honey<{}>().stripPrefix("api")
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/api/health"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("ok")
	})

	it("empty string prefix is no-op", async () => {
		const app = honey<{}>().stripPrefix("")
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/health"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("ok")
	})

	it("slash-only prefix is no-op", async () => {
		const app = honey<{}>().stripPrefix("/")
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/health"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("ok")
	})
})

describe("stripPrefix + trailingSlash interaction", () => {
	it("trailing slash strip redirects preserve prefix", async () => {
		const app = honey<{}>().stripPrefix("/api").trailingSlash("strip")
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/api/health/"), {})
		expect(res.status).toBe(308)
		const location = res.headers.get("location") ?? ""
		expect(location).toContain("/api/health")
		expect(location.endsWith("/api/health/")).toBe(false)
	})

	it("trailing slash enforce redirects preserve prefix", async () => {
		const app = honey<{}>().stripPrefix("/api").trailingSlash("enforce")
		app.get("/health/").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/api/health"), {})
		expect(res.status).toBe(308)
		const location = res.headers.get("location") ?? ""
		expect(location).toContain("/api/health/")
	})

	it("after trailing slash redirect, next request matches", async () => {
		const app = honey<{}>().stripPrefix("/api").trailingSlash("strip")
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/api/health"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("ok")
	})
})

describe("stripPrefix + basePath interaction", () => {
	it("stripPrefix and basePath compose correctly", async () => {
		const app = honey<{}>().stripPrefix("/gateway").basePath("/v1")
		app.get("/users").handler((ctx) => ctx.res.text("ok", "users"))

		const res = await app.fetch(new Request("http://localhost/gateway/v1/users"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("users")
	})

	it("basePath without stripPrefix still works", async () => {
		const app = honey<{}>().basePath("/v1")
		app.get("/users").handler((ctx) => ctx.res.text("ok", "users"))

		const res = await app.fetch(new Request("http://localhost/v1/users"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("users")
	})
})

describe("stripPrefix double and nested", () => {
	it("double prefix in URL strips only once", async () => {
		const app = honey<{}>().stripPrefix("/api")
		app.get("/api/deep").handler((ctx) => ctx.res.text("ok", "deep"))

		const res = await app.fetch(new Request("http://localhost/api/api/deep"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("deep")
	})

	it("request to root with prefix configured still matches root route", async () => {
		const app = honey<{}>().stripPrefix("/api")
		app.get("/").handler((ctx) => ctx.res.text("ok", "root"))

		const res = await app.fetch(new Request("http://localhost/"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("root")
	})
})

describe("stripPrefix chaining", () => {
	it("returns same instance for chaining", () => {
		const app = honey<{}>()
		const result = app.stripPrefix("/api")
		expect(result === app).toBe(true)
	})
})

describe("stripPrefix encoded paths", () => {
	it("encoded slash in path does not confuse strip", async () => {
		const app = honey<{}>().stripPrefix("/api")
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/api%2Ftest"), {})
		expect(res.status).toBe(404)
	})
})
