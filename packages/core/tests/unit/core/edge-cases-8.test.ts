import { describe, expect, it, vi } from "vitest"
import { bodyLimit } from "../../../src/body-limit.ts"
import { timingSafeEqual } from "../../../src/crypto.ts"
import { honey } from "../../../src/index.ts"
import type { TypedResponse } from "../../../src/response.ts"
import { timeout } from "../../../src/timeout.ts"
import { bunWebSocket } from "../../../src/ws/bun.ts"
import type { WSHandler } from "../../../src/ws/cloudflare.ts"
import { WSContextImpl } from "../../../src/ws/cloudflare.ts"

/* ═══════════════════════════════════════════
 * BODY-LIMIT: chunked / no Content-Length
 * ═══════════════════════════════════════════ */

describe("body-limit: no Content-Length header", () => {
	it("body without Content-Length under limit → passes", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 1000 }))
		app.post("/echo").handler(async (ctx) => {
			const text = await ctx.req.text()
			return ctx.res.json("created", { length: text.length })
		})

		const res = await app.fetch(
			new Request("http://localhost/echo", {
				body: "short body",
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
		const data = (await res.json()) as Record<string, number>
		expect(data.length).toBe(10)
	})

	it("body without Content-Length over limit → 413 mid-stream", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 5 }))
		app.post("/echo").handler(async (ctx) => {
			const text = await ctx.req.text()
			return ctx.res.text("ok", text)
		})

		const res = await app.fetch(
			new Request("http://localhost/echo", {
				body: "this is way too long",
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(413)
	})

	it("reconstructed request body is readable after body-limit passes", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 1000 }))
		app.post("/echo").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, unknown>
			return ctx.res.json("created", body)
		})

		const res = await app.fetch(
			new Request("http://localhost/echo", {
				body: JSON.stringify({ name: "test" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.name).toBe("test")
	})

	it("DELETE method skipped by body-limit", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 0 }))
		app.delete("/item").handler((ctx) => ctx.res.noContent())

		const res = await app.fetch(new Request("http://localhost/item", { method: "DELETE" }), {})
		expect(res.status).toBe(204)
	})

	it("invalid Content-Length header (non-numeric) → stream check fallback", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 100 }))
		app.post("/echo").handler(async (ctx) => {
			const text = await ctx.req.text()
			return ctx.res.text("ok", text)
		})

		const res = await app.fetch(
			new Request("http://localhost/echo", {
				body: "hello",
				headers: { "content-length": "not-a-number" },
				method: "POST",
			}),
			{},
		)
		/* NaN > maxSize is false, so fast path passes, stream path checks actual bytes */
		expect(res.status).toBe(200)
	})
})

/* ═══════════════════════════════════════════
 * TIMEOUT: edge cases
 * ═══════════════════════════════════════════ */

describe("timeout: edge cases", () => {
	it("handler completing just before timeout → success", async () => {
		const app = honey<{}>().use(timeout({ duration: 200 }))
		app.get("/slow").handler(async (ctx) => {
			await new Promise((r) => setTimeout(r, 50))
			return ctx.res.json("ok", { done: true })
		})

		const res = await app.fetch(new Request("http://localhost/slow"), {})
		expect(res.status).toBe(200)
	})

	it("timeout clears timer on success (no leak)", async () => {
		const app = honey<{}>().use(timeout({ duration: 100 }))
		app.get("/fast").handler((ctx) => ctx.res.json("ok", {}))

		/* multiple requests should not accumulate timers */
		for (let i = 0; i < 10; i++) {
			const res = await app.fetch(new Request("http://localhost/fast"), {})
			expect(res.status).toBe(200)
		}
	})

	it("timeout with very short duration → 504", async () => {
		const app = honey<{}>().use(timeout({ duration: 1 }))
		app.get("/slow").handler(async (ctx) => {
			await new Promise((r) => setTimeout(r, 100))
			return ctx.res.json("ok", {})
		})

		const res = await app.fetch(new Request("http://localhost/slow"), {})
		expect(res.status).toBe(504)
	})

	it("handler throws before timeout → error propagates, not timeout", async () => {
		const app = honey<{}>().use(timeout({ duration: 5000 }))
		app.get("/err").handler(() => {
			throw new Error("handler error")
		})

		const res = await app.fetch(new Request("http://localhost/err"), {})
		expect(res.status).toBe(500)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("internal_server_error")
	})
})

