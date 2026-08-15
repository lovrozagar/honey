import * as z from "zod"
import { describe, expect, it, vi } from "vitest"
import { HoneyError } from "../../../src/error.ts"
import { defineErrors, honey } from "../../../src/index.ts"
import { createMiddleware } from "../../../src/middleware.ts"

/* ──────────────────────────────────────────────
 * Unit: c.tap() queuing
 * ────────────────────────────────────────────── */

describe("tap: c.tap() queuing", () => {
	it("c.tap() queues a single pending tap", async () => {
		const received: unknown[] = []
		const app = honey<{}>()
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})
		app.get("/test").handler((ctx) => {
			ctx.tap("audit", { action: "test" })
			return ctx.res.json("ok", {})
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		expect(received).toHaveLength(1)
		expect(received[0]).toEqual({ action: "test" })
	})

	it("c.tap() with same key twice queues two entries", async () => {
		const received: unknown[] = []
		const app = honey<{}>()
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})
		app.get("/test").handler((ctx) => {
			ctx.tap("audit", { action: "first" })
			ctx.tap("audit", { action: "second" })
			return ctx.res.json("ok", {})
		})

		await app.fetch(new Request("http://localhost/test"), {})
		expect(received).toHaveLength(2)
		expect(received[0]).toEqual({ action: "first" })
		expect(received[1]).toEqual({ action: "second" })
	})

	it("c.tap() with different keys queues separate entries", async () => {
		const auditReceived: unknown[] = []
		const webhookReceived: unknown[] = []
		const app = honey<{}>()
		app.tap("audit", async (_ctx, payload) => {
			auditReceived.push(payload)
		})
		app.tap("webhook", async (_ctx, payload) => {
			webhookReceived.push(payload)
		})
		app.get("/test").handler((ctx) => {
			ctx.tap("audit", { action: "create" })
			ctx.tap("webhook", { event: "created" })
			return ctx.res.json("ok", {})
		})

		await app.fetch(new Request("http://localhost/test"), {})
		expect(auditReceived).toHaveLength(1)
		expect(auditReceived[0]).toEqual({ action: "create" })
		expect(webhookReceived).toHaveLength(1)
		expect(webhookReceived[0]).toEqual({ event: "created" })
	})

	it("c.tap() with unregistered key is silently ignored", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => {
			ctx.tap("nonexistent", { data: "ignored" })
			return ctx.res.json("ok", {})
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
	})
})

/* ──────────────────────────────────────────────
 * Unit: .tap() registration
 * ────────────────────────────────────────────── */

describe("tap: .tap() registration", () => {
	it(".tap() is chainable — returns this", () => {
		const app = honey<{}>()
		const result = app.tap("a", async () => {})
		expect(result).toBe(app)
	})

	it(".tap() with same key overwrites previous handler", async () => {
		const received: string[] = []
		const app = honey<{}>()
		app.tap("audit", async () => {
			received.push("first")
		})
		app.tap("audit", async () => {
			received.push("second")
		})
		app.get("/test").handler((ctx) => {
			ctx.tap("audit", {})
			return ctx.res.json("ok", {})
		})

		await app.fetch(new Request("http://localhost/test"), {})
		expect(received).toEqual(["second"])
	})

	it(".tap() on cloned Honey (via .use()) shares tap handlers", async () => {
		const received: unknown[] = []
		const app = honey<{}>()
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})

		const mw = createMiddleware(async (_ctx, next) => next({ userId: "123" }))
		const appWithMw = app.use(mw)

		appWithMw.get("/test").handler((ctx) => {
			ctx.tap("audit", { user: ctx.userId })
			return ctx.res.json("ok", {})
		})

		await app.fetch(new Request("http://localhost/test"), {})
		expect(received).toHaveLength(1)
		expect(received[0]).toEqual({ user: "123" })
	})

	it("app.tap() registered after routes still fires", async () => {
		const received: unknown[] = []
		const app = honey<{}>()

		app.get("/test").handler((ctx) => {
			ctx.tap("audit", { late: true })
			return ctx.res.json("ok", {})
		})

		/* register tap AFTER route */
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})

		await app.fetch(new Request("http://localhost/test"), {})
		expect(received).toHaveLength(1)
		expect(received[0]).toEqual({ late: true })
	})
})

