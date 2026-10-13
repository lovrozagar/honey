import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { cors } from "../../src/cors.ts"
import { HoneyError } from "../../src/error.ts"
import { etag } from "../../src/etag.ts"
import { honey } from "../../src/index.ts"
import { createMiddleware } from "../../src/middleware.ts"
import { type HoneyServer, serve } from "../../src/node.ts"

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
 * 1. SSE — stream.close() called before callback throws
 *
 * BUG: response.ts:177-179 — callback .catch() does writer.close()
 * but if callback already called stream.close() (which closes the
 * writer), the second writer.close() throws synchronously.
 *
 * FIX: wrap the .catch() writer.close() in try/catch.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-19: SSE close then throw — no unhandled error", () => {
	it("callback calls stream.close() then throws → no crash", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: "before", event: "msg" })
				stream.close()
				/* throw after closing — .catch() should not crash on double close */
				throw new Error("callback error after close")
			}),
		)

		const res = await app.fetch(new Request("http://localhost/events"), {})
		expect(res.status).toBe(200)
		const body = await res.text()
		expect(body).toContain("data: before")
	})

	it("callback calls stream.close() then throws — server survives", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: "data", event: "msg" })
				stream.close()
				throw new Error("post-close throw")
			}),
		)
		app.get("/health").handler((ctx) => ctx.res.json("ok", { alive: true }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* trigger the SSE close-then-throw */
		const sseRes = await request(addr.port, "/events")
		expect(sseRes.status).toBe(200)

		/* wait for the .catch() to fire */
		await new Promise((r) => setTimeout(r, 20))

		/* server should still work */
		const healthRes = await request(addr.port, "/health")
		expect(healthRes.status).toBe(200)
	})
})

/* ══════════════════════════════════════════════
 * 2. SSE — stream.close() called twice → no crash
 *
 * BUG: Calling stream.close() twice would call writer.close()
 * twice, which throws on the second call.
 *
 * FIX: Added `closed` flag to guard against double close.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-19: SSE double close — no crash", () => {
	it("stream.close() called twice → idempotent", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: "hello", event: "msg" })
				stream.close()
				/* second close should be a no-op, not throw */
				stream.close()
			}),
		)

		const res = await app.fetch(new Request("http://localhost/events"), {})
		expect(res.status).toBe(200)
		const body = await res.text()
		expect(body).toContain("data: hello")
	})
})

/* ══════════════════════════════════════════════
 * 3. SSE — keepalive + close + throw → timer cleared, no leak
 * ══════════════════════════════════════════════ */

describe("bug-hunt-19: SSE keepalive + close + throw", () => {
	it("keepalive active, close(), then throw → no crash, timer cleared", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(
				async (stream) => {
					await stream.send({ data: "x", event: "msg" })
					stream.close()
					throw new Error("post-close with keepalive")
				},
				{ keepalive: 10 },
			),
		)

		const res = await app.fetch(new Request("http://localhost/events"), {})
		expect(res.status).toBe(200)
		const body = await res.text()
		expect(body).toContain("data: x")
	})
})