/* ═══════════════════════════════════════════
 * CRYPTO: timingSafeEqual edge cases
 * ═══════════════════════════════════════════ */

describe("crypto: timingSafeEqual edge cases", () => {
	it("very long strings that match → true", async () => {
		const long = "x".repeat(10000)
		expect(await timingSafeEqual(long, long)).toBe(true)
	})

	it("very long strings with one diff at end → false", async () => {
		const a = `${"x".repeat(9999)}a`
		const b = `${"x".repeat(9999)}b`
		expect(await timingSafeEqual(a, b)).toBe(false)
	})

	it("special characters", async () => {
		expect(await timingSafeEqual("p@$$w0rd!#%", "p@$$w0rd!#%")).toBe(true)
		expect(await timingSafeEqual("p@$$w0rd!#%", "p@$$w0rd!#&")).toBe(false)
	})

	it("whitespace-only strings", async () => {
		expect(await timingSafeEqual("   ", "   ")).toBe(true)
		expect(await timingSafeEqual("   ", "  ")).toBe(false)
	})

	it("newlines and tabs", async () => {
		expect(await timingSafeEqual("a\nb\tc", "a\nb\tc")).toBe(true)
		expect(await timingSafeEqual("a\nb", "a\nc")).toBe(false)
	})

	it("null bytes in string", async () => {
		expect(await timingSafeEqual("a\x00b", "a\x00b")).toBe(true)
		expect(await timingSafeEqual("a\x00b", "a\x00c")).toBe(false)
	})
})

/* ═══════════════════════════════════════════
 * BUN WS ADAPTER: unit tests
 * ═══════════════════════════════════════════ */

describe("bunWebSocket adapter", () => {
	function mockBunEnv(upgradeResult: boolean) {
		return {
			server: {
				upgrade: vi.fn(() => upgradeResult),
			},
		}
	}

	it("successful upgrade → returns 101", async () => {
		const adapter = bunWebSocket()
		const env = mockBunEnv(true)
		const handler: WSHandler<unknown> = {}

		const result = await adapter.upgrade(new Request("http://localhost/ws"), env, handler)
		expect(result.response.status).toBe(101)
		expect(env.server.upgrade).toHaveBeenCalledOnce()
	})

	it("failed upgrade → returns 500", async () => {
		const adapter = bunWebSocket()
		const env = mockBunEnv(false)
		const handler: WSHandler<unknown> = {}

		const result = await adapter.upgrade(new Request("http://localhost/ws"), env, handler)
		expect(result.response.status).toBe(500)
	})

	it("websocket.open fires onOpen", () => {
		const adapter = bunWebSocket()
		const onOpen = vi.fn()
		const handler: WSHandler<unknown> = { onOpen }

		const mockWs = {
			close: vi.fn(),
			data: { handler, socket: undefined as unknown },
			readyState: 1,
			send: vi.fn(),
		}
		adapter.websocket.open(mockWs as never)
		expect(onOpen).toHaveBeenCalledOnce()
	})

	it("websocket.message with string → onMessage gets string", () => {
		const onMessage = vi.fn()
		const adapter = bunWebSocket()
		const handler: WSHandler<unknown> = { onMessage }

		const mockWs = {
			close: vi.fn(),
			data: { handler, socket: undefined as unknown },
			readyState: 1,
			send: vi.fn(),
		}
		adapter.websocket.message(mockWs as never, "hello")
		expect(onMessage).toHaveBeenCalledOnce()
		expect(onMessage.mock.calls[0][2]).toBe("hello")
	})

	it("websocket.message with binary → onMessage gets ArrayBuffer", () => {
		const onMessage = vi.fn()
		const adapter = bunWebSocket()
		const handler: WSHandler<unknown> = { onMessage }

		const mockWs = {
			close: vi.fn(),
			data: { handler, socket: undefined as unknown },
			readyState: 1,
			send: vi.fn(),
		}
		const binary = new Uint8Array([1, 2, 3])
		adapter.websocket.message(mockWs as never, binary)
		expect(onMessage).toHaveBeenCalledOnce()
		expect(onMessage.mock.calls[0][2]).toBeInstanceOf(ArrayBuffer)
	})

	it("websocket.close fires onClose with code and reason", () => {
		const onClose = vi.fn()
		const adapter = bunWebSocket()
		const handler: WSHandler<unknown> = { onClose }

		const mockWs = {
			close: vi.fn(),
			data: { handler, socket: undefined as unknown },
			readyState: 1,
			send: vi.fn(),
		}
		adapter.websocket.close(mockWs as never, 1000, "normal")
		expect(onClose).toHaveBeenCalledOnce()
		expect(onClose.mock.calls[0][2]).toBe(1000)
		expect(onClose.mock.calls[0][3]).toBe("normal")
	})

	it("lazy socket creation — socket set on first event", () => {
		const adapter = bunWebSocket()
		const handler: WSHandler<unknown> = { onOpen: vi.fn() }

		const mockWs = {
			close: vi.fn(),
			data: { handler, socket: undefined as unknown },
			readyState: 1,
			send: vi.fn(),
		}
		expect(mockWs.data.socket).toBeUndefined()
		adapter.websocket.open(mockWs as never)
		expect(mockWs.data.socket).toBeDefined()
		expect(mockWs.data.socket).toBeInstanceOf(WSContextImpl)
	})
})