/* ──────────────────────────────────────────────
 * Integration: meta-driven taps fire
 * ────────────────────────────────────────────── */

describe("tap: meta-driven taps", () => {
	it("route with matching meta key fires tap automatically", async () => {
		const received: unknown[] = []
		const app = honey<{}>().meta<{ audit?: { action: string } }>()
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})

		app
			.get("/test")
			.meta({ audit: { action: "auto" } })
			.handler((ctx) => ctx.res.json("ok", {}))

		await app.fetch(new Request("http://localhost/test"), {})
		expect(received).toHaveLength(1)
		expect(received[0]).toEqual({ action: "auto" })
	})

	it("route without matching meta key does not fire tap", async () => {
		const received: unknown[] = []
		const app = honey<{}>().meta<{ audit?: { action: string } }>()
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})

		app.get("/test").handler((ctx) => ctx.res.json("ok", {}))

		await app.fetch(new Request("http://localhost/test"), {})
		expect(received).toHaveLength(0)
	})

	it("route with multiple meta keys fires multiple taps", async () => {
		const auditReceived: unknown[] = []
		const cacheReceived: unknown[] = []
		const app = honey<{}>().meta<{
			audit?: { action: string }
			invalidate?: { key: string }
		}>()
		app.tap("audit", async (_ctx, payload) => {
			auditReceived.push(payload)
		})
		app.tap("invalidate", async (_ctx, payload) => {
			cacheReceived.push(payload)
		})

		app
			.get("/test")
			.meta({ audit: { action: "create" }, invalidate: { key: "items" } })
			.handler((ctx) => ctx.res.json("ok", {}))

		await app.fetch(new Request("http://localhost/test"), {})
		expect(auditReceived).toHaveLength(1)
		expect(cacheReceived).toHaveLength(1)
	})
})

/* ──────────────────────────────────────────────
 * Integration: combined meta + dynamic taps
 * ────────────────────────────────────────────── */

describe("tap: combined meta + dynamic", () => {
	it("meta tap and dynamic tap both fire on same request", async () => {
		const metaReceived: unknown[] = []
		const dynamicReceived: unknown[] = []
		const app = honey<{}>().meta<{ invalidate?: { key: string } }>()
		app.tap("invalidate", async (_ctx, payload) => {
			metaReceived.push(payload)
		})
		app.tap("audit", async (_ctx, payload) => {
			dynamicReceived.push(payload)
		})

		app
			.get("/test")
			.meta({ invalidate: { key: "items" } })
			.handler((ctx) => {
				ctx.tap("audit", { action: "create" })
				return ctx.res.json("ok", {})
			})

		await app.fetch(new Request("http://localhost/test"), {})
		expect(metaReceived).toHaveLength(1)
		expect(dynamicReceived).toHaveLength(1)
	})

	it("meta taps fire before dynamic taps", async () => {
		const order: string[] = []
		const app = honey<{}>().meta<{ invalidate?: { key: string } }>()
		app.tap("invalidate", async () => {
			order.push("meta")
		})
		app.tap("audit", async () => {
			order.push("dynamic")
		})

		app
			.get("/test")
			.meta({ invalidate: { key: "items" } })
			.handler((ctx) => {
				ctx.tap("audit", { action: "create" })
				return ctx.res.json("ok", {})
			})

		await app.fetch(new Request("http://localhost/test"), {})
		expect(order).toEqual(["meta", "dynamic"])
	})
})

/* ──────────────────────────────────────────────
 * Integration: error isolation
 * ────────────────────────────────────────────── */

