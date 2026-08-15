import { describe, expect, it } from "vitest"
import * as z from "zod"
import { sign, verify } from "../../../src/cookie-sign.ts"
import { cors } from "../../../src/cors.ts"
import { honey } from "../../../src/index.ts"
import { createMiddleware } from "../../../src/middleware.ts"
import { mergeTree } from "../../../src/tree.ts"

/* ═══════════════════════════════════════════
 * 405 with multiple methods on same path
 * ═══════════════════════════════════════════ */

describe("405: multiple methods same path", () => {
	it("PATCH to path with GET+POST+DELETE → 405, Allow lists all three", async () => {
		const app = honey<{}>()
		app.get("/items").handler((ctx) => ctx.res.json("ok", []))
		app.post("/items").handler((ctx) => ctx.res.json("created", {}))
		app.delete("/items").handler((ctx) => ctx.res.noContent())

		const res = await app.fetch(new Request("http://localhost/items", { method: "PATCH" }), {})
		expect(res.status).toBe(405)
		const allow = res.headers.get("allow") ?? ""
		expect(allow).toContain("GET")
		expect(allow).toContain("POST")
		expect(allow).toContain("DELETE")
	})
})

/* ═══════════════════════════════════════════
 * Cookie signing: unicode, empty secrets
 * ═══════════════════════════════════════════ */

describe("cookie-sign edge cases", () => {
	const secret = "test-secret-key-at-least-32-chars-long"

	it("signs and verifies unicode value", async () => {
		const signed = await sign("caf\u00e9-\u{1F525}", secret)
		const value = await verify(signed, [secret])
		expect(value).toBe("caf\u00e9-\u{1F525}")
	})

	it("signs and verifies emoji value", async () => {
		const signed = await sign("\u{1F680}\u{1F30D}", secret)
		const value = await verify(signed, [secret])
		expect(value).toBe("\u{1F680}\u{1F30D}")
	})

	it("verify with empty secrets array → null", async () => {
		const signed = await sign("val", secret)
		const value = await verify(signed, [])
		expect(value).toBeNull()
	})

	it("signs and verifies empty string value", async () => {
		const signed = await sign("", secret)
		expect(signed.startsWith(".")).toBe(true)
		const value = await verify(signed, [secret])
		expect(value).toBe("")
	})

	it("signs and verifies very long value", async () => {
		const longVal = "x".repeat(10000)
		const signed = await sign(longVal, secret)
		const value = await verify(signed, [secret])
		expect(value).toBe(longVal)
	})
})

/* ═══════════════════════════════════════════
 * mergeTree conflicts
 * ═══════════════════════════════════════════ */

describe("mergeTree", () => {
	it("merges two trees with non-overlapping routes", () => {
		const app1 = honey<{}>()
		app1.get("/a").handler((ctx) => ctx.res.json("ok", {}))

		const app2 = honey<{}>()
		app2.get("/b").handler((ctx) => ctx.res.json("ok", {}))

		const merged = mergeTree(app1.toRouteTree(), app2.toRouteTree())
		expect(merged.root).toBeDefined()
	})

	it("throws on duplicate method for same path", () => {
		const app1 = honey<{}>()
		app1.get("/x").handler((ctx) => ctx.res.json("ok", {}))

		const app2 = honey<{}>()
		app2.get("/x").handler((ctx) => ctx.res.json("ok", {}))

		expect(() => mergeTree(app1.toRouteTree(), app2.toRouteTree())).toThrow("Merge conflict")
	})

	it("allows different methods on same path", () => {
		const app1 = honey<{}>()
		app1.get("/x").handler((ctx) => ctx.res.json("ok", {}))

		const app2 = honey<{}>()
		app2.post("/x").handler((ctx) => ctx.res.json("created", {}))

		expect(() => mergeTree(app1.toRouteTree(), app2.toRouteTree())).not.toThrow()
	})
})

/* ═══════════════════════════════════════════
 * Body ignored for GET/DELETE/HEAD/OPTIONS
 * ═══════════════════════════════════════════ */

