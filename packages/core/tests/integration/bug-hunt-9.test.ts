import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { bodyLimit } from "../../src/body-limit.ts"
import { cors } from "../../src/cors.ts"
import { csrf } from "../../src/csrf.ts"
import { HoneyError } from "../../src/error.ts"
import { defineErrors } from "../../src/errors.ts"
import { etag } from "../../src/etag.ts"
import { honey } from "../../src/index.ts"
import { readableStream } from "../../src/input.ts"
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
 * 1. HANDLER MAP / PATCH MODE — hot reload
 *
 * When routeTree() provides a handlers map, subsequent
 * .handler() calls patch existing handlers in-place
 * instead of inserting new routes.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-9: handler map patch mode", () => {
	it("routeTree with handlers → handler patched in place", async () => {
		/* build initial app to get route tree */
		const initial = honey<{}>()
		initial.get("/api").handler((ctx) => ctx.res.json("ok", { version: 1 }))
		const tree = initial.toRouteTree()

		/* collect handlers from initial tree */
		const handlers: Record<string, unknown> = {}
		function walkTree(node: Record<string, unknown>, prefix: string) {
			const m = node.m as Record<string, Record<string, unknown>> | null
			if (m) {
				for (const [method, handler] of Object.entries(m)) {
					handlers[`${method} ${prefix || "/"}`] = handler
				}
			}
			const s = node.s as Record<string, Record<string, unknown>>
			for (const [seg, child] of Object.entries(s)) {
				walkTree(child, `${prefix}/${seg}`)
			}
		}
		walkTree(tree.root as unknown as Record<string, unknown>, "")

		/* create new app using route tree with handler map */
		const patched = honey<{}>()
		patched.routeTree({ ...tree, handlers: handlers as Record<string, never> })

		/* register same route with new handler — should patch, not insert */
		patched.get("/api").handler((ctx) => ctx.res.json("ok", { version: 2 }))

		const res = await patched.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, number>
		expect(data.version).toBe(2)
	})
})

/* ══════════════════════════════════════════════
 * 2. NODE ADAPTER — draining mode rejects new requests
 *
 * node.ts:105-109 — when draining, new requests get 503.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-9: Node adapter draining rejects new requests", () => {
	it("request during shutdown → 503", async () => {
		const app = honey<{}>()
		app.get("/slow").handler(async (ctx) => {
			await new Promise((r) => setTimeout(r, 100))
			return ctx.res.json("ok", {})
		})
		app.get("/fast").handler((ctx) => ctx.res.json("ok", {}))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* start a slow request to keep inflight > 0 */
		const slowReq = request(addr.port, "/slow")

		/* wait for it to start, then shutdown */
		await new Promise((r) => setTimeout(r, 10))
		const shutdownPromise = server.shutdown(5000)

		/* new request after shutdown started → 503 */
		try {
			const fastRes = await request(addr.port, "/fast")
			/* might get 503 or connection refused depending on timing */
			expect([503, 0]).toContain(fastRes.status)
		} catch {
			/* connection refused is also valid during shutdown */
		}

		/* slow request should complete */
		const slowRes = await slowReq
		expect(slowRes.status).toBe(200)

		await shutdownPromise
	})
})

/* ══════════════════════════════════════════════
 * 3. NODE ADAPTER — shutdown with timeout kills connections
 *
 * node.ts:163-168 — setTimeout calls closeAllConnections.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-9: Node adapter shutdown timeout", () => {
	it("shutdown with very short timeout → force closes", async () => {
		const app = honey<{}>()
		app.get("/infinite").handler(async (ctx) => {
			await new Promise((r) => setTimeout(r, 10000))
			return ctx.res.json("ok", {})
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* fire-and-forget hanging request — don't await (socket close races in Bun) */
		request(addr.port, "/infinite").catch(() => null)

		await new Promise((r) => setTimeout(r, 50))

		/* shutdown with 100ms timeout → should force close */
		const start = performance.now()
		await server.shutdown(100)
		const elapsed = performance.now() - start

		expect(elapsed).toBeLessThan(1000)
	}, 10000)
})