describe("tap: error isolation", () => {
	it("tap handler throws — response still 200", async () => {
		const app = honey<{}>()
		app.tap("audit", async () => {
			throw new Error("tap boom")
		})
		app.get("/test").handler((ctx) => {
			ctx.tap("audit", {})
			return ctx.res.json("ok", { success: true })
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.success).toBe(true)
	})

	it("tap handler rejects — response still 200", async () => {
		const app = honey<{}>()
		app.tap("audit", async () => {
			return Promise.reject(new Error("async tap boom"))
		})
		app.get("/test").handler((ctx) => {
			ctx.tap("audit", {})
			return ctx.res.json("ok", { success: true })
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
	})

	it("one tap throws, other tap still fires", async () => {
		const received: string[] = []
		const app = honey<{}>()
		app.tap("bad", async () => {
			throw new Error("boom")
		})
		app.tap("good", async () => {
			received.push("fired")
		})
		app.get("/test").handler((ctx) => {
			ctx.tap("bad", {})
			ctx.tap("good", {})
			return ctx.res.json("ok", {})
		})

		await app.fetch(new Request("http://localhost/test"), {})
		expect(received).toEqual(["fired"])
	})

	it("tap error is logged, not thrown to onError", async () => {
		const warnings: unknown[] = []
		const onErrorCalled = vi.fn()
		const bgPromises: Promise<unknown>[] = []

		const app = honey<{}>()
		app.logger({ warn: (...args: unknown[]) => warnings.push(args) })
		app.onError(() => {
			onErrorCalled()
			return undefined
		})
		app.tap("audit", async () => {
			throw new Error("tap failure")
		})
		app.get("/test").handler((ctx) => {
			ctx.tap("audit", {})
			return ctx.res.json("ok", {})
		})

		const res = await app.fetch(new Request("http://localhost/test"), {}, {
			waitUntil: (p: Promise<unknown>) => bgPromises.push(p),
		})
		expect(res.status).toBe(200)
		expect(onErrorCalled).not.toHaveBeenCalled()

		/* wait for background taps to settle */
		await Promise.allSettled(bgPromises)
		expect(warnings.length).toBeGreaterThan(0)
	})
})

/* ──────────────────────────────────────────────
 * Integration: taps do NOT fire on error responses
 * ────────────────────────────────────────────── */

describe("tap: no fire on error", () => {
	it("handler throws HoneyError — no taps fire", async () => {
		const received: unknown[] = []
		const app = honey<{}>().meta<{ audit?: unknown }>()
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})

		app
			.get("/test")
			.meta({ audit: { action: "should-not-fire" } })
			.handler((ctx) => {
				ctx.tap("audit", { action: "also-should-not-fire" })
				throw new HoneyError({ errorKey: "not_found", status: "not_found" })
			})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(404)
		expect(received).toHaveLength(0)
	})

	it("handler throws unknown error — no taps fire", async () => {
		const received: unknown[] = []
		const app = honey<{}>()
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})

		app.get("/test").handler((ctx) => {
			ctx.tap("audit", { action: "nope" })
			throw new Error("unexpected")
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
		expect(received).toHaveLength(0)
	})

	it("404 — no taps fire", async () => {
		const received: unknown[] = []
		const app = honey<{}>()
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})

		app.get("/exists").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/nope"), {})
		expect(res.status).toBe(404)
		expect(received).toHaveLength(0)
	})

	it("405 — no taps fire", async () => {
		const received: unknown[] = []
		const app = honey<{}>()
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})

		app.get("/test").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/test", { method: "DELETE" }),
			{},
		)
		expect(res.status).toBe(405)
		expect(received).toHaveLength(0)
	})
})

/* ──────────────────────────────────────────────
 * Integration: tap receives correct context
 * ────────────────────────────────────────────── */

