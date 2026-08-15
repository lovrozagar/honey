import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import * as z from "zod"
import { bodyLimit } from "../../src/body-limit.ts"
import { cors } from "../../src/cors.ts"
import { csrf } from "../../src/csrf.ts"
import { etag } from "../../src/etag.ts"
import { createMiddleware, defineErrors, honey } from "../../src/index.ts"
import { ipRestrict } from "../../src/ip-restrict.ts"
import { type HoneyServer, serve } from "../../src/node.ts"
import { requestId } from "../../src/request-id.ts"
import { secureHeaders } from "../../src/secure-headers.ts"
import { serverTiming } from "../../src/server-timing.ts"
import { timeout } from "../../src/timeout.ts"

type Env = { SECRET: string }

function buildApp() {
	const withAuth = createMiddleware(async (_ctx, next) => next({ userId: "u-1" }))

	const app = honey<Env>()
		.use(requestId())
		.use(secureHeaders())
		.use(cors({ origin: "http://allowed.com" }))
		.use(csrf({ origin: "http://allowed.com" }))
		.use(bodyLimit({ maxSize: 1024 }))
		.use(timeout({ duration: 500 }))
		.use(etag())
		.use(serverTiming())
		.use(withAuth)

	app.get("/health").handler((ctx) => ctx.res.json("ok", { status: "healthy" }))

	app.get("/user").handler((ctx) => ctx.res.json("ok", { id: ctx.userId }))

	app.post("/echo").handler(async (ctx) => {
		const body = await ctx.req.text()
		return ctx.res.text("ok", body)
	})

	app.get("/slow").handler(async (ctx) => {
		await new Promise((r) => setTimeout(r, 2000))
		return ctx.res.text("ok", "done")
	})

	app.get("/timed").handler((ctx) => {
		ctx.timing.start("work")
		ctx.timing.end("work")
		return ctx.res.json("ok", { timed: true })
	})

	return app
}

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