describe("body skipped for bodyless methods", () => {
	it("GET with json schema — body not consumed", async () => {
		const app = honey<{}>()
		app
			.get("/search")
			.input({ search: z.object({ q: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input))

		/* GET with a body — body should be ignored, search validated */
		const res = await app.fetch(
			new Request("http://localhost/search?q=test", {
				headers: { "content-type": "application/json" },
				method: "GET",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, Record<string, string>>
		expect(data.search.q).toBe("test")
	})

	it("DELETE with form schema and body — body not consumed", async () => {
		const app = honey<{}>()
		app
			.delete("/item/:id")
			.input({ params: z.object({ id: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", { id: ctx.input.params.id }))

		const res = await app.fetch(new Request("http://localhost/item/42", { method: "DELETE" }), {})
		expect(res.status).toBe(200)
	})
})

/* ═══════════════════════════════════════════
 * Middleware ordering: global → chain → route
 * ═══════════════════════════════════════════ */

describe("middleware ordering", () => {
	it("global middleware runs before route middleware", async () => {
		const order: string[] = []

		const globalMw = createMiddleware(async (_ctx, next) => {
			order.push("global")
			return next()
		})
		const routeMw = createMiddleware(async (_ctx, next) => {
			order.push("route")
			return next()
		})

		const app = honey<{}>().use(globalMw)
		app
			.get("/test")
			.use(routeMw)
			.handler((ctx) => {
				order.push("handler")
				return ctx.res.json("ok", {})
			})

		await app.fetch(new Request("http://localhost/test"), {})
		expect(order).toEqual(["global", "route", "handler"])
	})

	it("multiple global middlewares run in registration order", async () => {
		const order: string[] = []

		const mw1 = createMiddleware(async (_ctx, next) => {
			order.push("first")
			return next()
		})
		const mw2 = createMiddleware(async (_ctx, next) => {
			order.push("second")
			return next()
		})

		const app = honey<{}>().use(mw1).use(mw2)
		app.get("/test").handler((ctx) => {
			order.push("handler")
			return ctx.res.json("ok", {})
		})

		await app.fetch(new Request("http://localhost/test"), {})
		expect(order).toEqual(["first", "second", "handler"])
	})
})

/* ═══════════════════════════════════════════
 * CORS preflight
 * ═══════════════════════════════════════════ */

describe("CORS preflight", () => {
	it("OPTIONS preflight with credentials → 204 with correct headers", async () => {
		const app = honey<{}>().use(cors({ credentials: true, origin: "http://app.com" }))
		app.post("/api").handler((ctx) => ctx.res.json("created", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: {
					"access-control-request-method": "POST",
					origin: "http://app.com",
				},
				method: "OPTIONS",
			}),
			{},
		)
		expect(res.status).toBe(204)
		expect(res.headers.get("access-control-allow-origin")).toBe("http://app.com")
		expect(res.headers.get("access-control-allow-credentials")).toBe("true")
	})

	it("OPTIONS preflight from wrong origin → no CORS headers", async () => {
		const app = honey<{}>().use(cors({ origin: "http://app.com" }))
		app.post("/api").handler((ctx) => ctx.res.json("created", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: {
					"access-control-request-method": "POST",
					origin: "http://evil.com",
				},
				method: "OPTIONS",
			}),
			{},
		)
		expect(res.headers.get("access-control-allow-origin")).not.toBe("http://evil.com")
	})
})

/* ═══════════════════════════════════════════
 * Wrong Content-Type → 415/422
 * ═══════════════════════════════════════════ */

describe("unsupported media type", () => {
	it("POST with text/plain to json-expecting route → 422", async () => {
		const app = honey<{}>()
		app
			.post("/api")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				body: "just text",
				headers: { "content-type": "text/plain" },
				method: "POST",
			}),
			{},
		)
		/* unsupported media type */
		expect(res.status).toBe(415)
	})

	it("POST with no content-type to json-expecting route → 415", async () => {
		const app = honey<{}>()
		app
			.post("/api")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				body: '{"name":"test"}',
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(415)
	})
})