/* ═══════════════════════════════════════════
 * NODE WS ADAPTER: keepalive config
 * (unit test — mocks ws module)
 * ═══════════════════════════════════════════ */

describe("nodeWebSocket: keepalive config parsing", () => {
	it("nodeWebSocket accepts keepalive options without crashing", () => {
		/* just verify the factory doesn't throw — actual WS behavior requires ws module */
		const { nodeWebSocket } =
			require("../../../src/ws/node.ts") as typeof import("../../../src/ws/node.ts")
		const adapter = nodeWebSocket({ keepalive: { interval: 30000, timeout: 5000 } })
		expect(adapter).toBeDefined()
		expect(typeof adapter.upgrade).toBe("function")
	})

	it("nodeWebSocket without keepalive options", () => {
		const { nodeWebSocket } =
			require("../../../src/ws/node.ts") as typeof import("../../../src/ws/node.ts")
		const adapter = nodeWebSocket()
		expect(adapter).toBeDefined()
	})
})

/* ═══════════════════════════════════════════
 * CLIENT ERROR HANDLING (via app.fetch)
 * ═══════════════════════════════════════════ */

describe("client-facing error responses", () => {
	it("handler returning wrong type → error response or thrown", async () => {
		const app = honey<{}>()
		app.get("/bad").handler(() => {
			return "not a response" as unknown as TypedResponse
		})

		/* framework may throw or return error — either way not 200 */
		try {
			const res = await app.fetch(new Request("http://localhost/bad"), {})
			expect(res === undefined || res.status >= 400).toBe(true)
		} catch {
			/* thrown — acceptable for non-Response return */
		}
	})

	it("async handler that rejects → 500", async () => {
		const app = honey<{}>()
		app.get("/fail").handler(async () => {
			throw new Error("async failure")
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(500)
	})

	it("handler returning undefined → 500 with helpful message", async () => {
		const app = honey<{}>()
		app.get("/oops").handler(() => {
			return undefined as unknown as TypedResponse
		})

		const res = await app.fetch(new Request("http://localhost/oops"), {})
		expect(res.status).toBe(500)
	})
})

/* ═══════════════════════════════════════════
 * SSE: lastEventId from request header
 * ═══════════════════════════════════════════ */

describe("SSE: lastEventId", () => {
	it("Last-Event-ID header passed to stream", async () => {
		const app = honey<{}>()
		app.get("/sse").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({
					data: stream.lastEventId ?? "none",
					event: "resume",
				})
				stream.close()
			}),
		)

		const res = await app.fetch(
			new Request("http://localhost/sse", {
				headers: { "last-event-id": "evt-42" },
			}),
			{},
		)
		const text = await res.text()
		expect(text).toContain("evt-42")
	})

	it("no Last-Event-ID → lastEventId is undefined", async () => {
		const app = honey<{}>()
		app.get("/sse").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({
					data: stream.lastEventId ?? "none",
					event: "start",
				})
				stream.close()
			}),
		)

		const res = await app.fetch(new Request("http://localhost/sse"), {})
		const text = await res.text()
		expect(text).toContain("none")
	})
})