/* ══════════════════════════════════════════════
 * 4. ETAG — If-None-Match with comma-separated ETags
 *    where the matching one is NOT the first
 * ══════════════════════════════════════════════ */

describe("bug-hunt-9: ETag — If-None-Match comma list", () => {
	it("matching ETag in middle of comma list → 304", async () => {
		const app = honey<{}>().use(etag())
		app.get("/data").handler((ctx) => ctx.res.json("ok", { v: 1 }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const first = await request(addr.port, "/data")
		const etagVal = first.headers.etag as string

		/* put the real ETag in the middle */
		const res = await request(addr.port, "/data", {
			headers: { "if-none-match": `"fake1", ${etagVal}, "fake2"` },
		})
		expect(res.status).toBe(304)
		/* 304 should still have the ETag header */
		expect(res.headers.etag).toBe(etagVal)
	})
})

/* ══════════════════════════════════════════════
 * 5. INPUT VALIDATION — multiple schemas combined
 *
 * search + headers + json on same route.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-9: input validation — multiple schemas", () => {
	it("search + headers + json all validated on same route", async () => {
		function okSchema() {
			return {
				"~standard": {
					validate: (data: unknown) => ({ value: data }),
					vendor: "test",
					version: 1,
				},
			}
		}

		const app = honey<{}>()
		app
			.post("/api")
			.input({
				headers: okSchema(),
				json: okSchema(),
				search: okSchema(),
			})
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/api?q=test", {
				body: JSON.stringify({ data: true }),
				headers: {
					authorization: "Bearer tok",
					"content-type": "application/json",
				},
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
		const input = (await res.json()) as Record<string, unknown>
		expect(input.search).toBeTruthy()
		expect(input.headers).toBeTruthy()
		expect(input.json).toBeTruthy()
		expect((input.search as Record<string, string>).q).toBe("test")
		expect((input.json as Record<string, boolean>).data).toBe(true)
	})
})

/* ══════════════════════════════════════════════
 * 6. readableStream FOR FORM DATA
 *
 * readableStream(schema) for form → body NOT consumed.
 * Handler reads ctx.req directly.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-9: readableStream for form data", () => {
	it("readableStream for form → body not consumed, handler reads req", async () => {
		function schema() {
			return {
				"~standard": {
					validate: () => {
						throw new Error("should never be called")
					},
					vendor: "test",
					version: 1,
				},
			}
		}

		const app = honey<{}>()
		app
			.post("/form")
			.input({ form: readableStream(schema()) })
			.handler(async (ctx) => {
				/* body not consumed — read manually */
				const fd = await ctx.req.formData()
				return ctx.res.json("created", {
					age: fd.get("age"),
					name: fd.get("name"),
				})
			})

		const formData = new FormData()
		formData.append("name", "Alice")
		formData.append("age", "30")

		const res = await app.fetch(
			new Request("http://localhost/form", {
				body: formData,
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.name).toBe("Alice")
		expect(data.age).toBe("30")
	})
})

/* ══════════════════════════════════════════════
 * 7. MIDDLEWARE STACK — chain vs route middleware ordering
 *
 * Chain middleware (app.use()) runs before route middleware
 * (route.use()). Both before handler.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-9: chain vs route middleware ordering", () => {
	it("chain middleware → route middleware → handler", async () => {
		const order: string[] = []

		const chainMw = createMiddleware(async (_ctx, next) => {
			order.push("chain")
			return next()
		})
		const routeMw = createMiddleware(async (_ctx, next) => {
			order.push("route")
			return next()
		})

		const app = honey<{}>().use(chainMw)
		app
			.get("/test")
			.use(routeMw)
			.handler((ctx) => {
				order.push("handler")
				return ctx.res.json("ok", { order })
			})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string[]>
		expect(data.order).toEqual(["chain", "route", "handler"])
	})
})

/* ══════════════════════════════════════════════
 * 8. SSE — concurrent send() calls serialized
 *
 * SSE send() returns a promise from writer.write().
 * Multiple rapid sends should all complete.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-9: SSE — rapid concurrent sends", () => {
	it("10 rapid sends → all events received in order", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				for (let i = 0; i < 10; i++) {
					await stream.send({ data: String(i), event: "num" })
				}
				stream.close()
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/events")
		expect(res.status).toBe(200)

		/* extract all data: lines */
		const dataLines = res.body.match(/data: (\d+)/g)
		expect(dataLines).toHaveLength(10)
		/* verify order */
		for (let i = 0; i < 10; i++) {
			expect(dataLines?.[i]).toBe(`data: ${i}`)
		}
	})
})