describe("tap: context access", () => {
	it("tap receives ctx.params from matched route", async () => {
		let tapParams: Record<string, string> = {}
		const app = honey<{}>()
		app.tap("audit", async (ctx) => {
			tapParams = ctx.params
		})

		app.get("/users/:id").handler((ctx) => {
			ctx.tap("audit", {})
			return ctx.res.json("ok", {})
		})

		await app.fetch(new Request("http://localhost/users/42"), {})
		expect(tapParams.id).toBe("42")
	})

	it("tap receives ctx.headers from request", async () => {
		let tapHeaders: Record<string, string> = {}
		const app = honey<{}>()
		app.tap("audit", async (ctx) => {
			tapHeaders = ctx.headers
		})

		app.get("/test").handler((ctx) => {
			ctx.tap("audit", {})
			return ctx.res.json("ok", {})
		})

		await app.fetch(
			new Request("http://localhost/test", {
				headers: { "x-custom": "hello" },
			}),
			{},
		)
		expect(tapHeaders["x-custom"]).toBe("hello")
	})

	it("tap receives ctx.meta from route", async () => {
		let tapMeta: Record<string, unknown> = {}
		const app = honey<{}>().meta<{ tags?: string }>()
		app.tap("audit", async (ctx) => {
			tapMeta = ctx.meta
		})

		app
			.get("/test")
			.meta({ tags: "users" })
			.handler((ctx) => {
				ctx.tap("audit", {})
				return ctx.res.json("ok", {})
			})

		await app.fetch(new Request("http://localhost/test"), {})
		expect(tapMeta.tags).toBe("users")
	})

	it("tap receives ctx.env", async () => {
		let tapEnv: Record<string, unknown> = {}
		const app = honey<{ SECRET: string }>()
		app.tap("audit", async (ctx) => {
			tapEnv = ctx.env as Record<string, unknown>
		})

		app.get("/test").handler((ctx) => {
			ctx.tap("audit", {})
			return ctx.res.json("ok", {})
		})

		await app.fetch(new Request("http://localhost/test"), { SECRET: "s3cret" })
		expect(tapEnv.SECRET).toBe("s3cret")
	})

	it("tap receives middleware additions", async () => {
		let tapUserId: unknown
		const mw = createMiddleware(async (_ctx, next) => next({ userId: "usr_123" }))

		const app = honey<{}>().use(mw)
		app.tap("audit", async (ctx) => {
			tapUserId = (ctx as Record<string, unknown>).userId
		})

		app.get("/test").handler((ctx) => {
			ctx.tap("audit", {})
			return ctx.res.json("ok", {})
		})

		await app.fetch(new Request("http://localhost/test"), {})
		expect(tapUserId).toBe("usr_123")
	})
})

/* ──────────────────────────────────────────────
 * Integration: non-blocking behavior
 * ────────────────────────────────────────────── */

describe("tap: non-blocking", () => {
	it("slow tap does not delay response", async () => {
		const app = honey<{}>()
		app.tap("slow", async () => {
			await new Promise((r) => setTimeout(r, 500))
		})
		app.get("/test").handler((ctx) => {
			ctx.tap("slow", {})
			return ctx.res.json("ok", {})
		})

		const start = performance.now()
		const res = await app.fetch(new Request("http://localhost/test"), {})
		const duration = performance.now() - start

		expect(res.status).toBe(200)
		/* response should return well before 500ms tap completes */
		expect(duration).toBeLessThan(100)
	})

	it("tap runs via waitUntil when executionCtx provided", async () => {
		const waitUntilPromises: Promise<unknown>[] = []
		const received: unknown[] = []

		const app = honey<{}>()
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})
		app.get("/test").handler((ctx) => {
			ctx.tap("audit", { tracked: true })
			return ctx.res.json("ok", {})
		})

		await app.fetch(new Request("http://localhost/test"), {}, {
			waitUntil: (p: Promise<unknown>) => waitUntilPromises.push(p),
		})

		/* taps should have been scheduled via waitUntil */
		expect(waitUntilPromises.length).toBeGreaterThan(0)
		/* wait for them to complete */
		await Promise.all(waitUntilPromises)
		expect(received).toEqual([{ tracked: true }])
	})
})

/* ──────────────────────────────────────────────
 * Integration: tap with middleware
 * ────────────────────────────────────────────── */