describe("integration: real HTTP server with all middleware", () => {
	it("GET /health → 200 JSON with all security headers", async () => {
		const app = buildApp()
		server = serve(app, { env: { SECRET: "s" }, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/health")
		expect(res.status).toBe(200)

		const body = JSON.parse(res.body) as Record<string, unknown>
		expect(body.status).toBe("healthy")

		/* secure headers present */
		expect(res.headers["x-content-type-options"]).toBe("nosniff")
		expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN")
		expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin")

		/* request ID generated */
		expect(res.headers["x-request-id"]).toBeTruthy()
		expect(res.headers["x-request-id"]).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		)

		/* server-timing present */
		expect(res.headers["server-timing"]).toContain("total;dur=")

		/* etag present */
		expect(res.headers.etag).toBeTruthy()
	})

	it("GET /health with matching ETag → 304 empty body", async () => {
		const app = buildApp()
		server = serve(app, { env: { SECRET: "s" }, port: 0 })
		const addr = server.address() as { port: number }

		const first = await request(addr.port, "/health")
		expect(first.status).toBe(200)
		const etagVal = first.headers.etag as string

		const second = await request(addr.port, "/health", {
			headers: { "if-none-match": etagVal },
		})
		expect(second.status).toBe(304)
		expect(second.body).toBe("")
	})

	it("GET /user → middleware context flows through", async () => {
		const app = buildApp()
		server = serve(app, { env: { SECRET: "s" }, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/user")
		expect(res.status).toBe(200)
		const body = JSON.parse(res.body) as Record<string, unknown>
		expect(body.id).toBe("u-1")
	})

	it("POST /echo with small body → 200", async () => {
		const app = buildApp()
		server = serve(app, { env: { SECRET: "s" }, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/echo", {
			body: "hello",
			headers: {
				"content-type": "text/plain",
				"sec-fetch-site": "same-origin",
			},
			method: "POST",
		})
		expect(res.status).toBe(200)
		expect(res.body).toBe("hello")
	})

	it("POST /echo with body exceeding limit → 413", async () => {
		const app = buildApp()
		server = serve(app, { env: { SECRET: "s" }, port: 0 })
		const addr = server.address() as { port: number }

		const bigBody = "x".repeat(2000)
		const res = await request(addr.port, "/echo", {
			body: bigBody,
			headers: {
				"content-length": String(bigBody.length),
				"content-type": "text/plain",
				"sec-fetch-site": "same-origin",
			},
			method: "POST",
		})
		expect(res.status).toBe(413)
		const body = JSON.parse(res.body) as Record<string, unknown>
		expect(body.error_key).toBe("content_too_large")
	})

	it("GET /slow → timeout 504", async () => {
		const app = buildApp()
		server = serve(app, { env: { SECRET: "s" }, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/slow")
		expect(res.status).toBe(504)
		const body = JSON.parse(res.body) as Record<string, unknown>
		expect(body.error_key).toBe("request_timeout")
	})

	it("cross-origin form POST → CSRF 403", async () => {
		const app = buildApp()
		server = serve(app, { env: { SECRET: "s" }, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/echo", {
			body: "data=evil",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				origin: "http://evil.com",
				"sec-fetch-site": "cross-site",
			},
			method: "POST",
		})
		expect(res.status).toBe(403)
		const body = JSON.parse(res.body) as Record<string, unknown>
		expect(body.error_key).toBe("forbidden")
	})

	it("same-origin form POST → allowed", async () => {
		const app = buildApp()
		server = serve(app, { env: { SECRET: "s" }, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/echo", {
			body: "data=safe",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"sec-fetch-site": "same-origin",
			},
			method: "POST",
		})
		expect(res.status).toBe(200)
		expect(res.body).toBe("data=safe")
	})

	it("CORS preflight from allowed origin → 204 with headers", async () => {
		const app = buildApp()
		server = serve(app, { env: { SECRET: "s" }, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/health", {
			headers: {
				"access-control-request-method": "GET",
				origin: "http://allowed.com",
			},
			method: "OPTIONS",
		})
		expect(res.status).toBe(204)
		expect(res.headers["access-control-allow-origin"]).toBe("http://allowed.com")
		expect(res.headers.vary).toContain("Origin")
	})

	it("CORS preflight from disallowed origin → no CORS headers", async () => {
		const app = buildApp()
		server = serve(app, { env: { SECRET: "s" }, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/health", {
			headers: {
				"access-control-request-method": "GET",
				origin: "http://evil.com",
			},
			method: "OPTIONS",
		})
		/* no CORS headers → browser blocks the response */
		expect(res.headers["access-control-allow-origin"]).toBeUndefined()
	})

	it("GET /timed → Server-Timing header has work + total", async () => {
		const app = buildApp()
		server = serve(app, { env: { SECRET: "s" }, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/timed")
		expect(res.status).toBe(200)
		const timing = res.headers["server-timing"] as string
		expect(timing).toContain("work;dur=")
		expect(timing).toContain("total;dur=")
	})

	it("each request gets unique X-Request-Id", async () => {
		const app = buildApp()
		server = serve(app, { env: { SECRET: "s" }, port: 0 })
		const addr = server.address() as { port: number }

		const r1 = await request(addr.port, "/health")
		const r2 = await request(addr.port, "/health")
		expect(r1.headers["x-request-id"]).toBeTruthy()
		expect(r2.headers["x-request-id"]).toBeTruthy()
		expect(r1.headers["x-request-id"]).not.toBe(r2.headers["x-request-id"])
	})

	it("upstream X-Request-Id preserved", async () => {
		const app = buildApp()
		server = serve(app, { env: { SECRET: "s" }, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/health", {
			headers: { "x-request-id": "upstream-abc" },
		})
		expect(res.headers["x-request-id"]).toBe("upstream-abc")
	})

	it("404 for unknown path → still has security headers", async () => {
		const app = buildApp()
		server = serve(app, { env: { SECRET: "s" }, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/nonexistent")
		expect(res.status).toBe(404)
		expect(res.headers["x-content-type-options"]).toBe("nosniff")
		expect(res.headers["x-request-id"]).toBeTruthy()
	})
})

describe("integration: IP restriction over real HTTP", () => {
	it("allowed IP → 200", async () => {
		const app = honey<{}>().use(ipRestrict({ allowList: ["127.0.0.1"], trustProxy: true }))
		app.get("/admin").handler((ctx) => ctx.res.json("ok", { admin: true }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/admin", {
			headers: { "x-forwarded-for": "127.0.0.1" },
		})
		expect(res.status).toBe(200)
	})

	it("blocked IP → 403", async () => {
		const app = honey<{}>().use(ipRestrict({ allowList: ["10.0.0.0/8"], trustProxy: true }))
		app.get("/admin").handler((ctx) => ctx.res.json("ok", { admin: true }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/admin", {
			headers: { "x-forwarded-for": "203.0.113.50" },
		})
		expect(res.status).toBe(403)
	})
})

describe("integration: cookies over real HTTP", () => {
	it("Set-Cookie header arrives over HTTP", async () => {
		const app = honey<{}>()
		app.get("/login").handler((ctx) =>
			ctx.res.json(
				"ok",
				{ logged: true },
				{
					cookies: { session: { httpOnly: true, path: "/", secure: false, value: "tok-123" } },
				},
			),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/login")
		expect(res.status).toBe(200)
		const cookies = res.headers["set-cookie"]
		expect(cookies).toBeTruthy()
		const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : String(cookies)
		expect(cookieStr).toContain("session=tok-123")
		expect(cookieStr).toContain("HttpOnly")
	})
})

describe("integration: SSE streaming over real HTTP", () => {
	it("event-stream delivers events", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: "hello", event: "msg" })
				await stream.send({ data: "world", event: "msg" })
				stream.close()
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/events")
		expect(res.status).toBe(200)
		expect(res.headers["content-type"]).toBe("text/event-stream")
		expect(res.body).toContain("event: msg")
		expect(res.body).toContain("data: hello")
		expect(res.body).toContain("data: world")
	})

	it("multiline SSE data split correctly over HTTP", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: "line1\nline2", event: "multi" })
				stream.close()
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/events")
		expect(res.body).toContain("data: line1\n")
		expect(res.body).toContain("data: line2\n")
	})
})

describe("integration: generator streaming over real HTTP", () => {
	it("async generator streams NDJSON", async () => {
		const app = honey<{}>()
		app.get("/stream").handler((ctx) =>
			ctx.res.generate(
				(async function* () {
					for (let i = 0; i < 5; i++) {
						yield `${JSON.stringify({ id: i })}\n`
					}
				})(),
				{ contentType: "application/x-ndjson" },
			),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/stream")
		expect(res.status).toBe(200)
		expect(res.headers["content-type"]).toBe("application/x-ndjson")
		const lines = res.body.trim().split("\n")
		expect(lines).toHaveLength(5)
		expect(JSON.parse(lines[0]) as unknown).toEqual({ id: 0 })
		expect(JSON.parse(lines[4]) as unknown).toEqual({ id: 4 })
	})
})

describe("integration: output validation over real HTTP", () => {
	it("valid output → passes", async () => {
		const app = honey<{}>()
		app.outputValidation("always")
		app
			.get("/valid")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: "abc" }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/valid")
		expect(res.status).toBe(200)
		expect((JSON.parse(res.body) as Record<string, unknown>).id).toBe("abc")
	})

	it("invalid output → 500 with output_validation_failed", async () => {
		const app = honey<{}>()
		app.outputValidation("always")
		app
			.get("/bad")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) =>
				ctx.res.raw(
					new Response(JSON.stringify({ wrong: 123 }), {
						headers: { "content-type": "application/json" },
						status: 200,
					}),
				),
			)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/bad")
		expect(res.status).toBe(500)
		expect((JSON.parse(res.body) as Record<string, unknown>).error_key).toBe(
			"output_validation_failed",
		)
	})
})

