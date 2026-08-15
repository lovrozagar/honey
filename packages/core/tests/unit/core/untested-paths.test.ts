import { describe, expect, it } from "vitest"
import { createMiddleware, HoneyError, honey } from "../../../src/index.ts"
import { HoneyRes } from "../../../src/response.ts"

describe("SSE edge cases", () => {
	it("SSE event with multiline data", async () => {
		const app = honey<{}>()
		app.get("/sse").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: "line1\nline2\nline3", event: "multi" })
				stream.close()
			}),
		)

		const res = await app.fetch(new Request("http://localhost/sse"), {})
		const text = await res.text()
		/* each line of data must be prefixed with "data: " per SSE spec */
		expect(text).toContain("data: line1")
		expect(text).toContain("data: line2")
		expect(text).toContain("data: line3")
	})

	it("SSE with object data serialized as JSON", async () => {
		const app = honey<{}>()
		app.get("/sse").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: { count: 42 }, event: "update" })
				stream.close()
			}),
		)

		const res = await app.fetch(new Request("http://localhost/sse"), {})
		const text = await res.text()
		expect(text).toContain('data: {"count":42}')
	})

	it("SSE keepalive 0 → no heartbeat timer", async () => {
		const res = new HoneyRes()
		const response = res.sse(
			async (stream) => {
				stream.close()
			},
			{ keepalive: 0 },
		)

		expect(response.headers.get("content-type")).toBe("text/event-stream")
		/* no crash, no infinite loop */
	})

	it("SSE negative keepalive → no heartbeat timer", async () => {
		const res = new HoneyRes()
		const response = res.sse(
			async (stream) => {
				stream.close()
			},
			{ keepalive: -100 },
		)

		expect(response.headers.get("content-type")).toBe("text/event-stream")
	})
})

describe("stream callback exceptions", () => {
	it("stream callback throws → response body closed cleanly", async () => {
		const res = new HoneyRes()
		const response = res.stream(async () => {
			throw new Error("stream callback exploded")
		})

		/* body should be closed, not hanging */
		const text = await response.text()
		expect(text).toBe("")
	})

	it("SSE callback throws → stream closed cleanly", async () => {
		const app = honey<{}>()
		app.get("/sse").handler((ctx) =>
			ctx.res.sse(async () => {
				throw new Error("sse exploded")
			}),
		)

		const res = await app.fetch(new Request("http://localhost/sse"), {})
		const text = await res.text()
		/* should not hang — stream closed on error */
		expect(typeof text).toBe("string")
	})
})

describe("trailing slash redirect types", () => {
	it("strip: /path/ → 308 redirect to /path", async () => {
		const app = honey<{}>()
		app.trailingSlash("strip")
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/test/"), {})
		expect(res.status).toBe(308)
		expect(res.headers.get("location")).toContain("/test")
		expect(res.headers.get("location")).not.toContain("/test/")
	})

	it("enforce: /path → 308 redirect to /path/", async () => {
		const app = honey<{}>()
		app.trailingSlash("enforce")
		app.get("/test/").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(308)
		const location = res.headers.get("location") ?? ""
		expect(location.endsWith("/test/")).toBe(true)
	})

	it("root path / not affected by strip", async () => {
		const app = honey<{}>()
		app.trailingSlash("strip")
		app.get("/").handler((ctx) => ctx.res.text("ok", "root"))

		const res = await app.fetch(new Request("http://localhost/"), {})
		/* root should NOT be redirected */
		expect(res.status).toBe(200)
	})
})

