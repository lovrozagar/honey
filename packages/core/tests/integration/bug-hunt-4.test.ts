import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { cors } from "../../src/cors.ts"
import { HoneyError } from "../../src/error.ts"
import { honey } from "../../src/index.ts"
import { createMiddleware } from "../../src/middleware.ts"
import { type HoneyServer, serve } from "../../src/node.ts"
import { parseCookies } from "../../src/validation.ts"

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

/* ──────────────────────────────────────────────
 * 1. Concurrent requests don't share middleware state
 *
 * Each request should get its own middleware chain execution.
 * Shared mutation between concurrent requests would be a bug.
 * ────────────────────────────────────────────── */

describe("bug-hunt-4: concurrent request isolation", () => {
	it("10 concurrent requests all get correct isolated responses", async () => {
		const app = honey<{}>()
		app.get("/echo/:id").handler(async (ctx) => {
			/* simulate variable work */
			await new Promise((r) => setTimeout(r, Math.random() * 10))
			return ctx.res.json("ok", { id: ctx.params.id })
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const promises = Array.from({ length: 10 }, (_, i) => request(addr.port, `/echo/${i}`))
		const results = await Promise.all(promises)

		for (let i = 0; i < 10; i++) {
			expect(results[i].status).toBe(200)
			const data = JSON.parse(results[i].body) as Record<string, unknown> as Record<string, string>
			expect(data.id).toBe(String(i))
		}
	})

	it("concurrent requests with middleware context don't leak", async () => {
		let counter = 0
		const countMw = createMiddleware(async (_ctx, next) => {
			const myCount = ++counter
			await new Promise((r) => setTimeout(r, Math.random() * 5))
			return next({ reqCount: myCount })
		})

		const app = honey<{}>().use(countMw)
		app.get("/count").handler((ctx) => ctx.res.json("ok", { count: ctx.reqCount }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const promises = Array.from({ length: 5 }, () => request(addr.port, "/count"))
		const results = await Promise.all(promises)

		/* each response should have a unique counter value */
		const counts = results.map((r) => (JSON.parse(r.body) as Record<string, number>).count)
		const unique = new Set(counts)
		expect(unique.size).toBe(5)
	})
})

/* ──────────────────────────────────────────────
 * 2. Very long URL path
 *
 * Router should handle extremely long paths without crashing.
 * ────────────────────────────────────────────── */

describe("bug-hunt-4: extreme path lengths", () => {
	it("very long path → 404, no crash", async () => {
		const app = honey<{}>()
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const longPath = `/api/${"a".repeat(10000)}`
		const res = await app.fetch(new Request(`http://localhost${longPath}`), {})
		expect(res.status).toBe(404)
	})

	it("many path segments → 404, no crash", async () => {
		const app = honey<{}>()
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const manySegments = `/api${"/seg".repeat(500)}`
		const res = await app.fetch(new Request(`http://localhost${manySegments}`), {})
		expect(res.status).toBe(404)
	})
})

/* ──────────────────────────────────────────────
 * 3. parseCookies with adversarial input
 *
 * Extremely long cookie headers, many semicolons,
 * unicode characters, null bytes.
 * ────────────────────────────────────────────── */

describe("bug-hunt-4: parseCookies adversarial input", () => {
	it("1000 cookie pairs → no crash", () => {
		const pairs = Array.from({ length: 1000 }, (_, i) => `k${i}=v${i}`).join("; ")
		const result = parseCookies(pairs)
		expect(Object.keys(result).length).toBe(1000)
		expect(result.k0).toBe("v0")
		expect(result.k999).toBe("v999")
	})

	it("cookie with unicode characters", () => {
		const result = parseCookies("name=日本語; emoji=🍯")
		expect(result.name).toBe("日本語")
		expect(result.emoji).toBe("🍯")
	})

	it("cookie with spaces in value", () => {
		const result = parseCookies("msg=hello world; other=test")
		expect(result.msg).toBe("hello world")
	})

	it("empty value cookie", () => {
		const result = parseCookies("empty=")
		expect(result.empty).toBe("")
	})

	it("only semicolons → empty result", () => {
		const result = parseCookies(";;;")
		expect(Object.keys(result).length).toBe(0)
	})
})

/* ──────────────────────────────────────────────
 * 4. middleware next() called with reserved keys silently drops them
 *
 * middleware.ts:102-104 strips reserved keys from additions.
 * Verify this works for all reserved keys.
 * ────────────────────────────────────────────── */

describe("bug-hunt-4: reserved key protection completeness", () => {
	it("next({ req: ... }) doesn't overwrite ctx.req", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			const fakeReq = new Request("http://evil.com/hacked")
			return next({ req: fakeReq })
		})

		const app = honey<{}>().use(mw)
		app.get("/test").handler((ctx) => ctx.res.json("ok", { url: ctx.req.url }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.url).toContain("localhost")
		expect(data.url).not.toContain("evil.com")
	})

	it("next({ env: ... }) doesn't overwrite ctx.env", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			return next({ env: { SECRET: "stolen" } })
		})

		const app = honey<{ DB: string }>().use(mw)
		app.get("/test").handler((ctx) => ctx.res.json("ok", { db: ctx.env.DB }))

		const res = await app.fetch(new Request("http://localhost/test"), { DB: "real-db" })
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.db).toBe("real-db")
	})

	it("next({ res: ... }) doesn't overwrite ctx.res", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			return next({ res: "fake-res" })
		})

		const app = honey<{}>().use(mw)
		app.get("/test").handler((ctx) => ctx.res.json("ok", { type: typeof ctx.res.json }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.type).toBe("function")
	})

	it("next({ params: ... }) doesn't overwrite ctx.params", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			return next({ params: { id: "hijacked" } })
		})

		const app = honey<{}>().use(mw)
		app.get("/items/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

		const res = await app.fetch(new Request("http://localhost/items/42"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.id).toBe("42")
	})

	it("next({ search: ... }) doesn't overwrite ctx.search", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			return next({ search: { q: "hacked" } })
		})

		const app = honey<{}>().use(mw)
		app.get("/s").handler((ctx) => ctx.res.json("ok", { q: ctx.search.q }))

		const res = await app.fetch(new Request("http://localhost/s?q=real"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.q).toBe("real")
	})

	it("next({ background: ... }) doesn't overwrite ctx.background", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			return next({ background: "not-a-function" })
		})

		const app = honey<{}>().use(mw)
		app.get("/test").handler((ctx) => {
			/* background should still be a function */
			return ctx.res.json("ok", { type: typeof ctx.background })
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.type).toBe("function")
	})
})