describe("integration: error handling over real HTTP", () => {
	it("non-HoneyError throw → 500 internal_server_error", async () => {
		const app = honey<{}>()
		app.get("/crash").handler(() => {
			throw new TypeError("oops")
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/crash")
		expect(res.status).toBe(500)
		expect((JSON.parse(res.body) as Record<string, unknown>).error_key).toBe(
			"internal_server_error",
		)
	})

	it("scoped error keys enforced over HTTP", async () => {
		const errors = defineErrors({
			custom_err: "bad_request",
			not_allowed: "forbidden",
		})
		const app = honey<{}>().errorFactory(errors)
		app
			.get("/strict")
			.errors("custom_err")
			.handler(() => {
				throw errors.not_allowed()
			})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/strict")
		/* not_allowed is not in route's error scope → becomes internal_server_error */
		expect(res.status).toBe(500)
		expect((JSON.parse(res.body) as Record<string, unknown>).error_key).toBe(
			"internal_server_error",
		)
	})
})

describe("integration: concurrent requests", () => {
	it("10 parallel requests all get correct responses", async () => {
		const app = honey<{}>().use(requestId())
		app.get("/ping").handler((ctx) => ctx.res.json("ok", { pong: true }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const results = await Promise.all(Array.from({ length: 10 }, () => request(addr.port, "/ping")))

		for (const res of results) {
			expect(res.status).toBe(200)
			expect((JSON.parse(res.body) as Record<string, unknown>).pong).toBe(true)
		}

		/* all request IDs unique */
		const ids = results.map((r) => r.headers["x-request-id"])
		const unique = new Set(ids)
		expect(unique.size).toBe(10)
	})

	it("concurrent requests don't share middleware state", async () => {
		let counter = 0
		const countMw = createMiddleware(async (_ctx, next) => {
			const myCount = ++counter
			await new Promise((r) => setTimeout(r, 10))
			return next({ count: myCount })
		})

		const app = honey<{}>().use(countMw)
		app.get("/count").handler((ctx) => ctx.res.json("ok", { count: ctx.count }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const results = await Promise.all(Array.from({ length: 5 }, () => request(addr.port, "/count")))

		const counts = results.map((r) => (JSON.parse(r.body) as Record<string, number>).count)
		/* each request should get a different count */
		const unique = new Set(counts)
		expect(unique.size).toBe(5)
	})
})

describe("integration: cookie SameSite enforcement", () => {
	it("SameSite=None without Secure → throws at serialization", async () => {
		const app = honey<{}>()
		app.get("/cookie").handler((ctx) =>
			ctx.res.json(
				"ok",
				{},
				{
					cookies: { session: { sameSite: "none", value: "abc" } },
				},
			),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/cookie")
		/* serialization should fail → 500, not silently set invalid cookie */
		expect(res.status).toBe(500)
	})
})

describe("integration: onError handler resilience", () => {
	it("onError that throws → server doesn't crash, returns 500", async () => {
		const app = honey<{}>()
		app.onError(() => {
			throw new Error("error handler crashed")
		})
		app.get("/fail").handler(() => {
			throw new Error("handler crash")
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/fail")
		expect(res.status).toBe(500)

		/* server still alive for next request */
		const res2 = await request(addr.port, "/fail")
		expect(res2.status).toBe(500)
	})
})

describe("integration: trailing slash redirect over HTTP", () => {
	it("strip mode: /users/ → 308 to /users", async () => {
		const app = honey<{}>()
		app.trailingSlash("strip")
		app.get("/users").handler((ctx) => ctx.res.json("ok", { users: [] }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await new Promise<{ headers: http.IncomingHttpHeaders; status: number }>(
			(resolve, reject) => {
				const req = http.request(
					{ hostname: "127.0.0.1", method: "GET", path: "/users/", port: addr.port },
					(res) => {
						resolve({ headers: res.headers, status: res.statusCode ?? 0 })
						res.resume()
					},
				)
				req.on("error", reject)
				req.end()
			},
		)
		expect(res.status).toBe(308)
		expect(res.headers.location).toContain("/users")
		expect(res.headers.location).not.toContain("/users/")
	})
})

describe("integration: basePath over HTTP", () => {
	it("basePath prefixes routes at registration time", async () => {
		const app = honey<{}>().basePath("/api/v1")
		app.get("/users").handler((ctx) => ctx.res.json("ok", { users: [] }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const hit = await request(addr.port, "/api/v1/users")
		expect(hit.status).toBe(200)

		/* /users without prefix → 404, route is registered as /api/v1/users */
		const direct = await request(addr.port, "/users")
		expect(direct.status).toBe(404)
	})
})

describe("integration: multiple cookies via response options", () => {
	it("handler sets multiple cookies → both arrive over HTTP", async () => {
		const app = honey<{}>()
		app.get("/multi").handler((ctx) =>
			ctx.res.json(
				"ok",
				{ ok: true },
				{
					cookies: {
						lang: { path: "/", value: "en" },
						theme: { path: "/", value: "dark" },
					},
				},
			),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/multi")
		expect(res.status).toBe(200)
		const cookies = res.headers["set-cookie"]
		expect(cookies).toBeTruthy()
		const cookieStr = Array.isArray(cookies) ? cookies.join(" | ") : String(cookies)
		expect(cookieStr).toContain("theme=dark")
		expect(cookieStr).toContain("lang=en")
	})
})

describe("integration: app.context() over real HTTP", () => {
	it("static context values accessible in handler over HTTP", async () => {
		const app = honey<Env>().context({ appName: "test-app", version: 42 })
		app.get("/info").handler((ctx) => ctx.res.json("ok", { app: ctx.appName, v: ctx.version }))
		server = serve(app, { env: { SECRET: "s" }, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/info")
		expect(res.status).toBe(200)
		const body = JSON.parse(res.body) as Record<string, unknown>
		expect(body.app).toBe("test-app")
		expect(body.v).toBe(42)
	})

	it("context + middleware compose over real HTTP", async () => {
		const addUser = createMiddleware(async (_ctx, next) => next({ userId: "u-42" }))

		const app = honey<Env>().context({ region: "eu-west" }).use(addUser)

		app
			.get("/whoami")
			.handler((ctx) => ctx.res.json("ok", { region: ctx.region, user: ctx.userId }))
		server = serve(app, { env: { SECRET: "s" }, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/whoami")
		expect(res.status).toBe(200)
		const body = JSON.parse(res.body) as Record<string, unknown>
		expect(body.region).toBe("eu-west")
		expect(body.user).toBe("u-42")
	})

	it("context values stable across concurrent requests", async () => {
		const counter = { n: 0 }
		const app = honey<{}>().context({ counter })

		app.get("/count").handler((ctx) => {
			ctx.counter.n++
			return ctx.res.json("ok", { n: ctx.counter.n })
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const results = await Promise.all(Array.from({ length: 5 }, () => request(addr.port, "/count")))
		const counts = results.map((r) => (JSON.parse(r.body) as Record<string, number>).n)
		const unique = new Set(counts)
		expect(unique.size).toBe(5)
		expect(Math.max(...counts)).toBe(5)
	})
})

describe("integration: chain-level .meta() over real HTTP", () => {
	it("chain meta in ctx.meta over HTTP", async () => {
		const app = honey<Env>().meta<{ security?: string; tags?: string }>().meta({ security: "jwt" })

		app.get("/info").handler((ctx) => ctx.res.json("ok", { sec: ctx.meta.security }))
		server = serve(app, { env: { SECRET: "s" }, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/info")
		expect(res.status).toBe(200)
		const body = JSON.parse(res.body) as Record<string, unknown>
		expect(body.sec).toBe("jwt")
	})

	it("route meta overrides chain meta over HTTP", async () => {
		const app = honey<Env>()
			.meta<{ security?: string; tags?: string }>()
			.meta({ security: "jwt", tags: "Default" })

		app
			.get("/override")
			.meta({ tags: "Override" })
			.handler((ctx) => ctx.res.json("ok", { sec: ctx.meta.security, tags: ctx.meta.tags }))
		server = serve(app, { env: { SECRET: "s" }, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/override")
		expect(res.status).toBe(200)
		const body = JSON.parse(res.body) as Record<string, unknown>
		expect(body.sec).toBe("jwt")
		expect(body.tags).toBe("Override")
	})
})

describe("integration: chain meta in OpenAPI spec", () => {
	it("chain meta appears in generated OpenAPI spec", async () => {
		const { generateOpenApi } = await import("../../src/codegen.ts")

		const app = honey<{}>()
			.meta<{ security?: string; tags?: string }>()
			.meta({ security: "bearer", tags: "Auth" })

		app.get("/users").handler((ctx) => ctx.res.json("ok", {}))
		app
			.get("/docs")
			.meta({ tags: "Docs" })
			.handler((ctx) => ctx.res.json("ok", {}))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1.0.0" },
			securitySchemes: {
				bearer: { bearerFormat: "JWT", scheme: "bearer", type: "http" },
			},
		})

		const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>

		/* /users inherits chain meta: tags=Auth, security=bearer */
		expect(paths["/users"].get.tags).toEqual(["Auth"])
		expect(paths["/users"].get.security).toBeTruthy()

		/* /docs overrides tags to "Docs" but keeps security from chain */
		expect(paths["/docs"].get.tags).toEqual(["Docs"])
		expect(paths["/docs"].get.security).toBeTruthy()
	})
})

describe("integration: chain meta in generateTypes", () => {
	it("chain meta reflected in generated type declarations", async () => {
		const { generateTypes } = await import("../../src/codegen.ts")

		const app = honey<{}>()
			.meta<{ security?: string; tags?: string }>()
			.meta({ security: "jwt", tags: "Auth" })

		app.get("/test").handler((ctx) => ctx.res.json("ok", {}))
		app
			.post("/test")
			.meta({ tags: "Override" })
			.handler((ctx) => ctx.res.json("created", {}))

		const code = generateTypes(app, {
			inlineEnvType: "{}",
		})

		/* chain meta should appear in per-route meta types */
		expect(code).toContain("security")
		expect(code).toContain("tags")
		/* GET /test gets chain meta: security: "jwt", tags: "Auth" */
		expect(code).toContain('"jwt"')
		expect(code).toContain('"Auth"')
		/* POST /test overrides tags to "Override" */
		expect(code).toContain('"Override"')
	})
})