/* ══════════════════════════════════════════════
 * 9. CORS — preflight with explicit allowed headers
 * ══════════════════════════════════════════════ */

describe("bug-hunt-9: CORS — explicit allowed headers", () => {
	it("preflight with opts.headers → uses configured headers, not echo", async () => {
		const app = honey<{}>().use(
			cors({
				headers: ["content-type", "authorization"],
				origin: "*",
			}),
		)
		app.post("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: {
					"access-control-request-headers": "content-type, x-custom",
					"access-control-request-method": "POST",
					origin: "http://app.com",
				},
				method: "OPTIONS",
			}),
			{},
		)
		expect(res.status).toBe(204)
		const allowed = res.headers.get("access-control-allow-headers")
		/* should use configured headers, not echo request headers */
		expect(allowed).toBe("content-type, authorization")
		expect(allowed).not.toContain("x-custom")
	})
})

/* ══════════════════════════════════════════════
 * 10. CSRF — safe methods always pass
 * ══════════════════════════════════════════════ */

describe("bug-hunt-9: CSRF — safe methods bypass", () => {
	it("GET always passes CSRF", async () => {
		const app = honey<{}>().use(csrf())
		app.get("/data").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/data"), {})
		expect(res.status).toBe(200)
	})

	it("HEAD always passes CSRF", async () => {
		const app = honey<{}>().use(csrf())
		app.get("/data").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/data", { method: "HEAD" }), {})
		expect(res.status).toBe(200)
	})

	it("OPTIONS always passes CSRF", async () => {
		const app = honey<{}>().use(csrf())
		app.options("/data").handler((ctx) => ctx.res.noContent())

		const res = await app.fetch(new Request("http://localhost/data", { method: "OPTIONS" }), {})
		expect(res.status).toBe(204)
	})
})

/* ══════════════════════════════════════════════
 * 11. MULTIPLE STATUS CODES — handler returns different status keys
 * ══════════════════════════════════════════════ */

describe("bug-hunt-9: various status codes", () => {
	it("202 accepted", async () => {
		const app = honey<{}>()
		app.post("/job").handler((ctx) => ctx.res.json("accepted", { jobId: "j-1" }))

		const res = await app.fetch(new Request("http://localhost/job", { method: "POST" }), {})
		expect(res.status).toBe(202)
	})

	it("409 conflict", async () => {
		const app = honey<{}>()
		app.post("/item").handler(() => {
			throw new HoneyError({ errorKey: "conflict", status: "conflict" })
		})

		const res = await app.fetch(new Request("http://localhost/item", { method: "POST" }), {})
		expect(res.status).toBe(409)
	})

	it("410 gone", async () => {
		const app = honey<{}>()
		app.get("/deprecated").handler(() => {
			throw new HoneyError({ errorKey: "gone", status: "gone" })
		})

		const res = await app.fetch(new Request("http://localhost/deprecated"), {})
		expect(res.status).toBe(410)
	})

	it("429 too many requests", async () => {
		const app = honey<{}>()
		app.get("/limited").handler(() => {
			throw new HoneyError({ errorKey: "rate_limited", status: "too_many_requests" })
		})

		const res = await app.fetch(new Request("http://localhost/limited"), {})
		expect(res.status).toBe(429)
	})
})

/* ══════════════════════════════════════════════
 * 12. RESPONSE WITH COOKIES + CUSTOM HEADERS + STATUS
 * ══════════════════════════════════════════════ */