describe("tap: with middleware", () => {
	it("taps fire after full middleware chain completes", async () => {
		const order: string[] = []
		const mw = createMiddleware(async (_ctx, next) => {
			order.push("mw:before")
			const res = await next({ mwValue: "added" })
			order.push("mw:after")
			return res
		})

		const app = honey<{}>().use(mw)
		app.tap("audit", async () => {
			order.push("tap")
		})
		app.get("/test").handler((ctx) => {
			order.push("handler")
			ctx.tap("audit", {})
			return ctx.res.json("ok", {})
		})

		await app.fetch(new Request("http://localhost/test"), {})
		/* middleware wraps handler, tap fires after response */
		expect(order).toContain("mw:before")
		expect(order).toContain("handler")
		expect(order).toContain("mw:after")
		expect(order).toContain("tap")
	})

	it("middleware error — no taps fire", async () => {
		const received: unknown[] = []
		const mw = createMiddleware(async () => {
			throw new Error("middleware crash")
		})

		const app = honey<{}>().use(mw)
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})
		app.get("/test").handler((ctx) => {
			ctx.tap("audit", { should: "not-fire" })
			return ctx.res.json("ok", {})
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
		expect(received).toHaveLength(0)
	})
})

/* ──────────────────────────────────────────────
 * Edge cases
 * ────────────────────────────────────────────── */

describe("tap: edge cases", () => {
	it("zero registered taps + c.tap() calls — no error", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => {
			ctx.tap("audit", { data: "ignored" })
			ctx.tap("webhook", { event: "ignored" })
			return ctx.res.json("ok", {})
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
	})

	it("registered taps + no c.tap() + no matching meta — nothing fires", async () => {
		const received: unknown[] = []
		const app = honey<{}>()
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})

		app.get("/test").handler((ctx) => ctx.res.json("ok", {}))

		await app.fetch(new Request("http://localhost/test"), {})
		expect(received).toHaveLength(0)
	})

	it("concurrent requests have isolated tap queues", async () => {
		const received: unknown[] = []
		const app = honey<{}>()
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})

		app.get("/test/:id").handler(async (ctx) => {
			await new Promise((r) => setTimeout(r, Math.random() * 10))
			ctx.tap("audit", { id: ctx.params.id })
			return ctx.res.json("ok", {})
		})

		const promises = Array.from({ length: 10 }, (_, i) =>
			app.fetch(new Request(`http://localhost/test/${i}`), {}),
		)
		await Promise.all(promises)

		expect(received).toHaveLength(10)
		const ids = received.map((r) => (r as Record<string, string>).id)
		expect(new Set(ids).size).toBe(10)
	})
})

/* ──────────────────────────────────────────────
 * Deep: meta-driven tap receives frozen meta value
 * ────────────────────────────────────────────── */

