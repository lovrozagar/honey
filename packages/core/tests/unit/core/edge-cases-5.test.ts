import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"

/* ═══════════════════════════════════════════
 * Route tree round-trip: export → import
 * ═══════════════════════════════════════════ */

describe("routeTree round-trip", () => {
	it("export tree → import → all routes work", async () => {
		const original = honey<{}>()
		original.get("/users").handler((ctx) => ctx.res.json("ok", { route: "list" }))
		original.get("/users/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))
		original.post("/users").handler((ctx) => ctx.res.json("created", { route: "create" }))
		original.delete("/users/:id").handler((ctx) => ctx.res.noContent())

		const tree = original.toRouteTree()

		const clone = honey<{}>()
		clone.routeTree(tree)

		const r1 = await clone.fetch(new Request("http://localhost/users"), {})
		expect(r1.status).toBe(200)
		const d1 = (await r1.json()) as Record<string, string>
		expect(d1.route).toBe("list")

		const r2 = await clone.fetch(new Request("http://localhost/users/42"), {})
		expect(r2.status).toBe(200)
		const d2 = (await r2.json()) as Record<string, string>
		expect(d2.id).toBe("42")

		const r3 = await clone.fetch(new Request("http://localhost/users", { method: "POST" }), {})
		expect(r3.status).toBe(201)

		const r4 = await clone.fetch(new Request("http://localhost/users/42", { method: "DELETE" }), {})
		expect(r4.status).toBe(204)
	})

	it("round-trip preserves route pattern", async () => {
		const original = honey<{}>()
		original.get("/items/:id").handler((ctx) => ctx.res.json("ok", { pattern: ctx.routePattern }))

		const clone = honey<{}>()
		clone.routeTree(original.toRouteTree())

		const res = await clone.fetch(new Request("http://localhost/items/99"), {})
		const data = (await res.json()) as Record<string, string>
		expect(data.pattern).toBe("/items/:id")
	})

	it("404 on route not in imported tree", async () => {
		const original = honey<{}>()
		original.get("/exists").handler((ctx) => ctx.res.json("ok", {}))

		const clone = honey<{}>()
		clone.routeTree(original.toRouteTree())

		const res = await clone.fetch(new Request("http://localhost/nope"), {})
		expect(res.status).toBe(404)
	})

	it("wildcard routes survive round-trip", async () => {
		const original = honey<{}>()
		original.get("/files/*path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		const clone = honey<{}>()
		clone.routeTree(original.toRouteTree())

		const res = await clone.fetch(new Request("http://localhost/files/a/b/c"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.path).toBe("a/b/c")
	})
})

/* ═══════════════════════════════════════════
 * basePath via defaults
 * ═══════════════════════════════════════════ */

describe("basePath via defaults", () => {
	it("basePath strips prefix from matching requests", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/users").handler((ctx) => ctx.res.json("ok", { from: "users" }))

		const res = await app.fetch(new Request("http://localhost/api/users"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.from).toBe("users")
	})

	it("basePath → request without prefix returns 404", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/users").handler((ctx) => ctx.res.json("ok", {}))

		/* basePath prefixes routes at registration, so /users without prefix is 404 */
		const res = await app.fetch(new Request("http://localhost/users"), {})
		expect(res.status).toBe(404)
	})

	it("basePath root request → matches /", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/").handler((ctx) => ctx.res.json("ok", { root: true }))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
	})

	it("basePath with trailing slash in config", async () => {
		const app = honey<{}>().basePath("/api/")
		app.get("/users").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/api/users"), {})
		expect(res.status).toBe(200)
	})
})

/* ═══════════════════════════════════════════
 * Error formatter
 * ═══════════════════════════════════════════ */

describe("error formatter", () => {
	it("custom errorFormatter shapes error response", async () => {
		const app = honey<{}>().defaultErrorFormatter((error, defaultShape) => ({
			...defaultShape,
			code: error.errorKey.toUpperCase(),
			timestamp: "2026-01-01T00:00:00Z",
		}))
		app.get("/fail").handler(() => {
			throw new Error("boom")
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(500)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.code).toBe("INTERNAL_SERVER_ERROR")
		expect(data.timestamp).toBe("2026-01-01T00:00:00Z")
		expect(data.error_key).toBe("internal_server_error")
	})

	it("errorFormatter can remove fields from response", async () => {
		const app = honey<{}>().defaultErrorFormatter((error) => ({
			error: error.errorKey,
		}))
		app.get("/fail").handler(() => {
			throw new Error("boom")
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error).toBe("internal_server_error")
		expect(data.error_key).toBeUndefined()
		expect(data.message).toBeUndefined()
	})
})

/* ═══════════════════════════════════════════
 * Custom onError handler
 * ═══════════════════════════════════════════ */

describe("custom onError", () => {
	it("onError can return custom response", async () => {
		const app = honey<{}>().onError(() => {
			return new Response(JSON.stringify({ custom: true }), {
				headers: { "content-type": "application/json" },
				status: 503,
			})
		})
		app.get("/fail").handler(() => {
			throw new Error("service down")
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(503)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.custom).toBe(true)
	})

	it("onError returning undefined → default error response", async () => {
		const app = honey<{}>().onError(() => undefined)
		app.get("/fail").handler(() => {
			throw new Error("boom")
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(500)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("internal_server_error")
	})

	it("onError receives the thrown error", async () => {
		let receivedError: unknown
		const app = honey<{}>().onError((err) => {
			receivedError = err
			return undefined
		})
		app.get("/fail").handler(() => {
			throw new Error("specific message")
		})

		await app.fetch(new Request("http://localhost/fail"), {})
		expect(receivedError).toBeInstanceOf(Error)
		expect((receivedError as Error).message).toBe("specific message")
	})
})

/* ═══════════════════════════════════════════
 * WS upgrade edge cases
 * ═══════════════════════════════════════════ */

describe("WS without adapter", () => {
	it("WS upgrade request without adapter → 500", async () => {
		const app = honey<{}>()
		app.ws("/chat").handler({ onMessage() {} })

		const res = await app.fetch(
			new Request("http://localhost/chat", {
				headers: { connection: "Upgrade", upgrade: "websocket" },
			}),
			{},
		)
		expect(res.status).toBe(500)
	})

	it("WS route hit without upgrade header → 426", async () => {
		const app = honey<{}>()
		app.ws("/chat").handler({ onMessage() {} })

		const res = await app.fetch(new Request("http://localhost/chat"), {})
		expect(res.status).toBe(426)
	})
})