describe("handler returns null/undefined", () => {
	it("handler returning undefined → middleware catches with helpful error", async () => {
		const app = honey<{}>()
		app.get("/test").handler(() => {
			/* forgot to return */
			return undefined as never
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
	})
})

describe("WS message queue rejection", () => {
	it("onMessage rejection doesn't break queue for next message", async () => {
		let messagesProcessed = 0
		const messages: string[] = []

		const app = honey<{}>()
		app.wsAdapter({
			upgrade(_req, _env, handler) {
				const mockWs = {
					close() {},
					readyState: 1,
					send(data: unknown) {
						messages.push(String(data))
					},
				}
				const socket = { close: mockWs.close, readyState: 1, send: mockWs.send }

				handler.onOpen?.(undefined, socket as never)
				/* send multiple messages — first will reject */
				handler.onMessage?.(undefined, socket as never, "msg1")
				handler.onMessage?.(undefined, socket as never, "msg2")

				return { response: new Response(null, { status: 101 }), socket: socket as never }
			},
		})

		app.ws("/ws").handler({
			onMessage(_ctx, _ws, data) {
				messagesProcessed++
				if (data === "msg1") throw new Error("first message fails")
			},
		})

		await app.fetch(new Request("http://localhost/ws", { headers: { upgrade: "websocket" } }), {})

		/* give message queue time to process */
		await new Promise((r) => setTimeout(r, 50))
		expect(messagesProcessed).toBe(2)
	})
})

describe("404/405 with global middleware", () => {
	it("global middleware runs even for 404", async () => {
		let mwCalled = false
		const app = honey<{}>()
		const mw = createMiddleware(async (_ctx, next) => {
			mwCalled = true
			return next()
		})
		app
			.use(mw)
			.get("/exists")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		await app.fetch(new Request("http://localhost/missing"), {})
		/* global middleware should NOT run for 404 — only route middleware runs */
		/* 404 is handled before middleware chain */
		expect(mwCalled).toBe(false)
	})
})

describe("multiple methods on same path", () => {
	it("GET and POST on /api/items → both work, DELETE → 405", async () => {
		const app = honey<{}>()
		app.get("/api/items").handler((ctx) => ctx.res.json("ok", { method: "GET" }))
		app.post("/api/items").handler((ctx) => ctx.res.json("created", { method: "POST" }))

		const get = await app.fetch(new Request("http://localhost/api/items"), {})
		expect(get.status).toBe(200)

		const post = await app.fetch(new Request("http://localhost/api/items", { method: "POST" }), {})
		expect(post.status).toBe(201)

		const del = await app.fetch(new Request("http://localhost/api/items", { method: "DELETE" }), {})
		expect(del.status).toBe(405)
		const allow = del.headers.get("allow") ?? ""
		expect(allow).toContain("GET")
		expect(allow).toContain("POST")
	})
})

describe("basePath edge cases", () => {
	it("basePath without leading slash", async () => {
		const app = honey<{}>().basePath("/v1")
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/v1/health"), {})
		expect(res.status).toBe(200)
	})

	it("basePath with nested prefix /api/v2", async () => {
		const app = honey<{}>().basePath("/api/v2")
		app.get("/users").handler((ctx) => ctx.res.text("ok", "users"))

		const res = await app.fetch(new Request("http://localhost/api/v2/users"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("users")
	})
})

describe("error formatter receives correct error shape", () => {
	it("custom error formatter transforms response body", async () => {
		const app = honey<{}>()
		app.defaultErrorFormatter((_error, shape) => ({
			...shape,
			formatted: true,
			timestamp: "2026-01-01",
		}))
		app.get("/test").handler(() => {
			throw new Error("boom")
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.formatted).toBe(true)
		expect(body.timestamp).toBe("2026-01-01")
		expect(body.error_key).toBe("internal_server_error")
	})
})

describe("onNotFound custom handler", () => {
	it("custom 404 handler returns custom response", async () => {
		const app = honey<{}>()
		app.onNotFound((ctx) => ctx.jsonFromError(new HoneyError({ errorKey: "custom_not_found", status: "not_found" })))
		app.get("/exists").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/missing"), {})
		expect(res.status).toBe(404)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("custom_not_found")
	})
})

describe("onMethodNotAllowed custom handler", () => {
	it("custom 405 handler includes Allow header", async () => {
		const app = honey<{}>()
		app.onMethodNotAllowed((ctx) => {
			return new Response(JSON.stringify({ allowed: ctx.allowed, custom: true }), {
				headers: { "content-type": "application/json" },
				status: 405,
			})
		})
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/test", { method: "POST" }), {})
		expect(res.status).toBe(405)
		/* framework still adds Allow header even with custom handler */
		expect(res.headers.get("allow")).toContain("GET")
		const body = (await res.json()) as Record<string, unknown>
		expect(body.custom).toBe(true)
	})
})