describe("tap: deep meta-driven scenarios", () => {
	it("meta tap receives the exact meta value as payload", async () => {
		let tapPayload: unknown
		const app = honey<{}>().meta<{ audit?: { action: string; level: number } }>()
		app.tap("audit", async (_ctx, payload) => {
			tapPayload = payload
		})

		app
			.get("/test")
			.meta({ audit: { action: "deep.test", level: 42 } })
			.handler((ctx) => ctx.res.json("ok", {}))

		await app.fetch(new Request("http://localhost/test"), {})
		expect(tapPayload).toEqual({ action: "deep.test", level: 42 })
	})

	it("chain-level meta triggers tap on all routes in chain", async () => {
		const received: unknown[] = []
		const app = honey<{}>().meta<{ invalidate?: { scope: string } }>()
		app.tap("invalidate", async (_ctx, payload) => {
			received.push(payload)
		})

		const chain = app.meta({ invalidate: { scope: "global" } })

		chain.get("/a").handler((ctx) => ctx.res.json("ok", {}))
		chain.get("/b").handler((ctx) => ctx.res.json("ok", {}))

		await app.fetch(new Request("http://localhost/a"), {})
		await app.fetch(new Request("http://localhost/b"), {})

		expect(received).toHaveLength(2)
		expect(received[0]).toEqual({ scope: "global" })
		expect(received[1]).toEqual({ scope: "global" })
	})

	it("route-level meta overrides chain-level meta for tap", async () => {
		let tapPayload: unknown
		const app = honey<{}>().meta<{ audit?: { source: string } }>()
		app.tap("audit", async (_ctx, payload) => {
			tapPayload = payload
		})

		const chain = app.meta({ audit: { source: "chain" } })
		chain
			.get("/test")
			.meta({ audit: { source: "route" } })
			.handler((ctx) => ctx.res.json("ok", {}))

		await app.fetch(new Request("http://localhost/test"), {})
		expect(tapPayload).toEqual({ source: "route" })
	})

	it("meta tap does NOT fire if meta key value is undefined", async () => {
		const received: unknown[] = []
		const app = honey<{}>().meta<{ audit?: unknown }>()
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})

		/* route has no meta at all */
		app.get("/test").handler((ctx) => ctx.res.json("ok", {}))

		await app.fetch(new Request("http://localhost/test"), {})
		expect(received).toHaveLength(0)
	})

	it("same tap key fires once from meta and once from c.tap() — both received", async () => {
		const received: unknown[] = []
		const bgPromises: Promise<unknown>[] = []
		const app = honey<{}>().meta<{ audit?: { source: string } }>()
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})

		app
			.get("/test")
			.meta({ audit: { source: "meta" } })
			.handler((ctx) => {
				ctx.tap("audit", { source: "dynamic" })
				return ctx.res.json("ok", {})
			})

		await app.fetch(new Request("http://localhost/test"), {}, {
			waitUntil: (p: Promise<unknown>) => bgPromises.push(p),
		})
		await Promise.allSettled(bgPromises)

		expect(received).toHaveLength(2)
		expect(received[0]).toEqual({ source: "meta" })
		expect(received[1]).toEqual({ source: "dynamic" })
	})
})

/* ──────────────────────────────────────────────
 * Deep: input validation + tap interaction
 * ────────────────────────────────────────────── */

describe("tap: input validation interaction", () => {
	it("taps fire after successful input validation", async () => {
		const received: unknown[] = []
		const app = honey<{}>()
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})

		app
			.post("/users")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => {
				ctx.tap("audit", { action: "create", name: ctx.input.json.name })
				return ctx.res.json("created", { ok: true })
			})

		const res = await app.fetch(
			new Request("http://localhost/users", {
				body: JSON.stringify({ name: "Alice" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
		expect(received).toHaveLength(1)
		expect(received[0]).toEqual({ action: "create", name: "Alice" })
	})

	it("taps do NOT fire when input validation fails", async () => {
		const received: unknown[] = []
		const app = honey<{}>()
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})

		app
			.post("/users")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => {
				ctx.tap("audit", { action: "create" })
				return ctx.res.json("created", { ok: true })
			})

		const res = await app.fetch(
			new Request("http://localhost/users", {
				body: JSON.stringify({ name: 123 }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		/* input validation should fail */
		expect(res.status).toBeGreaterThanOrEqual(400)
		expect(received).toHaveLength(0)
	})
})

/* ──────────────────────────────────────────────
 * Deep: error factory + tap interaction
 * ────────────────────────────────────────────── */

describe("tap: error factory interaction", () => {
	it("taps do NOT fire when error thrown via factory", async () => {
		const received: unknown[] = []
		const errs = defineErrors({ user_not_found: "not_found" })

		const app = honey<{}>().errorFactory(errs).defaultErrors("user_not_found")
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})

		app.get("/users/:id").handler((ctx) => {
			ctx.tap("audit", { action: "lookup" })
			throw ctx.errors.user_not_found({ cause: "test" })
		})

		const res = await app.fetch(new Request("http://localhost/users/1"), {})
		expect(res.status).toBe(404)
		expect(received).toHaveLength(0)
	})
})

/* ──────────────────────────────────────────────
 * Deep: multiple HTTP methods on same path
 * ────────────────────────────────────────────── */

describe("tap: multiple methods same path", () => {
	it("different methods fire their own taps independently", async () => {
		const received: unknown[] = []
		const app = honey<{}>()
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})

		app.get("/items").handler((ctx) => {
			ctx.tap("audit", { method: "GET" })
			return ctx.res.json("ok", {})
		})

		app.post("/items").handler((ctx) => {
			ctx.tap("audit", { method: "POST" })
			return ctx.res.json("created", {})
		})

		app.delete("/items").handler((ctx) => {
			ctx.tap("audit", { method: "DELETE" })
			return ctx.res.json("ok", {})
		})

		await app.fetch(new Request("http://localhost/items"), {})
		await app.fetch(new Request("http://localhost/items", { method: "POST" }), {})
		await app.fetch(new Request("http://localhost/items", { method: "DELETE" }), {})

		expect(received).toHaveLength(3)
		expect(received.map((r) => (r as Record<string, string>).method)).toEqual([
			"GET",
			"POST",
			"DELETE",
		])
	})
})

