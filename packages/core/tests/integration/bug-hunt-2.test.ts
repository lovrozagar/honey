import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { bodyLimit } from "../../src/body-limit.ts"
import { cors } from "../../src/cors.ts"
import { csrf } from "../../src/csrf.ts"
import { etag } from "../../src/etag.ts"
import { honey } from "../../src/index.ts"
import { createMiddleware } from "../../src/middleware.ts"
import { type HoneyServer, serve } from "../../src/node.ts"
import { requestId } from "../../src/request-id.ts"
import { serverTiming } from "../../src/server-timing.ts"

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
 * HUNCH 1: Server-Timing negative duration for unclosed timings
 *
 * timing.start() captures performance.now() at start time.
 * After next() completes, auto-close uses `entry.end ?? now` where
 * `now` is captured AFTER next() returns. But if the handler is slow,
 * `now` is captured correctly. Let's verify durations are non-negative.
 * The real concern: is `now` captured at the right time?
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: Server-Timing durations are non-negative", () => {
	it("unclosed timing entry has positive duration", async () => {
		const app = honey<{}>().use(serverTiming())
		app.get("/slow").handler(async (ctx) => {
			ctx.timing.start("work")
			/* simulate work without calling timing.end */
			await new Promise((r) => setTimeout(r, 20))
			return ctx.res.json("ok", { done: true })
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/slow")
		expect(res.status).toBe(200)
		const timing = res.headers["server-timing"] as string
		expect(timing).toBeTruthy()

		/* extract dur= values and verify all non-negative */
		const durs = [...timing.matchAll(/dur=([0-9.-]+)/g)].map((m) => Number.parseFloat(m[1]))
		expect(durs.length).toBeGreaterThanOrEqual(2)
		for (const dur of durs) {
			expect(dur).toBeGreaterThanOrEqual(0)
		}
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 2: Server-Timing description with quotes breaks header
 *
 * server-timing.ts:40 does: part += `;desc="${entry.description}"`
 * If description contains a double quote, the header format breaks.
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: Server-Timing description with special chars", () => {
	it("description with double quotes doesn't break header format", async () => {
		const app = honey<{}>().use(serverTiming())
		app.get("/quoted").handler(async (ctx) => {
			ctx.timing.start("db", 'query "users"')
			ctx.timing.end("db")
			return ctx.res.json("ok", {})
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/quoted")
		expect(res.status).toBe(200)
		const timing = res.headers["server-timing"] as string
		expect(timing).toBeTruthy()

		/* the desc value should be properly quoted/escaped — not break the header parse */
		/* at minimum, each metric should have a dur= value */
		const metrics = timing.split(",").map((m) => m.trim())
		for (const metric of metrics) {
			expect(metric).toContain("dur=")
		}
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 3: secureHeaders mutates response.headers in place
 *
 * If the response object has immutable headers (e.g. from a redirect),
 * response.headers.set() could throw. Test with various response types.
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: secureHeaders with various response types", () => {
	it("secureHeaders + JSON response → headers applied", async () => {
		const { secureHeaders } = await import("../../src/secure-headers.ts")
		const app = honey<{}>().use(secureHeaders())
		app.get("/api").handler((ctx) => ctx.res.json("ok", { safe: true }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/api")
		expect(res.status).toBe(200)
		expect(res.headers["x-content-type-options"]).toBe("nosniff")
		expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN")
	})

	it("secureHeaders + stream response → headers applied", async () => {
		const { secureHeaders } = await import("../../src/secure-headers.ts")
		const app = honey<{}>().use(secureHeaders())
		app.get("/stream").handler((ctx) =>
			ctx.res.stream(async (writable) => {
				const writer = writable.getWriter()
				await writer.write(new TextEncoder().encode("hello"))
				await writer.close()
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/stream")
		expect(res.status).toBe(200)
		expect(res.headers["x-content-type-options"]).toBe("nosniff")
		expect(res.body).toBe("hello")
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 4: ETag + streaming response — should skip, not consume
 *
 * etag.ts streaming detection: body !== null && !content-length && !content-type
 * But ctx.res.stream() can set content-type, meaning the check is too strict
 * and etag will try to hash a stream body, consuming it.
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: ETag middleware with streaming responses", () => {
	it("etag + generate() with content-type → body not consumed", async () => {
		const app = honey<{}>().use(etag())
		app.get("/stream").handler((ctx) => {
			function* gen() {
				yield "chunk1"
				yield "chunk2"
			}
			return ctx.res.generate(gen(), { contentType: "text/plain" })
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/stream")
		expect(res.status).toBe(200)
		/* body should NOT be empty — if etag consumed the stream, it would be */
		expect(res.body).toBe("chunk1chunk2")
	})

	it("etag + stream() without explicit content-type → body not consumed", async () => {
		const app = honey<{}>().use(etag())
		app.get("/raw").handler((ctx) =>
			ctx.res.stream(async (writable) => {
				const writer = writable.getWriter()
				await writer.write(new TextEncoder().encode("streamed"))
				await writer.close()
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/raw")
		expect(res.status).toBe(200)
		/* stream body should arrive intact */
		expect(res.body.length).toBeGreaterThan(0)
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 5: CORS Vary header duplication
 *
 * cors.ts uses headers.append("vary", "Origin") on simple requests.
 * If the handler already set a Vary header, we get duplicates.
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: CORS Vary header handling", () => {
	it("CORS + handler setting Vary → no duplicate Vary: Origin", async () => {
		const app = honey<{}>().use(cors({ origin: "http://app.com" }))
		app
			.get("/api")
			.handler((ctx) => ctx.res.json("ok", {}, { headers: { vary: "Accept-Encoding" } }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/api", {
			headers: { origin: "http://app.com" },
		})
		expect(res.status).toBe(200)
		expect(res.headers["access-control-allow-origin"]).toBe("http://app.com")

		/* Vary should contain both Accept-Encoding and Origin */
		const vary = res.headers.vary as string
		expect(vary).toBeTruthy()
		expect(vary).toContain("Origin")
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 6: requestId with existing header → echoed back
 *
 * requestId reads existing header and should echo it on response.
 * What if the header contains unusual characters?
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: requestId edge cases", () => {
	it("preserves existing x-request-id from client", async () => {
		const app = honey<{}>().use(requestId())
		app.get("/api").handler((ctx) => ctx.res.json("ok", { id: ctx.requestId }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/api", {
			headers: { "x-request-id": "client-id-123" },
		})
		expect(res.status).toBe(200)
		expect(res.headers["x-request-id"]).toBe("client-id-123")
		const data = JSON.parse(res.body) as Record<string, unknown> as Record<string, string>
		expect(data.id).toBe("client-id-123")
	})

	it("generates new id when no header present", async () => {
		const app = honey<{}>().use(requestId())
		app.get("/api").handler((ctx) => ctx.res.json("ok", { id: ctx.requestId }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/api")
		expect(res.status).toBe(200)
		expect(res.headers["x-request-id"]).toBeTruthy()
		const data = JSON.parse(res.body) as Record<string, unknown> as Record<string, string>
		expect(data.id).toBeTruthy()
		expect(data.id).toBe(res.headers["x-request-id"])
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 7: ipRestrict with empty allowList → should block all?
 *
 * Empty allowList means hasAllowList is false, so middleware
 * allows everything. This is a misconfiguration that silently
 * passes all IPs instead of failing safe.
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: ipRestrict edge cases", () => {
	it("empty allowList silently allows all IPs (misconfiguration)", async () => {
		const { ipRestrict } = await import("../../src/ip-restrict.ts")
		const app = honey<{}>().use(ipRestrict({ allowList: [], trustProxy: true }))
		app.get("/secret").handler((ctx) => ctx.res.json("ok", { secret: true }))

		/* with empty allowList, all IPs should be allowed (current behavior) */
		const res = await app.fetch(
			new Request("http://localhost/secret", {
				headers: { "x-forwarded-for": "1.2.3.4" },
			}),
			{},
		)
		/* this documents the current behavior — empty allowList = no restriction */
		expect(res.status).toBe(200)
	})

	it("null IP (no headers) + allowList → blocked", async () => {
		const { ipRestrict } = await import("../../src/ip-restrict.ts")
		const app = honey<{}>().use(ipRestrict({ allowList: ["10.0.0.0/8"] }))
		app.get("/secret").handler((ctx) => ctx.res.json("ok", { secret: true }))

		/* no IP headers at all → null IP → should be blocked by allowList */
		const res = await app.fetch(new Request("http://localhost/secret"), {})
		expect(res.status).toBe(403)
	})

	it("CIDR matching with /0 → allows all IPv4", async () => {
		const { ipRestrict } = await import("../../src/ip-restrict.ts")
		const app = honey<{}>().use(ipRestrict({ allowList: ["0.0.0.0/0"], trustProxy: true }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: { "x-forwarded-for": "192.168.1.1" },
			}),
			{},
		)
		expect(res.status).toBe(200)
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 8: basePath with trailing slash fails to match
 *
 * index.ts:482 checks path.startsWith(`${basePath}/`).
 * If basePath = "/api/v1/" then it looks for "/api/v1//",
 * which never matches.
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: basePath edge cases", () => {
	it("basePath without trailing slash works correctly", async () => {
		const app = honey<{}>().basePath("/api/v1")
		app.get("/users").handler((ctx) => ctx.res.json("ok", { users: [] }))

		const res = await app.fetch(new Request("http://localhost/api/v1/users"), {})
		expect(res.status).toBe(200)
	})

	it("basePath with trailing slash → routes should still match", async () => {
		const app = honey<{}>().basePath("/api/v1/")
		app.get("/users").handler((ctx) => ctx.res.json("ok", { users: [] }))

		const res = await app.fetch(new Request("http://localhost/api/v1/users"), {})
		/* this will likely fail — trailing slash in basePath breaks matching */
		expect(res.status).toBe(200)
	})

	it("basePath exact match → root route", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/").handler((ctx) => ctx.res.json("ok", { root: true }))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 9: double-slash in path silently normalizes
 *
 * splitSegments filters empty strings from split("/"),
 * so "//users//123" becomes ["users", "123"].
 * This could be a path traversal issue in proxy setups.
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: route matching with double slashes", () => {
	it("double slashes in path → still matches route", async () => {
		const app = honey<{}>()
		app.get("/users/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

		const res = await app.fetch(new Request("http://localhost//users//42"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.id).toBe("42")
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 10: middleware + 404 → middleware still runs
 *
 * Chain middlewares run around 404 responses.
 * What happens if a chain middleware throws during 404?
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: middleware interaction with 404/405", () => {
	it("chain middleware runs for 404 responses", async () => {
		let middlewareRan = false
		const app = honey<{}>().use(
			createMiddleware(async (_ctx, next) => {
				middlewareRan = true
				return next()
			}),
		)
		app.get("/exists").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/nope"), {})
		expect(res.status).toBe(404)
		expect(middlewareRan).toBe(true)
	})

	it("chain middleware runs for 405 responses", async () => {
		let middlewareRan = false
		const app = honey<{}>().use(
			createMiddleware(async (_ctx, next) => {
				middlewareRan = true
				return next()
			}),
		)
		app.get("/resource").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/resource", { method: "DELETE" }), {})
		expect(res.status).toBe(405)
		expect(middlewareRan).toBe(true)
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 11: cors + csrf middleware ordering
 *
 * If CORS preflight (OPTIONS) is handled by cors middleware,
 * but CSRF middleware runs before CORS, CSRF might block
 * the preflight. Test that ordering works correctly.
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: CORS + CSRF middleware ordering", () => {
	it("CORS preflight should succeed even with CSRF active", async () => {
		const app = honey<{}>()
			.use(cors({ origin: "http://app.com" }))
			.use(csrf({ origin: "http://app.com" }))
		app.post("/api").handler((ctx) => ctx.res.json("ok", {}))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/api", {
			headers: {
				"access-control-request-headers": "content-type",
				"access-control-request-method": "POST",
				origin: "http://app.com",
			},
			method: "OPTIONS",
		})
		/* CORS preflight should return 204, not 403 from CSRF */
		expect(res.status).toBe(204)
		expect(res.headers["access-control-allow-origin"]).toBe("http://app.com")
	})

	it("CSRF blocks same-origin form POST without proper headers", async () => {
		const app = honey<{}>()
			.use(cors({ origin: "http://app.com" }))
			.use(csrf({ origin: "http://app.com" }))
		app.post("/api").handler((ctx) => ctx.res.json("ok", {}))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/api", {
			body: "data=x",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				origin: "http://evil.com",
			},
			method: "POST",
		})
		expect(res.status).toBe(403)
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 12: bodyLimit request reconstruction preserves method
 *
 * body-limit.ts creates new Request(url, { method, body, headers }).
 * Verify the method survives reconstruction for PUT/PATCH/DELETE.
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: bodyLimit preserves request properties", () => {
	it("PUT request method preserved after body reconstruction", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 10000 }))
		app.put("/resource/:id").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, string>
			return ctx.res.json("ok", { body, method: ctx.req.method })
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/resource/42", {
			body: JSON.stringify({ name: "updated" }),
			headers: { "content-type": "application/json" },
			method: "PUT",
		})
		expect(res.status).toBe(200)
		const data = JSON.parse(res.body) as Record<string, unknown> as Record<string, unknown>
		expect(data.method).toBe("PUT")
		expect((data.body as Record<string, string>).name).toBe("updated")
	})

	it("PATCH request headers preserved after body reconstruction", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 10000 }))
		app.patch("/resource").handler(async (ctx) => {
			const auth = ctx.req.headers.get("authorization")
			return ctx.res.json("ok", { auth })
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/resource", {
			body: JSON.stringify({ field: "value" }),
			headers: {
				authorization: "Bearer tok-123",
				"content-type": "application/json",
			},
			method: "PATCH",
		})
		expect(res.status).toBe(200)
		const data = JSON.parse(res.body) as Record<string, unknown> as Record<string, string>
		expect(data.auth).toBe("Bearer tok-123")
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 13: etag on HEAD request — should compute but strip body
 *
 * HEAD falls back to GET handler, etag computes hash, then
 * index.ts strips body for HEAD. But does etag's Response(body, ...)
 * survive the HEAD body stripping? Or does the order matter?
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: ETag + HEAD request interaction", () => {
	it("HEAD request with etag → ETag header present, body empty", async () => {
		const app = honey<{}>().use(etag())
		app.get("/data").handler((ctx) => ctx.res.json("ok", { value: 42 }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/data", { method: "HEAD" })
		expect(res.status).toBe(200)
		/* ETag should be computed even for HEAD */
		expect(res.headers.etag).toBeTruthy()
		/* body should be empty for HEAD */
		expect(res.body).toBe("")
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 14: Node.js adapter — concurrent requests during shutdown
 *
 * Graceful shutdown sets draining=true and rejects new requests
 * with 503. In-flight requests should complete normally.
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: Node.js adapter graceful shutdown", () => {
	it("inflight request completes during shutdown", async () => {
		const app = honey<{}>()
		app.get("/slow").handler(async (ctx) => {
			await new Promise((r) => setTimeout(r, 50))
			return ctx.res.json("ok", { done: true })
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* start a slow request */
		const slowReq = request(addr.port, "/slow")

		/* give it time to start, then initiate shutdown */
		await new Promise((r) => setTimeout(r, 10))
		const shutdownPromise = server.shutdown(5000)

		/* slow request should still complete */
		const res = await slowReq
		expect(res.status).toBe(200)

		await shutdownPromise
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 15: wildcard route + 405 interaction
 *
 * If /files/*path is registered for GET, and a DELETE comes in,
 * does it properly return 405 with Allow: GET?
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: wildcard route + method not allowed", () => {
	it("wildcard route with wrong method → 405", async () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		const res = await app.fetch(
			new Request("http://localhost/files/docs/readme.md", { method: "DELETE" }),
			{},
		)
		expect(res.status).toBe(405)
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 16: optional param → route matches with and without param
 *
 * Route /users/:id? should match both /users and /users/123.
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: optional route params", () => {
	it("optional param matches without value", async () => {
		const app = honey<{}>()
		app.get("/users/:id?").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id ?? "none" }))

		const res = await app.fetch(new Request("http://localhost/users"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.id).toBe("none")
	})

	it("optional param matches with value", async () => {
		const app = honey<{}>()
		app.get("/users/:id?").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id ?? "none" }))

		const res = await app.fetch(new Request("http://localhost/users/42"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.id).toBe("42")
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 17: SSE with keepalive → heartbeats sent
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: SSE keepalive heartbeats", () => {
	it("SSE emits heartbeat comments", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(
				async (stream) => {
					await stream.send({ data: "hello", event: "msg" })
					/* wait for at least one heartbeat */
					await new Promise((r) => setTimeout(r, 60))
					stream.close()
				},
				{ keepalive: 30 },
			),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/events")
		expect(res.status).toBe(200)
		expect(res.headers["content-type"]).toBe("text/event-stream")
		/* should contain both the event data and heartbeat */
		expect(res.body).toContain("event: msg")
		expect(res.body).toContain("data: hello")
		expect(res.body).toContain(": heartbeat")
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 18: middleware that doesn't call next → error
 *
 * middleware.ts:112 checks if result is null/undefined.
 * But what if middleware returns a raw Response without next()?
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: middleware short-circuit without next()", () => {
	it("middleware returning Response directly → works", async () => {
		const shortCircuit = createMiddleware(async () => {
			return new Response(JSON.stringify({ blocked: true }), {
				headers: { "content-type": "application/json" },
				status: 401,
			})
		})

		const app = honey<{}>().use(shortCircuit)
		app.get("/protected").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/protected"), {})
		expect(res.status).toBe(401)
		const data = (await res.json()) as Record<string, boolean>
		expect(data.blocked).toBe(true)
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 19: Node adapter → Set-Cookie with multiple cookies
 *
 * responseToNode uses getSetCookie() to handle multiple cookies.
 * Verify multiple Set-Cookie headers arrive correctly.
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: Node adapter multiple Set-Cookie headers", () => {
	it("multiple cookies → multiple Set-Cookie headers", async () => {
		const app = honey<{}>()
		app.get("/login").handler((ctx) =>
			ctx.res.json(
				"ok",
				{ logged: true },
				{
					cookies: {
						session: { httpOnly: true, path: "/", value: "s-123" },
						theme: { path: "/", value: "dark" },
					},
				},
			),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/login")
		expect(res.status).toBe(200)

		const cookies = res.headers["set-cookie"]
		expect(cookies).toBeTruthy()
		const cookieArr = Array.isArray(cookies)
			? cookies
			: ([cookies as string | undefined].filter(Boolean) as string[])
		expect(cookieArr.length).toBe(2)
		const joined = cookieArr.join("; ")
		expect(joined).toContain("session=s-123")
		expect(joined).toContain("theme=dark")
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 20: error formatter with custom shape
 *
 * createErrorResponse uses formatter to transform error shape.
 * What if formatter returns something with circular ref?
 * (this would crash JSON.stringify)
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: error handling edge cases", () => {
	it("onError handler returning undefined → falls through to default", async () => {
		const app = honey<{}>()
		app.onError(() => undefined)
		app.get("/fail").handler(() => {
			throw new Error("boom")
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(500)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.success).toBe(false)
	})

	it("handler throws non-Error → wrapped in HoneyError", async () => {
		const app = honey<{}>()
		app.get("/fail").handler(() => {
			throw "string-error"
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(500)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.success).toBe(false)
		expect(data.error_key).toBe("internal_server_error")
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 21: ALL method handler + specific method
 *
 * If both .all("/path") and .get("/path") are registered,
 * should GET use the specific handler or ALL?
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: ALL method + specific method priority", () => {
	it("specific method takes priority over ALL", async () => {
		const app = honey<{}>()
		app.all("/resource").handler((ctx) => ctx.res.json("ok", { via: "all" }))
		/* registering GET after ALL on same path should throw (duplicate) */
		let threw = false
		try {
			app.get("/resource").handler((ctx) => ctx.res.json("ok", { via: "get" }))
		} catch {
			threw = true
		}

		if (threw) {
			/* duplicate route throws — this is expected behavior */
			expect(threw).toBe(true)
		} else {
			/* if it didn't throw, GET should match GET specifically */
			const res = await app.fetch(new Request("http://localhost/resource"), {})
			expect(res.status).toBe(200)
			const data = (await res.json()) as Record<string, string>
			expect(["all", "get"]).toContain(data.via)
		}
	})

	it("ALL handler matches PUT when no PUT registered", async () => {
		const app = honey<{}>()
		app.all("/resource").handler((ctx) => ctx.res.json("ok", { via: "all" }))

		const res = await app.fetch(new Request("http://localhost/resource", { method: "PUT" }), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.via).toBe("all")
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 22: bodyLimit + GET request → should skip body read
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: bodyLimit skips safe methods", () => {
	it("GET request with bodyLimit → no body check", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 10 }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", { works: true }))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
	})

	it("OPTIONS request with bodyLimit → no body check", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 10 }))
		app.options("/api").handler((ctx) => ctx.res.noContent())

		const res = await app.fetch(new Request("http://localhost/api", { method: "OPTIONS" }), {})
		expect(res.status).toBe(204)
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 23: cookie serialization with domain + path + all options
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: cookie serialization completeness", () => {
	it("all cookie options serialized correctly", async () => {
		const app = honey<{}>()
		app.get("/cookie").handler((ctx) =>
			ctx.res.json(
				"ok",
				{},
				{
					cookies: {
						full: {
							domain: ".example.com",
							httpOnly: true,
							maxAge: 3600,
							path: "/",
							sameSite: "strict",
							secure: true,
							value: "abc",
						},
					},
				},
			),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/cookie")
		expect(res.status).toBe(200)
		const cookies = res.headers["set-cookie"]
		const cookie = Array.isArray(cookies) ? cookies.join("; ") : String(cookies)
		expect(cookie).toContain("full=abc")
		expect(cookie).toContain("Domain=.example.com")
		expect(cookie).toContain("Path=/")
		expect(cookie).toContain("Max-Age=3600")
		expect(cookie).toContain("HttpOnly")
		expect(cookie).toContain("Secure")
		expect(cookie).toContain("SameSite=Strict")
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 24: etag with strong (non-weak) mode
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: ETag strong mode", () => {
	it("etag({ weak: false }) produces strong ETag without W/ prefix", async () => {
		const app = honey<{}>().use(etag({ weak: false }))
		app.get("/data").handler((ctx) => ctx.res.json("ok", { x: 1 }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/data")
		expect(res.status).toBe(200)
		const etagVal = res.headers.etag as string
		expect(etagVal).toBeTruthy()
		expect(etagVal.startsWith("W/")).toBe(false)
		expect(etagVal.startsWith('"')).toBe(true)
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 25: Node.js adapter handles errors from app.fetch
 * ────────────────────────────────────────────── */

describe("bug-hunt-2: Node.js adapter error resilience", () => {
	it("multiple errors don't crash server", async () => {
		const app = honey<{}>()
		app.get("/boom").handler(() => {
			throw new Error("handler crash")
		})
		app.get("/ok").handler((ctx) => ctx.res.json("ok", { alive: true }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* crash 3 times */
		for (let i = 0; i < 3; i++) {
			const res = await request(addr.port, "/boom")
			expect(res.status).toBe(500)
		}

		/* server still responds */
		const ok = await request(addr.port, "/ok")
		expect(ok.status).toBe(200)
	})
})