/* ──────────────────────────────────────────────
 * 5. HoneyError properties
 *
 * Verify error fields, vars, cause chain.
 * ────────────────────────────────────────────── */

describe("bug-hunt-4: HoneyError construction", () => {
	it("error with fields → fields appear in response", async () => {
		const app = honey<{}>()
		app.get("/fail").handler(() => {
			throw new HoneyError({
				errorKey: "validation_failed",
				fields: {
					email: [{ error_key: "field_invalid_format", message: "bad email", path: "json.email" }],
				},
				status: "bad_request",
			})
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("validation_failed")
		const fields = data.fields as Record<string, unknown[]>
		expect(fields.email).toHaveLength(1)
	})

	it("error with cause preserves chain", () => {
		const cause = new Error("original")
		const err = new HoneyError({
			cause,
			errorKey: "internal_server_error",
			status: "internal_server_error",
		})
		expect(err.cause).toBe(cause)
		expect(err.status).toBe(500)
	})
})

/* ──────────────────────────────────────────────
 * 6. Multiple route patterns — static vs dynamic priority
 *
 * Static segments should match before dynamic params.
 * /users/me should match before /users/:id.
 * ────────────────────────────────────────────── */

describe("bug-hunt-4: static vs dynamic route priority", () => {
	it("/users/me matches static before /users/:id", async () => {
		const app = honey<{}>()
		app.get("/users/me").handler((ctx) => ctx.res.json("ok", { route: "me" }))
		app.get("/users/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id, route: "dynamic" }))

		const meRes = await app.fetch(new Request("http://localhost/users/me"), {})
		expect(meRes.status).toBe(200)
		const meData = (await meRes.json()) as Record<string, string>
		expect(meData.route).toBe("me")

		const dynRes = await app.fetch(new Request("http://localhost/users/42"), {})
		expect(dynRes.status).toBe(200)
		const dynData = (await dynRes.json()) as Record<string, string>
		expect(dynData.route).toBe("dynamic")
		expect(dynData.id).toBe("42")
	})
})

/* ──────────────────────────────────────────────
 * 7. Wildcard catches everything after prefix
 * ────────────────────────────────────────────── */

describe("bug-hunt-4: wildcard route depth", () => {
	it("wildcard captures deeply nested paths", async () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		const res = await app.fetch(new Request("http://localhost/files/a/b/c/d/e.txt"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.path).toBe("a/b/c/d/e.txt")
	})

	it("wildcard with empty remainder", async () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		const res = await app.fetch(new Request("http://localhost/files"), {})
		/* should match with empty path */
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.path).toBe("")
	})
})

/* ──────────────────────────────────────────────
 * 8. error formatter customization
 * ────────────────────────────────────────────── */

describe("bug-hunt-4: custom error formatter", () => {
	it("errorFormatter transforms error response shape", async () => {
		const app = honey<{}>()
		app.defaultErrorFormatter((_error, defaultShape) => ({
			code: defaultShape.error_key,
			ok: false,
		}))
		app.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "not_found", status: "not_found" })
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(404)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.ok).toBe(false)
		expect(data.code).toBe("not_found")
		/* default fields should NOT be present */
		expect(data.success).toBeUndefined()
	})
})

