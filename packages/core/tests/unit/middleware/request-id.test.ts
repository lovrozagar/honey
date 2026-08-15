import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { requestId } from "../../../src/request-id.ts"

describe("request-id middleware — internal", () => {
	it("no incoming header → generates UUID on response", async () => {
		const app = honey<{}>().use(requestId())
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const id = res.headers.get("x-request-id")
		expect(id).toBeTruthy()
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
	})

	it("incoming X-Request-Id preserved", async () => {
		const app = honey<{}>().use(requestId())
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(
			new Request("http://localhost/test", {
				headers: { "x-request-id": "upstream-abc" },
			}),
			{},
		)
		expect(res.headers.get("x-request-id")).toBe("upstream-abc")
	})

	it("custom header name", async () => {
		const app = honey<{}>().use(requestId({ header: "x-correlation-id" }))
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(
			new Request("http://localhost/test", {
				headers: { "x-correlation-id": "corr-123" },
			}),
			{},
		)
		expect(res.headers.get("x-correlation-id")).toBe("corr-123")
	})

	it("custom generator function", async () => {
		let counter = 0
		const app = honey<{}>().use(requestId({ generator: () => `custom-${++counter}` }))
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.headers.get("x-request-id")).toBe("custom-1")
	})

	it("requestId accessible in handler context", async () => {
		const app = honey<{}>().use(requestId())
		app.get("/test").handler((ctx) => ctx.res.json("ok", { id: ctx.requestId }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.id).toBeTruthy()
		expect(typeof body.id).toBe("string")
	})
})

describe("request-id middleware — consumer", () => {
	it("response always has X-Request-Id", async () => {
		const app = honey<{}>().use(requestId())
		app.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		app.get("/b").handler((ctx) => ctx.res.text("ok", "b"))

		const res1 = await app.fetch(new Request("http://localhost/a"), {})
		const res2 = await app.fetch(new Request("http://localhost/b"), {})
		expect(res1.headers.get("x-request-id")).toBeTruthy()
		expect(res2.headers.get("x-request-id")).toBeTruthy()
		/* different requests get different IDs */
		expect(res1.headers.get("x-request-id")).not.toBe(res2.headers.get("x-request-id"))
	})
})
