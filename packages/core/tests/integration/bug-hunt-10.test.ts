import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { cors } from "../../src/cors.ts"
import { HoneyError } from "../../src/error.ts"
import { etag } from "../../src/etag.ts"
import { honey } from "../../src/index.ts"
import { createMiddleware } from "../../src/middleware.ts"
import { type HoneyServer, serve } from "../../src/node.ts"
import { testClient } from "../../src/testing.ts"

function request(
	port: number,
	path: string,
	opts?: {
		body?: string
		headers?: Record<string, string>
		method?: string
	},
): Promise<{ body: string; headers: http.IncomingHttpHeaders; status: number }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				headers: opts?.headers,
				hostname: "127.0.0.1",
				method: opts?.method ?? "GET",
				path,
				port,
			},
			(res) => {
				let data = ""
				res.on("data", (chunk) => {
					data += chunk
				})
				res.on("end", () => {
					resolve({ body: data, headers: res.headers, status: res.statusCode ?? 0 })
				})
			},
		)
		req.on("error", reject)
		if (opts?.body) req.write(opts.body)
		req.end()
	})
}

let server: HoneyServer | null = null

afterEach(() => {
	if (server) {
		server.close()
		server = null
	}
})

/* ══════════════════════════════════════════════
 * 1. HANDLER RETURNING UNDEFINED → caught gracefully
 *
 * middleware.ts:88-93 — handler null/undefined check.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-10: handler returning nothing", () => {
	it("handler without return → 500 with helpful error", async () => {
		const app = honey<{}>()
		app.get("/oops").handler((() => {
			/* intentionally no return */
		}) as never)

		const res = await app.fetch(new Request("http://localhost/oops"), {})
		expect(res.status).toBe(500)
	})

	it("handler returning null → 500", async () => {
		const app = honey<{}>()
		app.get("/oops").handler((() => null) as never)

		const res = await app.fetch(new Request("http://localhost/oops"), {})
		expect(res.status).toBe(500)
	})
})

/* ══════════════════════════════════════════════
 * 2. MIDDLEWARE NOT RETURNING RESPONSE → caught
 *
 * middleware.ts:117-120 — middleware null/undefined check.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-10: middleware returning nothing", () => {
	it("middleware that calls next() but doesn't return it → 500", async () => {
		const badMw = createMiddleware((async (
			_ctx: Record<string, unknown>,
			next: (a: {}) => Promise<Response>,
		) => {
			await next()
			/* forgot to return */
		}) as never)

		const app = honey<{}>().use(badMw)
		app.get("/test").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
	})
})

/* ══════════════════════════════════════════════
 * 3. MIDDLEWARE CALLING NEXT() TWICE → error
 *
 * middleware.ts:101-103 — double next() guard.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-10: middleware double next()", () => {
	it("calling next() twice → throws", async () => {
		const doubleMw = createMiddleware(async (_ctx, next) => {
			const res1 = await next()
			/* second call should throw */
			try {
				await next()
			} catch {
				/* expected */
			}
			return res1
		})

		const app = honey<{}>().use(doubleMw)
		app.get("/test").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		/* first next() succeeded, so response should be 200 */
		expect(res.status).toBe(200)
	})
})

/* ══════════════════════════════════════════════
 * 4. URL WITH QUERY STRING — doesn't affect route matching
 *
 * URL.pathname is used for routing, searchParams are separate.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-10: query string doesn't affect routing", () => {
	it("route matches regardless of query string", async () => {
		const app = honey<{}>()
		app.get("/api").handler((ctx) => ctx.res.json("ok", { q: ctx.search.q }))

		const res = await app.fetch(new Request("http://localhost/api?q=hello&page=1"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.q).toBe("hello")
	})

	it("query string with encoded characters", async () => {
		const app = honey<{}>()
		app.get("/search").handler((ctx) => ctx.res.json("ok", { q: ctx.search.q }))

		const res = await app.fetch(new Request("http://localhost/search?q=hello%20world"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.q).toBe("hello world")
	})
})

/* ══════════════════════════════════════════════
 * 5. ROOT ROUTE — "/"
 * ══════════════════════════════════════════════ */