/* ──────────────────────────────────────────────
 * 9. trailing slash modes
 * ────────────────────────────────────────────── */

describe("bug-hunt-4: trailing slash handling", () => {
	it("strip mode → redirect 308", async () => {
		const app = honey<{}>()
		app.trailingSlash("strip")
		app.get("/users").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/users/"), {})
		expect(res.status).toBe(308)
		expect(res.headers.get("location")).toContain("/users")
		expect(res.headers.get("location")).not.toContain("/users/")
	})

	it("enforce mode → redirect 308", async () => {
		const app = honey<{}>()
		app.trailingSlash("enforce")
		app.get("/users/").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/users"), {})
		expect(res.status).toBe(308)
		expect(res.headers.get("location")).toContain("/users/")
	})

	it("strip mode on root / → no redirect", async () => {
		const app = honey<{}>()
		app.trailingSlash("strip")
		app.get("/").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/"), {})
		expect(res.status).toBe(200)
	})
})

/* ──────────────────────────────────────────────
 * 10. Node adapter response body drain on client disconnect
 *
 * If the client disconnects mid-stream, the server should
 * stop writing (res.destroyed check) and not crash.
 * ────────────────────────────────────────────── */

describe("bug-hunt-4: Node adapter client disconnect", () => {
	it("server survives client disconnect during streaming", async () => {
		const app = honey<{}>()
		app.get("/long-stream").handler((ctx) =>
			ctx.res.stream(async (writable) => {
				const writer = writable.getWriter()
				for (let i = 0; i < 100; i++) {
					try {
						await writer.write(new TextEncoder().encode(`chunk ${i}\n`))
						await new Promise((r) => setTimeout(r, 5))
					} catch {
						break
					}
				}
				try {
					await writer.close()
				} catch {
					/* stream already closed */
				}
			}),
		)
		app.get("/health").handler((ctx) => ctx.res.json("ok", { alive: true }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* start streaming request then abort quickly */
		await new Promise<void>((resolve) => {
			const req = http.request(
				{ hostname: "127.0.0.1", method: "GET", path: "/long-stream", port: addr.port },
				(res) => {
					res.once("data", () => {
						/* got first chunk, destroy connection */
						res.destroy()
						resolve()
					})
				},
			)
			req.end()
		})

		/* give server time to handle the disconnect */
		await new Promise((r) => setTimeout(r, 50))

		/* server should still be alive */
		const health = await request(addr.port, "/health")
		expect(health.status).toBe(200)
	})
})

/* ──────────────────────────────────────────────
 * 11. route() merges sub-app routes into parent
 * ────────────────────────────────────────────── */

describe("bug-hunt-4: sub-app route merging via mergeTree", () => {
	it("mergeTree + routeTree merges child routes accessible from parent", async () => {
		const { mergeTree } = await import("../../src/tree.ts")

		const child = honey<{}>()
		child.get("/child-route").handler((ctx) => ctx.res.json("ok", { from: "child" }))

		const parent = honey<{}>()
		parent.get("/parent-route").handler((ctx) => ctx.res.json("ok", { from: "parent" }))

		const merged = mergeTree(parent.toRouteTree(), child.toRouteTree())
		const app = honey<{}>()
		app.routeTree(merged)

		const parentRes = await app.fetch(new Request("http://localhost/parent-route"), {})
		expect(parentRes.status).toBe(200)

		const childRes = await app.fetch(new Request("http://localhost/child-route"), {})
		expect(childRes.status).toBe(200)
		const data = (await childRes.json()) as Record<string, string>
		expect(data.from).toBe("child")
	})

	it("route() merges sub-router tree into parent at runtime", async () => {
		const child = honey<{}>()
		child.get("/child").handler((ctx) => ctx.res.json("ok", { from: "child" }))

		const parent = honey<{}>()
		parent.route(child)

		/* child route IS accessible via parent fetch after merge */
		const res = await parent.fetch(new Request("http://localhost/child"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.from).toBe("child")
	})
})

/* ──────────────────────────────────────────────
 * 12. JSON.stringify circular reference in handler
 *
 * ctx.res.json() calls JSON.stringify(). If the data has
 * circular references, it should throw (and be caught as 500).
 * ────────────────────────────────────────────── */

describe("bug-hunt-4: handler errors caught gracefully", () => {
	it("circular reference in json → 500", async () => {
		const app = honey<{}>()
		app.get("/circular").handler((ctx) => {
			const obj: Record<string, unknown> = {}
			obj.self = obj
			return ctx.res.json("ok", obj)
		})

		const res = await app.fetch(new Request("http://localhost/circular"), {})
		expect(res.status).toBe(500)
	})

	it("async handler rejection → 500", async () => {
		const app = honey<{}>()
		app.get("/reject").handler(async () => {
			return Promise.reject(new Error("async fail"))
		})

		const res = await app.fetch(new Request("http://localhost/reject"), {})
		expect(res.status).toBe(500)
	})
})

/* ──────────────────────────────────────────────
 * 13. CORS origin as function
 * ────────────────────────────────────────────── */

describe("bug-hunt-4: CORS origin function", () => {
	it("origin function returning true → allows", async () => {
		const app = honey<{}>().use(cors({ origin: (o) => o.endsWith(".example.com") }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: { origin: "http://app.example.com" },
			}),
			{},
		)
		expect(res.status).toBe(200)
		expect(res.headers.get("access-control-allow-origin")).toBe("http://app.example.com")
	})

	it("origin function returning false → no CORS headers", async () => {
		const app = honey<{}>().use(cors({ origin: (o) => o.endsWith(".example.com") }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: { origin: "http://evil.com" },
			}),
			{},
		)
		expect(res.status).toBe(200)
		expect(res.headers.get("access-control-allow-origin")).toBeNull()
	})
})

/* ──────────────────────────────────────────────
 * 14. CORS origin as array
 * ────────────────────────────────────────────── */

describe("bug-hunt-4: CORS origin array", () => {
	it("origin in array → allowed", async () => {
		const app = honey<{}>().use(cors({ origin: ["http://a.com", "http://b.com"] }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: { origin: "http://b.com" },
			}),
			{},
		)
		expect(res.headers.get("access-control-allow-origin")).toBe("http://b.com")
	})

	it("origin not in array → no CORS", async () => {
		const app = honey<{}>().use(cors({ origin: ["http://a.com"] }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: { origin: "http://c.com" },
			}),
			{},
		)
		expect(res.headers.get("access-control-allow-origin")).toBeNull()
	})
})