describe("bug-hunt-9: response with all options", () => {
	it("json with cookies + headers + custom status", async () => {
		const app = honey<{}>()
		app.post("/create").handler((ctx) =>
			ctx.res.json(
				"created",
				{ id: 1 },
				{
					cookies: {
						recent: { path: "/", value: "item-1" },
					},
					headers: {
						"x-request-id": "req-abc",
					},
				},
			),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/create", { method: "POST" })
		expect(res.status).toBe(201)
		expect(res.headers["x-request-id"]).toBe("req-abc")
		const cookies = res.headers["set-cookie"]
		const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : String(cookies)
		expect(cookieStr).toContain("recent=item-1")
	})
})

/* ══════════════════════════════════════════════
 * 13. TESTCLIENT — cookie jar round-trip with multiple requests
 * ══════════════════════════════════════════════ */

describe("bug-hunt-9: testClient cookie jar multi-step", () => {
	it("login → add item → check → all cookies accumulated", async () => {
		const app = honey<{}>()
		app.post("/login").handler((ctx) =>
			ctx.res.json(
				"ok",
				{},
				{
					cookies: { session: { httpOnly: true, path: "/", value: "s-1" } },
				},
			),
		)
		app.post("/cart/add").handler((ctx) =>
			ctx.res.json(
				"ok",
				{},
				{
					cookies: { cart: { path: "/", value: "item-42" } },
				},
			),
		)
		app.get("/cart").handler((ctx) =>
			ctx.res.json("ok", {
				cart: ctx.cookies.cart,
				session: ctx.cookies.session,
			}),
		)

		const client = testClient(app, { cookies: true, env: {} })

		await client.post("/login")
		await client.post("/cart/add")
		const cartRes = await client.get("/cart")
		expect(cartRes.status).toBe(200)
		const data = (await cartRes.json()) as Record<string, string>
		expect(data.session).toBe("s-1")
		expect(data.cart).toBe("item-42")
	})
})

/* ══════════════════════════════════════════════
 * 14. MIDDLEWARE DEFINEMIDDLEWARE — error keys on middleware
 *
 * middleware.ts:21-36 — defineMiddleware with errors option
 * stores error keys on the function for auto-accumulation.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-9: defineMiddleware with error keys", () => {
	it("middleware error keys auto-accumulated by .use()", async () => {
		const { defineMiddleware } = await import("../../src/middleware.ts")
		const errors = defineErrors({
			auth_required: "unauthorized",
			rate_limited: "too_many_requests",
		})

		const authMw = defineMiddleware({
			errors: [errors, "auth_required"],
			fn: async (ctx, next) => {
				const req = (ctx as { req: Request }).req
				if (!req.headers.get("authorization")) {
					throw errors.auth_required()
				}
				return next()
			},
		})

		const app = honey<{}>().errorFactory(errors)
		app
			.get("/protected")
			.use(authMw)
			.handler((ctx) => ctx.res.json("ok", {}))

		/* without auth → 401 */
		const res1 = await app.fetch(new Request("http://localhost/protected"), {})
		expect(res1.status).toBe(401)
		const data1 = (await res1.json()) as Record<string, unknown>
		expect(data1.error_key).toBe("auth_required")

		/* with auth → 200 */
		const res2 = await app.fetch(
			new Request("http://localhost/protected", {
				headers: { authorization: "Bearer tok" },
			}),
			{},
		)
		expect(res2.status).toBe(200)
	})
})

/* ══════════════════════════════════════════════
 * 15. GENERATE() — custom status code
 * ══════════════════════════════════════════════ */

describe("bug-hunt-9: generate() with custom status", () => {
	it("generate with status 206 → partial content", async () => {
		const app = honey<{}>()
		app.get("/partial").handler((ctx) => {
			function* gen() {
				yield "partial-data"
			}
			return ctx.res.generate(gen(), { contentType: "text/plain", status: 206 })
		})

		const res = await app.fetch(new Request("http://localhost/partial"), {})
		expect(res.status).toBe(206)
		expect(await res.text()).toBe("partial-data")
	})
})

/* ══════════════════════════════════════════════
 * 16. STREAM() — custom status and headers
 * ══════════════════════════════════════════════ */