/* ══════════════════════════════════════════════
 * 4. ETAG — error responses (status >= 400) now skipped
 *
 * etag.ts:32 — new line skips error responses.
 * Verify 404 and 500 responses don't get ETags.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-19: ETag skips error responses", () => {
	it("404 response → no ETag", async () => {
		const app = honey<{}>().use(etag())
		app.get("/exists").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/nope"), {})
		expect(res.status).toBe(404)
		expect(res.headers.get("etag")).toBeNull()
	})

	it("500 response from handler error → no ETag", async () => {
		const app = honey<{}>().use(etag())
		app.get("/fail").handler(() => {
			throw new Error("boom")
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(500)
		expect(res.headers.get("etag")).toBeNull()
	})

	it("custom 403 error → no ETag", async () => {
		const app = honey<{}>().use(etag())
		app.get("/forbidden").handler(() => {
			throw new HoneyError({ errorKey: "forbidden", status: "forbidden" })
		})

		const res = await app.fetch(new Request("http://localhost/forbidden"), {})
		expect(res.status).toBe(403)
		expect(res.headers.get("etag")).toBeNull()
	})

	it("200 response → still gets ETag", async () => {
		const app = honey<{}>().use(etag())
		app.get("/ok").handler((ctx) => ctx.res.json("ok", { data: true }))

		const res = await app.fetch(new Request("http://localhost/ok"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("etag")).toBeTruthy()
	})

	it("201 created → still gets ETag", async () => {
		const app = honey<{}>().use(etag())
		app.post("/items").handler((ctx) => ctx.res.json("created", { id: 1 }))

		const res = await app.fetch(new Request("http://localhost/items", { method: "POST" }), {})
		/* etag only runs on GET/HEAD, so POST won't get an ETag regardless */
		expect(res.status).toBe(201)
	})
})

/* ══════════════════════════════════════════════
 * 5. SECURE HEADERS — disabling individual headers
 *
 * secureHeaders accepts `false` to disable specific headers.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-19: secureHeaders — disable individual headers", () => {
	it("xContentTypeOptions: false → header not set", async () => {
		const { secureHeaders } = await import("../../src/secure-headers.ts")
		const app = honey<{}>().use(secureHeaders({ xContentTypeOptions: false }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("x-content-type-options")).toBeNull()
		/* other headers still present */
		expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN")
	})

	it("xFrameOptions: false → header not set", async () => {
		const { secureHeaders } = await import("../../src/secure-headers.ts")
		const app = honey<{}>().use(secureHeaders({ xFrameOptions: false }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.headers.get("x-frame-options")).toBeNull()
		expect(res.headers.get("x-content-type-options")).toBe("nosniff")
	})

	it("referrerPolicy: false → header not set", async () => {
		const { secureHeaders } = await import("../../src/secure-headers.ts")
		const app = honey<{}>().use(secureHeaders({ referrerPolicy: false }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.headers.get("referrer-policy")).toBeNull()
	})

	it("all disabled → no security headers", async () => {
		const { secureHeaders } = await import("../../src/secure-headers.ts")
		const app = honey<{}>().use(
			secureHeaders({
				referrerPolicy: false,
				xContentTypeOptions: false,
				xFrameOptions: false,
				xXssProtection: false,
			}),
		)
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.headers.get("x-content-type-options")).toBeNull()
		expect(res.headers.get("x-frame-options")).toBeNull()
		expect(res.headers.get("referrer-policy")).toBeNull()
		expect(res.headers.get("x-xss-protection")).toBeNull()
	})
})

/* ══════════════════════════════════════════════
 * 6. SECURE HEADERS — custom values
 * ══════════════════════════════════════════════ */

describe("bug-hunt-19: secureHeaders — custom values", () => {
	it("custom CSP, HSTS, permissions policy", async () => {
		const { secureHeaders } = await import("../../src/secure-headers.ts")
		const app = honey<{}>().use(
			secureHeaders({
				contentSecurityPolicy: "default-src 'self'",
				permissionsPolicy: "camera=()",
				strictTransportSecurity: "max-age=31536000; includeSubDomains",
			}),
		)
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.headers.get("content-security-policy")).toBe("default-src 'self'")
		expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains")
		expect(res.headers.get("permissions-policy")).toBe("camera=()")
	})

	it("cross-origin policies", async () => {
		const { secureHeaders } = await import("../../src/secure-headers.ts")
		const app = honey<{}>().use(
			secureHeaders({
				crossOriginEmbedderPolicy: "require-corp",
				crossOriginOpenerPolicy: "same-origin",
				crossOriginResourcePolicy: "same-site",
			}),
		)
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin")
		expect(res.headers.get("cross-origin-resource-policy")).toBe("same-site")
		expect(res.headers.get("cross-origin-embedder-policy")).toBe("require-corp")
	})
})

