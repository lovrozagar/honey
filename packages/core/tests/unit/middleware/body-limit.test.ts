import { describe, expect, it } from "vitest"
import { bodyLimit } from "../../../src/body-limit.ts"
import { honey } from "../../../src/index.ts"

function makeApp(maxSize: number) {
	const base = honey<{}>().use(bodyLimit({ maxSize }))
	base.post("/echo").handler(async (ctx) => {
		const body = await ctx.req.text()
		return ctx.res.text("ok", body)
	})
	base.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
	return base
}

describe("body-limit middleware — internal", () => {
	it("Content-Length > maxSize → 413", async () => {
		const app = makeApp(100)
		const res = await app.fetch(
			new Request("http://localhost/echo", {
				body: "x".repeat(200),
				headers: { "content-length": "200" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(413)
	})

	it("Content-Length <= maxSize → passes through", async () => {
		const app = makeApp(100)
		const res = await app.fetch(
			new Request("http://localhost/echo", {
				body: "hello",
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("hello")
	})

	it("Content-Length absent, body under limit → passes", async () => {
		const app = makeApp(1000)
		const req = new Request("http://localhost/echo", {
			body: "small",
			method: "POST",
		})
		/* remove Content-Length to simulate chunked */
		const headers = new Headers(req.headers)
		headers.delete("content-length")
		const noLenReq = new Request(req, { headers })

		const res = await app.fetch(noLenReq, {})
		expect(res.status).toBe(200)
	})

	it("Content-Length absent, body exceeds limit mid-stream → 413", async () => {
		const app = makeApp(10)
		const bigBody = "x".repeat(100)
		const res = await app.fetch(
			new Request("http://localhost/echo", {
				body: bigBody,
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(413)
	})

	it("exact boundary: maxSize = 100, body = 100 → passes", async () => {
		const app = makeApp(100)
		const res = await app.fetch(
			new Request("http://localhost/echo", {
				body: "x".repeat(100),
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
	})

	it("exact boundary: maxSize = 100, body = 101 → 413", async () => {
		const app = makeApp(100)
		const res = await app.fetch(
			new Request("http://localhost/echo", {
				body: "x".repeat(101),
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(413)
	})

	it("maxSize = 0 → rejects any body", async () => {
		const app = makeApp(0)
		const res = await app.fetch(
			new Request("http://localhost/echo", {
				body: "x",
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(413)
	})

	it("GET request unaffected regardless of Content-Length", async () => {
		const app = makeApp(10)
		const res = await app.fetch(new Request("http://localhost/health"), {})
		expect(res.status).toBe(200)
	})
})

describe("body-limit stream-through (no buffering)", () => {
	it("under limit → body streams through to handler", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 1000 }))
		app.post("/check").handler(async (ctx) => {
			const text = await ctx.req.text()
			return ctx.res.text("ok", text)
		})

		const res = await app.fetch(
			new Request("http://localhost/check", {
				body: "hello world",
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("hello world")
	})

	it("over limit mid-stream → 413 with content_too_large error", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 10 }))
		app.post("/check").handler(async (ctx) => {
			return ctx.res.text("ok", await ctx.req.text())
		})

		const res = await app.fetch(
			new Request("http://localhost/check", {
				body: "x".repeat(100),
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(413)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("content_too_large")
	})

	it("preserves original request headers and method", async () => {
		let receivedMethod: string | undefined
		let receivedContentType: string | null | undefined
		const app = honey<{}>().use(bodyLimit({ maxSize: 1000 }))
		app.post("/check").handler(async (ctx) => {
			receivedMethod = ctx.req.method
			receivedContentType = ctx.req.headers.get("content-type")
			return ctx.res.text("ok", await ctx.req.text())
		})

		const res = await app.fetch(
			new Request("http://localhost/check", {
				body: '{"key":"value"}',
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		expect(receivedMethod).toBe("POST")
		expect(receivedContentType).toBe("application/json")
	})
})

describe("body-limit middleware — consumer", () => {
	it("POST JSON exceeding limit → structured error with content_too_large", async () => {
		const app = makeApp(50)
		const bigJson = JSON.stringify({ data: "x".repeat(100) })
		const res = await app.fetch(
			new Request("http://localhost/echo", {
				body: bigJson,
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(413)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("content_too_large")
	})

	it("routes without body limit → unaffected", async () => {
		const h = honey<{}>()
		/* no bodyLimit middleware */
		h.post("/echo").handler(async (ctx) => {
			const body = await ctx.req.text()
			return ctx.res.text("ok", body)
		})
		const bigBody = "x".repeat(10000)
		const res = await h.fetch(
			new Request("http://localhost/echo", {
				body: bigBody,
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
	})
})