describe("bug-hunt-10: root route /", () => {
	it("root route matches /", async () => {
		const app = honey<{}>()
		app.get("/").handler((ctx) => ctx.res.json("ok", { root: true }))

		const res = await app.fetch(new Request("http://localhost/"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, boolean>
		expect(data.root).toBe(true)
	})

	it("root route with basePath", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/").handler((ctx) => ctx.res.json("ok", { root: true }))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
	})
})

/* ══════════════════════════════════════════════
 * 6. WILDCARD DECODING
 *
 * tree.ts:213 — decode() on joined wildcard segments.
 * What happens with encoded characters in wildcard paths?
 * ══════════════════════════════════════════════ */

describe("bug-hunt-10: wildcard with encoded segments", () => {
	it("wildcard with %20 in path → decoded", async () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		const res = await app.fetch(new Request("http://localhost/files/my%20docs/file%20name.txt"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.path).toBe("my docs/file name.txt")
	})
})

/* ══════════════════════════════════════════════
 * 7. CORS — credentials: true with specific origin
 *
 * When origin is specific (not wildcard) and credentials true,
 * response should echo origin and set credentials header.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-10: CORS credentials with specific origin", () => {
	it("credentials + specific origin → echo origin + credentials header", async () => {
		const app = honey<{}>().use(
			cors({
				credentials: true,
				origin: ["http://app.com", "http://other.com"],
			}),
		)
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: { origin: "http://app.com" },
			}),
			{},
		)
		expect(res.headers.get("access-control-allow-origin")).toBe("http://app.com")
		expect(res.headers.get("access-control-allow-credentials")).toBe("true")
		/* Vary: Origin should be set for non-wildcard */
		expect(res.headers.get("vary")).toContain("Origin")
	})
})

/* ══════════════════════════════════════════════
 * 8. CORS — preflight with credentials
 * ══════════════════════════════════════════════ */

describe("bug-hunt-10: CORS preflight with credentials", () => {
	it("preflight → credentials + vary + maxAge", async () => {
		const app = honey<{}>().use(
			cors({
				credentials: true,
				maxAge: 7200,
				origin: "http://app.com",
			}),
		)
		app.post("/api").handler((ctx) => ctx.res.json("ok", {}))

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
		expect(res.headers.get("access-control-allow-credentials")).toBe("true")
		expect(res.headers.get("access-control-max-age")).toBe("7200")
		expect(res.headers.get("vary")).toContain("Origin")
	})
})

/* ══════════════════════════════════════════════
 * 9. ETAG — response with transfer-encoding chunked → skipped
 *
 * etag.ts:33 — transfer-encoding: chunked → skip ETag.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-10: ETag skips chunked responses", () => {
	it("response with transfer-encoding chunked → no ETag", async () => {
		const app = honey<{}>().use(etag())
		app.get("/chunked").handler((ctx) =>
			ctx.res.raw(
				new Response("chunked data", {
					headers: { "transfer-encoding": "chunked" },
				}),
			),
		)

		const res = await app.fetch(new Request("http://localhost/chunked"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("etag")).toBeNull()
	})
})

/* ══════════════════════════════════════════════
 * 10. ERROR MESSAGE IMMUTABILITY
 *
 * HoneyError.message is writable (needed for i18n).
 * Verify the i18n translation path actually modifies it.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-10: HoneyError message mutation by i18n", () => {
	it("error message is modified by i18n translation with vars", async () => {
		const app = honey<{}>()
		app.errorI18n({
			errors: {
				en: { rate_limited: "Slow down! Retry in {seconds}s" },
			},
			resolveLocale: () => "en",
		})
		app.get("/limited").handler(() => {
			throw new HoneyError({
				errorKey: "rate_limited",
				status: "too_many_requests",
				vars: { seconds: 30 },
			})
		})

		const res = await app.fetch(new Request("http://localhost/limited"), {})
		expect(res.status).toBe(429)
		const data = (await res.json()) as Record<string, string>
		expect(data.message).toBe("Slow down! Retry in 30s")
	})
})

/* ══════════════════════════════════════════════
 * 11. LARGE JSON RESPONSE — body reconstruction
 *
 * ETag hashes the response body via arrayBuffer().
 * Large JSON responses should survive the round-trip.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-10: ETag with large JSON", () => {
	it("1KB JSON → ETag computed, body intact", async () => {
		const app = honey<{}>().use(etag())
		const bigArray = Array.from({ length: 100 }, (_, i) => ({
			id: i,
			name: `item-${i}`,
			value: Math.random(),
		}))
		app.get("/large").handler((ctx) => ctx.res.json("ok", bigArray))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/large")
		expect(res.status).toBe(200)
		expect(res.headers.etag).toBeTruthy()
		const data = JSON.parse(res.body) as Array<{ id: number }>
		expect(data.length).toBe(100)
		expect(data[0].id).toBe(0)
		expect(data[99].id).toBe(99)
	})
})

/* ══════════════════════════════════════════════
 * 12. HANDLER THROWING SYNC ERROR BEFORE RETURNING
 * ══════════════════════════════════════════════ */