/* ──────────────────────────────────────────────
 * 15. ipRestrict CIDR matching edge cases
 * ────────────────────────────────────────────── */

describe("bug-hunt-4: ipRestrict CIDR", () => {
	it("10.0.0.0/8 matches 10.255.255.255", async () => {
		const { ipRestrict } = await import("../../src/ip-restrict.ts")
		const app = honey<{}>().use(ipRestrict({ allowList: ["10.0.0.0/8"], trustProxy: true }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: { "x-forwarded-for": "10.255.255.255" },
			}),
			{},
		)
		expect(res.status).toBe(200)
	})

	it("10.0.0.0/8 rejects 11.0.0.1", async () => {
		const { ipRestrict } = await import("../../src/ip-restrict.ts")
		const app = honey<{}>().use(ipRestrict({ allowList: ["10.0.0.0/8"], trustProxy: true }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: { "x-forwarded-for": "11.0.0.1" },
			}),
			{},
		)
		expect(res.status).toBe(403)
	})

	it("denyList blocks specific IP", async () => {
		const { ipRestrict } = await import("../../src/ip-restrict.ts")
		const app = honey<{}>().use(ipRestrict({ denyList: ["1.2.3.4"], trustProxy: true }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: { "x-forwarded-for": "1.2.3.4" },
			}),
			{},
		)
		expect(res.status).toBe(403)
	})

	it("denyList allows non-matching IP", async () => {
		const { ipRestrict } = await import("../../src/ip-restrict.ts")
		const app = honey<{}>().use(ipRestrict({ denyList: ["1.2.3.4"], trustProxy: true }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: { "x-forwarded-for": "5.6.7.8" },
			}),
			{},
		)
		expect(res.status).toBe(200)
	})
})