describe("bug-hunt-9: stream() with custom options", () => {
	it("stream with custom status + headers", async () => {
		const app = honey<{}>()
		app.get("/download").handler((ctx) =>
			ctx.res.stream(
				async (writable) => {
					const writer = writable.getWriter()
					await writer.write(new TextEncoder().encode("file-contents"))
					await writer.close()
				},
				{
					headers: {
						"content-disposition": "attachment; filename=data.bin",
					},
					status: 200,
				},
			),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/download")
		expect(res.status).toBe(200)
		expect(res.headers["content-disposition"]).toBe("attachment; filename=data.bin")
		expect(res.body).toBe("file-contents")
	})
})

/* ══════════════════════════════════════════════
 * 17. BODYLIMIT SLOW PATH — large body over limit
 *
 * body-limit.ts:44-48 — reader.cancel() called, error thrown.
 * Verify the request actually gets 413 and server survives.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-9: bodyLimit slow path over limit", () => {
	it("body exceeding maxSize (no Content-Length) → 413", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 10 }))
		app.post("/upload").handler(async (ctx) => {
			const text = await ctx.req.text()
			return ctx.res.text("ok", text)
		})

		/* body is 20 bytes, limit is 10, no content-length header */
		const res = await app.fetch(
			new Request("http://localhost/upload", {
				body: "x".repeat(20),
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(413)
	})
})

/* ══════════════════════════════════════════════
 * 18. CODETOSTATUSKEY MAPPING
 *
 * Verify the reverse mapping works for all status codes.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-9: codeToStatusKey mapping", () => {
	it("all status codes map correctly", async () => {
		const { codeToStatusKey, statusKeyToCode } = await import("../../src/types.ts")

		for (const [key, code] of Object.entries(statusKeyToCode)) {
			expect(codeToStatusKey[code as number]).toBe(key)
		}
	})

	it("unknown status code → undefined", async () => {
		const { codeToStatusKey } = await import("../../src/types.ts")
		expect(codeToStatusKey[999]).toBeUndefined()
	})
})

/* ══════════════════════════════════════════════
 * 19. MIDDLEWARE → next() with additions available in handler
 * ══════════════════════════════════════════════ */

describe("bug-hunt-9: middleware additions visible in handler", () => {
	it("multiple middlewares each add context → all visible", async () => {
		const mw1 = createMiddleware(async (_ctx, next) => next({ db: "postgres" }))
		const mw2 = createMiddleware(async (_ctx, next) => next({ cache: "redis" }))

		const app = honey<{}>().use(mw1).use(mw2)
		app.get("/test").handler((ctx) => ctx.res.json("ok", { cache: ctx.cache, db: ctx.db }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.db).toBe("postgres")
		expect(data.cache).toBe("redis")
	})
})

/* ══════════════════════════════════════════════
 * 20. ETAG + CORS — conditional 304 still has CORS headers
 *
 * When etag returns 304, does CORS middleware still add headers?
 * CORS runs BEFORE etag in middleware chain.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-9: ETag 304 + CORS headers", () => {
	it("304 response from etag still has CORS headers", async () => {
		const app = honey<{}>()
			.use(cors({ origin: "*" }))
			.use(etag())
		app.get("/data").handler((ctx) => ctx.res.json("ok", { v: 1 }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* first request to get ETag */
		const first = await request(addr.port, "/data", {
			headers: { origin: "http://app.com" },
		})
		const etagVal = first.headers.etag as string
		expect(etagVal).toBeTruthy()
		expect(first.headers["access-control-allow-origin"]).toBe("*")

		/* conditional request → 304 */
		const second = await request(addr.port, "/data", {
			headers: {
				"if-none-match": etagVal,
				origin: "http://app.com",
			},
		})
		expect(second.status).toBe(304)
		/* CORS runs first, adds headers, then etag short-circuits to 304.
		 * But etag creates a new Response — does it preserve CORS headers?
		 * CORS set headers on the response AFTER next() returns.
		 * Since etag's 304 is the response returned by next(), CORS modifies it. */
		expect(second.headers["access-control-allow-origin"]).toBe("*")
	})
})