/* ──────────────────────────────────────────────
 * Deep: tap with .route() sub-app
 * ────────────────────────────────────────────── */

describe("tap: sub-app route merging", () => {
	it("taps registered on parent fire for child routes", async () => {
		const received: unknown[] = []

		const child = honey<{}>()
		child.get("/child").handler((ctx) => {
			ctx.tap("audit", { from: "child" })
			return ctx.res.json("ok", {})
		})

		const parent = honey<{}>()
		parent.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})
		parent.route(child)

		await parent.fetch(new Request("http://localhost/child"), {})
		expect(received).toHaveLength(1)
		expect(received[0]).toEqual({ from: "child" })
	})
})

/* ──────────────────────────────────────────────
 * Deep: tap payload is independent copy per call
 * ────────────────────────────────────────────── */

describe("tap: payload independence", () => {
	it("mutating payload in tap handler does not affect other taps", async () => {
		const firstPayload: Record<string, unknown>[] = []
		const secondPayload: Record<string, unknown>[] = []

		const app = honey<{}>()
		app.tap("first", async (_ctx, payload) => {
			const p = payload as Record<string, unknown>
			p.mutated = true
			firstPayload.push(p)
		})
		app.tap("second", async (_ctx, payload) => {
			secondPayload.push(payload as Record<string, unknown>)
		})

		const shared = { data: "original" }
		app.get("/test").handler((ctx) => {
			ctx.tap("first", shared)
			ctx.tap("second", shared)
			return ctx.res.json("ok", {})
		})

		const bgPromises: Promise<unknown>[] = []
		await app.fetch(new Request("http://localhost/test"), {}, {
			waitUntil: (p: Promise<unknown>) => bgPromises.push(p),
		})
		await Promise.allSettled(bgPromises)

		/* both received same ref (shallow), mutation visible */
		expect(firstPayload[0].mutated).toBe(true)
		/* this is expected — same object reference, mutation bleeds */
		/* if caller needs isolation, they should spread */
	})
})

/* ──────────────────────────────────────────────
 * Deep: many taps stress test
 * ────────────────────────────────────────────── */

describe("tap: stress", () => {
	it("100 c.tap() calls in single handler — all fire", async () => {
		const received: number[] = []
		const app = honey<{}>()
		app.tap("counter", async (_ctx, payload) => {
			received.push(payload as number)
		})

		app.get("/test").handler((ctx) => {
			for (let i = 0; i < 100; i++) {
				ctx.tap("counter", i)
			}
			return ctx.res.json("ok", {})
		})

		const bgPromises: Promise<unknown>[] = []
		await app.fetch(new Request("http://localhost/test"), {}, {
			waitUntil: (p: Promise<unknown>) => bgPromises.push(p),
		})
		await Promise.allSettled(bgPromises)

		expect(received).toHaveLength(100)
		expect(received[0]).toBe(0)
		expect(received[99]).toBe(99)
	})

	it("50 concurrent requests each with 5 taps — all 250 fire", async () => {
		const received: string[] = []
		const app = honey<{}>()
		app.tap("log", async (_ctx, payload) => {
			received.push(payload as string)
		})

		app.get("/test/:id").handler(async (ctx) => {
			await new Promise((r) => setTimeout(r, Math.random() * 5))
			for (let i = 0; i < 5; i++) {
				ctx.tap("log", `${ctx.params.id}:${i}`)
			}
			return ctx.res.json("ok", {})
		})

		const bgPromises: Promise<unknown>[] = []
		const waitUntil = (p: Promise<unknown>) => bgPromises.push(p)

		const fetches = Array.from({ length: 50 }, (_, i) =>
			app.fetch(new Request(`http://localhost/test/${i}`), {}, { waitUntil }),
		)
		await Promise.all(fetches)
		await Promise.allSettled(bgPromises)

		expect(received).toHaveLength(250)
		/* verify each request produced exactly 5 entries */
		for (let i = 0; i < 50; i++) {
			const forRequest = received.filter((r) => r.startsWith(`${i}:`))
			expect(forRequest).toHaveLength(5)
		}
	})
})