/* ──────────────────────────────────────────────
 * 16. SSE event name and id newline validation
 * ────────────────────────────────────────────── */

describe("bug-hunt-4: SSE event name validation", () => {
	it("event name with newline → throws", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				try {
					await stream.send({ data: "x", event: "bad\nevent" })
				} catch {
					/* expected */
				}
				stream.close()
			}),
		)

		const res = await app.fetch(new Request("http://localhost/events"), {})
		expect(res.status).toBe(200)
		const body = await res.text()
		/* should NOT contain the bad event since it threw */
		expect(body).not.toContain("bad\nevent")
	})
})

/* ──────────────────────────────────────────────
 * 17. telemetry adapter receives correct data
 * ────────────────────────────────────────────── */

describe("bug-hunt-4: telemetry adapter", () => {
	it("telemetry callbacks fire for successful request", async () => {
		const events: string[] = []
		const app = honey<{}>()
		app.telemetry({
			onRequest: () => events.push("request"),
			onResponse: () => events.push("response"),
			onRoute: () => events.push("route"),
		})
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		await app.fetch(new Request("http://localhost/api"), {})
		expect(events).toContain("request")
		expect(events).toContain("route")
		expect(events).toContain("response")
	})

	it("telemetry onNotFound fires for 404", async () => {
		let notFoundPath = ""
		const app = honey<{}>()
		app.telemetry({
			onNotFound: (ctx) => {
				notFoundPath = ctx.path
			},
		})
		app.get("/exists").handler((ctx) => ctx.res.json("ok", {}))

		await app.fetch(new Request("http://localhost/nope"), {})
		expect(notFoundPath).toBe("/nope")
	})

	it("telemetry onError fires for handler error", async () => {
		let errorKey = ""
		const app = honey<{}>()
		app.telemetry({
			onError: (ctx) => {
				errorKey = ctx.error.errorKey
			},
		})
		app.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "test_error", status: "bad_request" })
		})

		await app.fetch(new Request("http://localhost/fail"), {})
		expect(errorKey).toBe("test_error")
	})
})

/* ──────────────────────────────────────────────
 * 18. ctx.headers lazy initialization
 * ────────────────────────────────────────────── */

describe("bug-hunt-4: ctx.headers lazy init", () => {
	it("ctx.headers returns all request headers as record", async () => {
		const app = honey<{}>()
		app.get("/h").handler((ctx) =>
			ctx.res.json("ok", {
				auth: ctx.headers.authorization,
				ct: ctx.headers["content-type"],
				custom: ctx.headers["x-custom"],
			}),
		)

		const res = await app.fetch(
			new Request("http://localhost/h", {
				headers: {
					authorization: "Bearer tok",
					"x-custom": "hello",
				},
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.auth).toBe("Bearer tok")
		expect(data.custom).toBe("hello")
	})
})

/* ──────────────────────────────────────────────
 * 19. ctx.routePattern and ctx.path
 * ────────────────────────────────────────────── */

describe("bug-hunt-4: ctx.routePattern and ctx.path", () => {
	it("ctx.path is the matched path, ctx.routePattern is the template", async () => {
		const app = honey<{}>()
		app.get("/users/:id/posts/:postId").handler((ctx) =>
			ctx.res.json("ok", {
				path: ctx.path,
				routePattern: ctx.routePattern,
			}),
		)

		const res = await app.fetch(new Request("http://localhost/users/42/posts/7"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.routePattern).toBe("/users/:id/posts/:postId")
		expect(data.path).toBe("/users/42/posts/7")
	})
})

/* ──────────────────────────────────────────────
 * 20. ctx.meta from route .meta()
 * ────────────────────────────────────────────── */

describe("bug-hunt-4: route metadata", () => {
	it("ctx.meta contains route metadata (frozen)", async () => {
		const app = honey<{}>().meta<{ auth?: boolean; rateLimit?: number }>()
		app
			.get("/api")
			.meta({ auth: true, rateLimit: 100 })
			.handler((ctx) => ctx.res.json("ok", { meta: ctx.meta }))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, Record<string, unknown>>
		expect(data.meta.auth).toBe(true)
		expect(data.meta.rateLimit).toBe(100)
	})
})