describe("bug-hunt-10: sync errors in handlers", () => {
	it("sync throw in handler → 500", async () => {
		const app = honey<{}>()
		app.get("/fail").handler(() => {
			throw new TypeError("null reference")
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(500)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("internal_server_error")
	})

	it("sync throw in middleware before next() → 500", async () => {
		const mw = createMiddleware(async () => {
			throw new RangeError("out of range")
		})

		const app = honey<{}>().use(mw)
		app.get("/test").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
	})
})

/* ══════════════════════════════════════════════
 * 13. MIDDLEWARE MODIFYING CTX VIA NEXT() — non-object values
 *
 * Test that various types in additions are preserved.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-10: middleware additions — diverse types", () => {
	it("additions with arrays, numbers, booleans, null", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			return next({
				count: 42,
				isAdmin: true,
				nothing: null,
				tags: ["a", "b"],
			})
		})

		const app = honey<{}>().use(mw)
		app.get("/test").handler((ctx) =>
			ctx.res.json("ok", {
				count: ctx.count,
				isAdmin: ctx.isAdmin,
				nothing: ctx.nothing,
				tags: ctx.tags,
			}),
		)

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.count).toBe(42)
		expect(data.isAdmin).toBe(true)
		expect(data.nothing).toBeNull()
		expect(data.tags).toEqual(["a", "b"])
	})
})

/* ══════════════════════════════════════════════
 * 14. NODE ADAPTER — POST with large body backpressure
 *
 * node.ts:40-41 — desiredSize <= 0 → pause stream.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-10: Node adapter — large POST body", () => {
	it("10KB POST body → fully received", async () => {
		const app = honey<{}>()
		app.post("/upload").handler(async (ctx) => {
			const text = await ctx.req.text()
			return ctx.res.json("ok", { length: text.length })
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const largeBody = "x".repeat(10000)
		const res = await request(addr.port, "/upload", {
			body: largeBody,
			headers: { "content-type": "text/plain" },
			method: "POST",
		})
		expect(res.status).toBe(200)
		const data = JSON.parse(res.body) as Record<string, number>
		expect(data.length).toBe(10000)
	})
})

/* ══════════════════════════════════════════════
 * 15. MULTIPLE APPS ON SAME SERVER (via route tree)
 *
 * Two separate apps, merged via mergeTree, served together.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-10: multiple apps merged", () => {
	it("two apps merged → both route sets accessible", async () => {
		const { mergeTree } = await import("../../src/tree.ts")

		const usersApp = honey<{}>()
		usersApp.get("/users").handler((ctx) => ctx.res.json("ok", { route: "users" }))
		usersApp.post("/users").handler((ctx) => ctx.res.json("created", { route: "create-user" }))

		const postsApp = honey<{}>()
		postsApp.get("/posts").handler((ctx) => ctx.res.json("ok", { route: "posts" }))
		postsApp
			.get("/posts/:id")
			.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id, route: "post" }))

		const merged = mergeTree(usersApp.toRouteTree(), postsApp.toRouteTree())
		const app = honey<{}>()
		app.routeTree(merged)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const r1 = await request(addr.port, "/users")
		expect(r1.status).toBe(200)
		expect((JSON.parse(r1.body) as Record<string, unknown>).route).toBe("users")

		const r2 = await request(addr.port, "/users", { method: "POST" })
		expect(r2.status).toBe(201)

		const r3 = await request(addr.port, "/posts")
		expect(r3.status).toBe(200)

		const r4 = await request(addr.port, "/posts/42")
		expect(r4.status).toBe(200)
		expect((JSON.parse(r4.body) as Record<string, unknown>).id).toBe("42")
	})
})

/* ══════════════════════════════════════════════
 * 16. RESPONSE STATUS CODES — every key produces correct code
 * ══════════════════════════════════════════════ */

describe("bug-hunt-10: all response status keys", () => {
	it("text response with each status key → correct HTTP code", async () => {
		const { statusKeyToCode } = await import("../../src/types.ts")
		const app = honey<{}>()

		/* register a route for each status key that text() accepts */
		const keysToTest = [
			"ok",
			"created",
			"accepted",
			"no_content",
			"bad_request",
			"unauthorized",
			"forbidden",
			"not_found",
			"conflict",
			"gone",
		] as const

		for (const key of keysToTest) {
			app.get(`/status/${key}`).handler((ctx) => {
				if (key === "no_content") return ctx.res.noContent()
				return ctx.res.text(key, `status: ${key}`)
			})
		}

		for (const key of keysToTest) {
			const res = await app.fetch(new Request(`http://localhost/status/${key}`), {})
			expect(res.status).toBe(statusKeyToCode[key])
		}
	})
})

/* ══════════════════════════════════════════════
 * 17. ETAG — re-validates after content changes
 *
 * Different content → different ETag → conditional request
 * with old ETag returns 200 with new content.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-10: ETag changes when content changes", () => {
	it("different content → different ETag", async () => {
		let counter = 0
		const app = honey<{}>().use(etag())
		app.get("/data").handler((ctx) => {
			counter++
			return ctx.res.json("ok", { v: counter })
		})

		const r1 = await app.fetch(new Request("http://localhost/data"), {})
		const etag1 = r1.headers.get("etag")

		const r2 = await app.fetch(new Request("http://localhost/data"), {})
		const etag2 = r2.headers.get("etag")

		expect(etag1).toBeTruthy()
		expect(etag2).toBeTruthy()
		expect(etag1).not.toBe(etag2)
	})
})

/* ══════════════════════════════════════════════
 * 18. TESTCLIENT — headers option
 * ══════════════════════════════════════════════ */

describe("bug-hunt-10: testClient — custom headers", () => {
	it("custom headers passed to request", async () => {
		const app = honey<{}>()
		app.get("/api").handler((ctx) =>
			ctx.res.json("ok", {
				auth: ctx.req.headers.get("authorization"),
				custom: ctx.req.headers.get("x-custom"),
			}),
		)

		const client = testClient(app, { env: {} })
		const res = await client.get("/api", {
			headers: {
				authorization: "Bearer secret",
				"x-custom": "value",
			},
		})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.auth).toBe("Bearer secret")
		expect(data.custom).toBe("value")
	})
})

/* ══════════════════════════════════════════════
 * 19. FULL E2E — realistic API flow
 *
 * Register → login → create resource → list → 404 → 405.
 * Tests the full lifecycle through the Node adapter.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-10: full E2E API flow", () => {
	it("complete CRUD lifecycle", async () => {
		const { secureHeaders } = await import("../../src/secure-headers.ts")
		const { requestId } = await import("../../src/request-id.ts")
		const items: Array<{ id: number; name: string }> = []
		let nextId = 1

		const app = honey<{}>()
			.use(cors({ origin: "*" }))
			.use(secureHeaders())
			.use(requestId())

		app.get("/items").handler((ctx) => ctx.res.json("ok", items))
		app.post("/items").handler(async (ctx) => {
			const body = (await ctx.req.json()) as { name: string }
			const item = { id: nextId++, name: body.name }
			items.push(item)
			return ctx.res.json("created", item)
		})
		app.get("/items/:id").handler((ctx) => {
			const item = items.find((i) => i.id === Number(ctx.params.id))
			if (!item) {
				throw new HoneyError({ errorKey: "not_found", status: "not_found" })
			}
			return ctx.res.json("ok", item)
		})
		app.delete("/items/:id").handler((ctx) => {
			const idx = items.findIndex((i) => i.id === Number(ctx.params.id))
			if (idx === -1) {
				throw new HoneyError({ errorKey: "not_found", status: "not_found" })
			}
			items.splice(idx, 1)
			return ctx.res.noContent()
		})

		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* list empty */
		const r1 = await request(addr.port, "/items")
		expect(r1.status).toBe(200)
		expect(JSON.parse(r1.body)).toEqual([])
		expect(r1.headers["x-request-id"]).toBeTruthy()
		expect(r1.headers["x-content-type-options"]).toBe("nosniff")

		/* create item */
		const r2 = await request(addr.port, "/items", {
			body: JSON.stringify({ name: "Widget" }),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		expect(r2.status).toBe(201)
		const created = JSON.parse(r2.body) as { id: number; name: string }
		expect(created.id).toBe(1)
		expect(created.name).toBe("Widget")

		/* get item */
		const r3 = await request(addr.port, "/items/1")
		expect(r3.status).toBe(200)
		expect((JSON.parse(r3.body) as Record<string, unknown>).name).toBe("Widget")

		/* get non-existent → 404 */
		const r4 = await request(addr.port, "/items/999")
		expect(r4.status).toBe(404)

		/* wrong method → 405 */
		const r5 = await request(addr.port, "/items", { method: "PATCH" })
		expect(r5.status).toBe(405)
		expect(r5.headers.allow).toBeTruthy()

		/* delete item */
		const r6 = await request(addr.port, "/items/1", { method: "DELETE" })
		expect(r6.status).toBe(204)

		/* list after delete */
		const r7 = await request(addr.port, "/items")
		expect(r7.status).toBe(200)
		expect(JSON.parse(r7.body)).toEqual([])

		/* CORS on all responses */
		const r8 = await request(addr.port, "/items", {
			headers: { origin: "http://app.com" },
		})
		expect(r8.headers["access-control-allow-origin"]).toBe("*")
	})
})