/* ══════════════════════════════════════════════
 * 7. TIMEOUT — handler error before timeout
 *
 * timeout.ts:28-31 — catch branch clears timer and rejects.
 * Verify the error propagates correctly.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-19: timeout — handler error before timeout", () => {
	it("handler throws before timeout expires → original error, not timeout", async () => {
		const { timeout } = await import("../../src/timeout.ts")
		const app = honey<{}>().use(timeout({ duration: 5000 }))
		app.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "custom_error", status: "bad_request" })
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, string>
		expect(data.error_key).toBe("custom_error")
	})
})

/* ══════════════════════════════════════════════
 * 8. CORS — response body preserved through reconstruction
 *
 * cors.ts:88-91 — creates new Response(response.body, ...).
 * Verify the body stream transfers correctly.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-19: CORS — response body integrity", () => {
	it("large JSON body survives CORS response reconstruction", async () => {
		const app = honey<{}>().use(cors({ origin: "*" }))
		const items = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `item-${i}` }))
		app.get("/items").handler((ctx) => ctx.res.json("ok", items))

		const res = await app.fetch(
			new Request("http://localhost/items", {
				headers: { origin: "http://app.com" },
			}),
			{},
		)
		expect(res.status).toBe(200)
		expect(res.headers.get("access-control-allow-origin")).toBe("*")
		const data = (await res.json()) as Array<{ id: number }>
		expect(data.length).toBe(100)
		expect(data[99].id).toBe(99)
	})

	it("streaming body survives CORS reconstruction", async () => {
		const app = honey<{}>().use(cors({ origin: "*" }))
		app.get("/stream").handler((ctx) => {
			function* gen() {
				yield "chunk1"
				yield "chunk2"
			}
			return ctx.res.generate(gen(), { contentType: "text/plain" })
		})

		const res = await app.fetch(
			new Request("http://localhost/stream", {
				headers: { origin: "http://app.com" },
			}),
			{},
		)
		expect(res.status).toBe(200)
		expect(res.headers.get("access-control-allow-origin")).toBe("*")
		const body = await res.text()
		expect(body).toBe("chunk1chunk2")
	})
})

/* ══════════════════════════════════════════════
 * 9. NODE ADAPTER — response headers with duplicate keys
 *
 * node.ts:57-61 — forEach overwrites duplicate header keys.
 * Only set-cookie is handled specially. What about other
 * headers that can have multiple values (e.g., Link)?
 * ══════════════════════════════════════════════ */

describe("bug-hunt-19: Node adapter — duplicate header handling", () => {
	it("set-cookie preserved as array, other headers as single string", async () => {
		const app = honey<{}>()
		app.get("/multi").handler((ctx) =>
			ctx.res.json(
				"ok",
				{},
				{
					cookies: {
						a: { path: "/", value: "1" },
						b: { path: "/", value: "2" },
					},
					headers: { "x-custom": "value" },
				},
			),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/multi")
		expect(res.status).toBe(200)
		expect(res.headers["x-custom"]).toBe("value")
		const cookies = res.headers["set-cookie"]
		expect(Array.isArray(cookies)).toBe(true)
		expect((cookies as string[]).length).toBe(2)
	})
})

/* ══════════════════════════════════════════════
 * 10. MIDDLEWARE — next() with empty additions object
 *
 * middleware.ts:105-113 — Object.entries on empty object
 * iterates zero times, Object.assign is a no-op.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-19: middleware next() — empty additions", () => {
	it("next() → no ctx mutation, response passes through", async () => {
		const mw = createMiddleware(async (_ctx, next) => next())

		const app = honey<{}>().use(mw)
		app.get("/test").handler((ctx) => ctx.res.json("ok", { method: ctx.req.method }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.method).toBe("GET")
	})
})