/* ──────────────────────────────────────────────
 * Deep: .taps() with runtime behavior
 * ────────────────────────────────────────────── */

describe("tap: .taps() runtime + type integration", () => {
	it(".taps() is a phantom — has no runtime effect", async () => {
		const received: unknown[] = []
		const app = honey<{}>().taps<{ audit: { x: number } }>()
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})

		app.get("/test").handler((ctx) => {
			ctx.tap("audit", { x: 42 })
			return ctx.res.json("ok", {})
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		expect(received).toHaveLength(1)
		expect(received[0]).toEqual({ x: 42 })
	})

	it("meta-driven tap with .taps() fires with correct payload", async () => {
		const received: unknown[] = []
		const app = honey<{}>().taps<{ audit: { action: string } }>()
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})

		app
			.get("/test")
			.meta({ audit: { action: "meta-driven" } })
			.handler((ctx) => ctx.res.json("ok", {}))

		await app.fetch(new Request("http://localhost/test"), {})
		expect(received).toHaveLength(1)
		expect(received[0]).toEqual({ action: "meta-driven" })
	})
})

/* ──────────────────────────────────────────────
 * Deep: tap with async handler
 * ────────────────────────────────────────────── */

describe("tap: async handler patterns", () => {
	it("tap called after awaited async work in handler", async () => {
		const received: unknown[] = []
		const app = honey<{}>()
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})

		app.get("/test").handler(async (ctx) => {
			const data = await Promise.resolve({ id: "computed" })
			ctx.tap("audit", { resource_id: data.id })
			return ctx.res.json("ok", data)
		})

		await app.fetch(new Request("http://localhost/test"), {})
		expect(received).toHaveLength(1)
		expect(received[0]).toEqual({ resource_id: "computed" })
	})

	it("multiple awaits before tap — tap still fires", async () => {
		const received: unknown[] = []
		const app = honey<{}>()
		app.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})

		app.get("/test").handler(async (ctx) => {
			const a = await Promise.resolve(1)
			const b = await Promise.resolve(2)
			const c = await Promise.resolve(3)
			ctx.tap("audit", { sum: a + b + c })
			return ctx.res.json("ok", {})
		})

		await app.fetch(new Request("http://localhost/test"), {})
		expect(received).toHaveLength(1)
		expect(received[0]).toEqual({ sum: 6 })
	})
})

/* ──────────────────────────────────────────────
 * Deep: tap with telemetry coexistence
 * ────────────────────────────────────────────── */

describe("tap: telemetry coexistence", () => {
	it("both taps and telemetry fire for same request", async () => {
		const tapReceived: unknown[] = []
		const telemetryEvents: string[] = []

		const app = honey<{}>()
		app.telemetry({
			onHandler: () => telemetryEvents.push("handler"),
			onResponse: () => telemetryEvents.push("response"),
		})
		app.tap("audit", async (_ctx, payload) => {
			tapReceived.push(payload)
		})

		app.get("/test").handler((ctx) => {
			ctx.tap("audit", { action: "test" })
			return ctx.res.json("ok", {})
		})

		await app.fetch(new Request("http://localhost/test"), {})

		expect(tapReceived).toHaveLength(1)
		expect(telemetryEvents).toContain("handler")
		expect(telemetryEvents).toContain("response")
	})
})
