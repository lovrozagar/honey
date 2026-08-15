import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { bodyLimit } from "../../src/body-limit.ts"
import { HoneyError } from "../../src/error.ts"
import { defineErrors } from "../../src/errors.ts"
import { honey } from "../../src/index.ts"
import { createMiddleware } from "../../src/middleware.ts"
import { type HoneyServer, serve } from "../../src/node.ts"
import { serializeCookie } from "../../src/response.ts"

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
 * COOKIE SERIALIZATION EDGE CASES
 * ══════════════════════════════════════════════ */

describe("bug-hunt-5: cookie serialization — __Host- prefix", () => {
	it("__Host- cookie requires secure: true", () => {
		expect(() => serializeCookie("__Host-session", { value: "abc" })).toThrow("__Host- cookies require secure: true")
	})

	it("__Host- cookie must not set domain", () => {
		expect(() => serializeCookie("__Host-session", { domain: "example.com", secure: true, value: "abc" })).toThrow(
			"__Host- cookies must not set domain",
		)
	})

	it("__Host- cookie auto-sets path to /", () => {
		const cookie = serializeCookie("__Host-session", { secure: true, value: "abc" })
		expect(cookie).toContain("Path=/")
		expect(cookie).toContain("Secure")
	})

	it("__Host- cookie with explicit path=/ works", () => {
		const cookie = serializeCookie("__Host-session", { path: "/", secure: true, value: "abc" })
		expect(cookie).toContain("Path=/")
	})

	it("__Host- cookie with path=/sub rejects", () => {
		expect(() => serializeCookie("__Host-session", { path: "/sub", secure: true, value: "abc" })).toThrow(
			"__Host- cookies must have path",
		)
	})
})

describe("bug-hunt-5: cookie serialization — __Secure- prefix", () => {
	it("__Secure- cookie requires secure: true", () => {
		expect(() => serializeCookie("__Secure-tok", { value: "abc" })).toThrow("__Secure- cookies require secure: true")
	})

	it("__Secure- cookie with secure: true works", () => {
		const cookie = serializeCookie("__Secure-tok", { secure: true, value: "abc" })
		expect(cookie).toContain("__Secure-tok=abc")
		expect(cookie).toContain("Secure")
	})
})

describe("bug-hunt-5: cookie serialization — SameSite=None", () => {
	it("SameSite=None without Secure → throws", () => {
		expect(() => serializeCookie("test", { sameSite: "none", value: "abc" })).toThrow(
			"SameSite=None cookies require secure: true",
		)
	})

	it("SameSite=None with Secure → works", () => {
		const cookie = serializeCookie("test", { sameSite: "none", secure: true, value: "abc" })
		expect(cookie).toContain("SameSite=None")
		expect(cookie).toContain("Secure")
	})
})

describe("bug-hunt-5: cookie serialization — special values", () => {
	it("cookie value with spaces is percent-encoded", () => {
		const cookie = serializeCookie("msg", { value: "hello world" })
		expect(cookie).toContain("msg=hello%20world")
	})

	it("cookie value with semicolons is percent-encoded", () => {
		const cookie = serializeCookie("data", { value: "a;b;c" })
		expect(cookie).toContain("data=a%3Bb%3Bc")
	})

	it("invalid cookie name throws", () => {
		expect(() => serializeCookie("bad name", { value: "x" })).toThrow("Invalid cookie name")
	})

	it("maxAge 0 is valid (immediate expiry)", () => {
		const cookie = serializeCookie("session", { maxAge: 0, value: "x" })
		expect(cookie).toContain("Max-Age=0")
	})

	it("maxAge Infinity throws", () => {
		expect(() => serializeCookie("test", { maxAge: Infinity, value: "x" })).toThrow("Invalid cookie Max-Age")
	})

	it("maxAge NaN throws", () => {
		expect(() => serializeCookie("test", { maxAge: NaN, value: "x" })).toThrow("Invalid cookie Max-Age")
	})

	it("maxAge negative throws", () => {
		expect(() => serializeCookie("test", { maxAge: -1, value: "x" })).toThrow("Invalid cookie Max-Age")
	})

	it("expires date serialized", () => {
		const date = new Date("2030-01-01T00:00:00Z")
		const cookie = serializeCookie("test", { expires: date, value: "x" })
		expect(cookie).toContain("Expires=")
		expect(cookie).toContain("2030")
	})
})

/* ══════════════════════════════════════════════
 * OUTPUT VALIDATION
 * ══════════════════════════════════════════════ */

describe("bug-hunt-5: output validation", () => {
	function okOutputSchema() {
		return {
			"~standard": {
				validate: (data: unknown) => ({ value: data }),
				vendor: "test",
				version: 1,
			},
		}
	}

	function strictOutputSchema() {
		return {
			"~standard": {
				validate: (data: unknown) => {
					const d = data as Record<string, unknown>
					if (typeof d.name !== "string") {
						return { issues: [{ message: "name must be string", path: ["name"] }] }
					}
					return { value: data }
				},
				vendor: "test",
				version: 1,
			},
		}
	}

	it("output validation pass → response returned normally", async () => {
		const app = honey<{}>()
		app.outputValidation("always")
		app
			.get("/api")
			.output({ "application/json": { ok: okOutputSchema() } })
			.handler((ctx) => ctx.res.json("ok", { name: "Alice" }))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
	})

	it("output validation fail → 500", async () => {
		const app = honey<{}>()
		app.outputValidation("always")
		app
			.get("/api")
			.output({ "application/json": { ok: strictOutputSchema() } })
			.handler((ctx) => ctx.res.json("ok", { name: 42 }))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(500)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("output_validation_failed")
	})

	it("output validation off → no validation", async () => {
		const app = honey<{}>()
		app.outputValidation("off")
		app
			.get("/api")
			.output({ "application/json": { ok: strictOutputSchema() } })
			.handler((ctx) => ctx.res.json("ok", { name: 42 }))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		/* should pass without validation */
		expect(res.status).toBe(200)
	})
})

/* ══════════════════════════════════════════════
 * ERROR ENFORCEMENT — handler.ek runtime check
 * ══════════════════════════════════════════════ */

describe("bug-hunt-5: error key enforcement", () => {
	it("declared error key → original error preserved", async () => {
		const errors = defineErrors({
			item_not_found: "not_found",
		})

		const app = honey<{}>().errorFactory(errors)
		app
			.get("/item")
			.errors("item_not_found")
			.handler(() => {
				throw errors.item_not_found()
			})

		const res = await app.fetch(new Request("http://localhost/item"), {})
		expect(res.status).toBe(404)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("item_not_found")
	})

	it("undeclared error key → wrapped as internal_server_error", async () => {
		const errors = defineErrors({
			item_not_found: "not_found",
			secret_error: "internal_server_error",
		})

		const app = honey<{}>().errorFactory(errors)
		app
			.get("/item")
			.errors("item_not_found")
			.handler(() => {
				/* throws an error key not declared on this route */
				throw errors.secret_error()
			})

		const res = await app.fetch(new Request("http://localhost/item"), {})
		expect(res.status).toBe(500)
		const data = (await res.json()) as Record<string, unknown>
		/* should be wrapped as internal_server_error, not expose secret_error */
		expect(data.error_key).toBe("internal_server_error")
	})
})

/* ══════════════════════════════════════════════
 * SSE EDGE CASES
 * ══════════════════════════════════════════════ */

describe("bug-hunt-5: SSE edge cases", () => {
	it("SSE with multi-line data → each line gets data: prefix", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({
					data: "line1\nline2\nline3",
					event: "multi",
				})
				stream.close()
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/events")
		expect(res.status).toBe(200)
		/* each line should have its own data: prefix */
		expect(res.body).toContain("data: line1\n")
		expect(res.body).toContain("data: line2\n")
		expect(res.body).toContain("data: line3\n")
	})

	it("SSE with object data → JSON stringified", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({
					data: { count: 42, name: "test" },
					event: "update",
				})
				stream.close()
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/events")
		expect(res.status).toBe(200)
		expect(res.body).toContain("event: update")
		/* data should be JSON */
		const dataMatch = res.body.match(/data: (.+)/)
		expect(dataMatch).toBeTruthy()
		const parsed = JSON.parse(dataMatch?.[1] ?? "null") as Record<string, unknown>
		expect(parsed.name).toBe("test")
		expect(parsed.count).toBe(42)
	})

	it("SSE with event id → id field emitted", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: "hello", event: "msg", id: "evt-1" })
				stream.close()
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/events")
		expect(res.body).toContain("id: evt-1")
	})

	it("SSE lastEventId from request → available in stream", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({
					data: stream.lastEventId ?? "none",
					event: "resume",
				})
				stream.close()
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/events", {
			headers: { "last-event-id": "evt-42" },
		})
		expect(res.body).toContain("data: evt-42")
	})

	it("SSE defaultRetry → retry field emitted at start", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(
				async (stream) => {
					await stream.send({ data: "x", event: "msg" })
					stream.close()
				},
				{ defaultRetry: 5000 },
			),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/events")
		expect(res.body).toContain("retry: 5000")
	})
})

/* ══════════════════════════════════════════════
 * GENERATE() STREAMING
 * ══════════════════════════════════════════════ */

describe("bug-hunt-5: generate() streaming", () => {
	it("async generator produces streamed output", async () => {
		const app = honey<{}>()
		app.get("/stream").handler((ctx) => {
			async function* gen() {
				yield "chunk1-"
				yield "chunk2-"
				yield "chunk3"
			}
			return ctx.res.generate(gen())
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/stream")
		expect(res.status).toBe(200)
		expect(res.body).toBe("chunk1-chunk2-chunk3")
	})

	it("generator with custom content-type", async () => {
		const app = honey<{}>()
		app.get("/csv").handler((ctx) => {
			function* gen() {
				yield "name,age\n"
				yield "Alice,30\n"
				yield "Bob,25\n"
			}
			return ctx.res.generate(gen(), { contentType: "text/csv" })
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/csv")
		expect(res.status).toBe(200)
		expect(res.headers["content-type"]).toBe("text/csv")
		expect(res.body).toContain("Alice,30")
	})

	it("generator that throws → stream closed gracefully", async () => {
		const app = honey<{}>()
		app.get("/fail").handler((ctx) => {
			async function* gen() {
				yield "before-error"
				throw new Error("gen failure")
			}
			return ctx.res.generate(gen())
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/fail")
		/* stream should close gracefully, partial data received */
		expect(res.status).toBe(200)
		expect(res.body).toContain("before-error")
	})
})

/* ══════════════════════════════════════════════
 * BACKGROUND / WAITUNTIL
 * ══════════════════════════════════════════════ */

describe("bug-hunt-5: ctx.background / waitUntil", () => {
	it("background with waitUntil → delegates to waitUntil", async () => {
		let backgroundRan = false
		const app = honey<{}>()
		app.get("/bg").handler((ctx) => {
			ctx.background(
				new Promise<void>((resolve) => {
					backgroundRan = true
					resolve()
				}),
			)
			return ctx.res.json("ok", {})
		})

		const waitedPromises: Promise<unknown>[] = []
		await app.fetch(
			new Request("http://localhost/bg"),
			{},
			{
				waitUntil: (p) => waitedPromises.push(p),
			},
		)
		/* waitUntil should have received the background promise */
		expect(waitedPromises.length).toBe(1)
		await Promise.all(waitedPromises)
		expect(backgroundRan).toBe(true)
	})

	it("background without waitUntil → promise still runs (fire-and-forget)", async () => {
		let backgroundRan = false
		const app = honey<{}>()
		app.get("/bg").handler((ctx) => {
			ctx.background(
				new Promise<void>((resolve) => {
					setTimeout(() => {
						backgroundRan = true
						resolve()
					}, 10)
				}),
			)
			return ctx.res.json("ok", {})
		})

		await app.fetch(new Request("http://localhost/bg"), {})
		/* wait for the background task */
		await new Promise((r) => setTimeout(r, 50))
		expect(backgroundRan).toBe(true)
	})

	it("background with rejecting promise → doesn't crash", async () => {
		const app = honey<{}>()
		app.get("/bg").handler((ctx) => {
			ctx.background(Promise.reject(new Error("bg fail")))
			return ctx.res.json("ok", {})
		})

		/* should not crash the request */
		const res = await app.fetch(new Request("http://localhost/bg"), {})
		expect(res.status).toBe(200)
	})
})

/* ══════════════════════════════════════════════
 * ONEERROR HANDLER
 * ══════════════════════════════════════════════ */

describe("bug-hunt-5: onError custom handler", () => {
	it("onError returning Response → custom response used", async () => {
		const app = honey<{}>()
		app.onError(
			(_error, _ctx) =>
				new Response(JSON.stringify({ custom: true, msg: "handled" }), {
					headers: { "content-type": "application/json" },
					status: 503,
				}),
		)
		app.get("/fail").handler(() => {
			throw new Error("boom")
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(503)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.custom).toBe(true)
	})

	it("onError using jsonFromError → framework-formatted error", async () => {
		const app = honey<{}>()
		app.onError((_error, ctx) => {
			const err = new HoneyError({ errorKey: "custom_error", status: "service_unavailable" })
			return ctx.jsonFromError(err)
		})
		app.get("/fail").handler(() => {
			throw new Error("boom")
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(503)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("custom_error")
	})

	it("onError that throws → falls through to default", async () => {
		const app = honey<{}>()
		app.onError(() => {
			throw new Error("onError also broke")
		})
		app.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "original", status: "bad_request" })
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		/* should fall through to default error handling */
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("original")
	})
})

/* ══════════════════════════════════════════════
 * INPUT VALIDATION WITH DIFFERENT SCHEMA MODES
 * ══════════════════════════════════════════════ */

describe("bug-hunt-5: input validation — search params", () => {
	it("search schema validates query params", async () => {
		function searchSchema() {
			return {
				"~standard": {
					validate: (data: unknown) => {
						const d = data as Record<string, unknown>
						if (d.page === undefined) {
							return { issues: [{ message: "page required", path: ["page"] }] }
						}
						return { value: data }
					},
					vendor: "test",
					version: 1,
				},
			}
		}

		const app = honey<{}>()
		app
			.get("/items")
			.input({ search: searchSchema() })
			.handler((ctx) => ctx.res.json("ok", { search: ctx.input }))

		/* with page param → passes */
		const okRes = await app.fetch(new Request("http://localhost/items?page=1"), {})
		expect(okRes.status).toBe(200)

		/* without page param → 400 */
		const badRes = await app.fetch(new Request("http://localhost/items"), {})
		expect(badRes.status).toBe(400)
	})
})

describe("bug-hunt-5: input validation — headers", () => {
	it("headers schema validates request headers", async () => {
		function headerSchema() {
			return {
				"~standard": {
					validate: (data: unknown) => {
						const d = data as Record<string, unknown>
						if (!d.authorization) {
							return { issues: [{ message: "auth required", path: ["authorization"] }] }
						}
						return { value: data }
					},
					vendor: "test",
					version: 1,
				},
			}
		}

		const app = honey<{}>()
		app
			.get("/protected")
			.input({ headers: headerSchema() })
			.handler((ctx) => ctx.res.json("ok", {}))

		/* with auth header → passes */
		const okRes = await app.fetch(
			new Request("http://localhost/protected", {
				headers: { authorization: "Bearer tok" },
			}),
			{},
		)
		expect(okRes.status).toBe(200)

		/* without auth header → 400 */
		const badRes = await app.fetch(new Request("http://localhost/protected"), {})
		expect(badRes.status).toBe(400)
	})
})

describe("bug-hunt-5: input validation — cookies", () => {
	it("cookies schema validates cookie header", async () => {
		function cookieSchema() {
			return {
				"~standard": {
					validate: (data: unknown) => {
						const d = data as Record<string, unknown>
						if (!d.session) {
							return { issues: [{ message: "session required", path: ["session"] }] }
						}
						return { value: data }
					},
					vendor: "test",
					version: 1,
				},
			}
		}

		const app = honey<{}>()
		app
			.get("/dashboard")
			.input({ cookies: cookieSchema() })
			.handler((ctx) => ctx.res.json("ok", {}))

		/* with session cookie → passes */
		const okRes = await app.fetch(
			new Request("http://localhost/dashboard", {
				headers: { cookie: "session=abc123" },
			}),
			{},
		)
		expect(okRes.status).toBe(200)

		/* without session cookie → 400 */
		const badRes = await app.fetch(new Request("http://localhost/dashboard"), {})
		expect(badRes.status).toBe(400)
	})
})

describe("bug-hunt-5: input validation — params", () => {
	it("params schema validates route params", async () => {
		function paramSchema() {
			return {
				"~standard": {
					validate: (data: unknown) => {
						const d = data as Record<string, unknown>
						if (typeof d.id !== "string" || d.id.length === 0) {
							return { issues: [{ message: "id required", path: ["id"] }] }
						}
						return { value: data }
					},
					vendor: "test",
					version: 1,
				},
			}
		}

		const app = honey<{}>()
		app
			.get("/items/:id")
			.input({ params: paramSchema() })
			.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

		const res = await app.fetch(new Request("http://localhost/items/42"), {})
		expect(res.status).toBe(200)
	})
})

/* ══════════════════════════════════════════════
 * MIDDLEWARE CHAIN — deeply nested
 * ══════════════════════════════════════════════ */

describe("bug-hunt-5: deep middleware chains", () => {
	it("20 middlewares in chain → all execute in order", async () => {
		const order: number[] = []
		let app = honey<{}>()
		for (let i = 0; i < 20; i++) {
			const idx = i
			app = app.use(
				createMiddleware(async (_ctx, next) => {
					order.push(idx)
					return next()
				}),
			) as typeof app
		}
		app.get("/test").handler((ctx) => ctx.res.json("ok", { order }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, number[]>
		expect(data.order).toEqual(Array.from({ length: 20 }, (_, i) => i))
	})
})

/* ══════════════════════════════════════════════
 * RESPONSE HEADERS — custom headers via options
 * ══════════════════════════════════════════════ */

describe("bug-hunt-5: response custom headers", () => {
	it("custom headers from handler options", async () => {
		const app = honey<{}>()
		app.get("/api").handler((ctx) =>
			ctx.res.json(
				"ok",
				{},
				{
					headers: {
						"x-custom": "value",
						"x-request-id": "req-123",
					},
				},
			),
		)

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("x-custom")).toBe("value")
		expect(res.headers.get("x-request-id")).toBe("req-123")
		expect(res.headers.get("content-type")).toBe("application/json")
	})
})

/* ══════════════════════════════════════════════
 * BASEPATH + TRAILINGSLASH COMBINED
 * ══════════════════════════════════════════════ */

describe("bug-hunt-5: basePath + trailingSlash combined", () => {
	it("basePath + strip trailing slash → redirect then match", async () => {
		const app = honey<{}>().basePath("/api").trailingSlash("strip")
		app.get("/users").handler((ctx) => ctx.res.json("ok", {}))

		/* trailing slash on basePath + route → redirect */
		const res = await app.fetch(new Request("http://localhost/api/users/"), {})
		expect(res.status).toBe(308)

		/* without trailing slash → match */
		const res2 = await app.fetch(new Request("http://localhost/api/users"), {})
		expect(res2.status).toBe(200)
	})
})

/* ══════════════════════════════════════════════
 * NODE ADAPTER — concurrent POST requests
 * ══════════════════════════════════════════════ */

describe("bug-hunt-5: Node adapter concurrent POSTs", () => {
	it("concurrent POST requests with bodies → all processed correctly", async () => {
		const app = honey<{}>()
		app.post("/echo").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, unknown>
			return ctx.res.json("created", body)
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const promises = Array.from({ length: 5 }, (_, i) =>
			request(addr.port, "/echo", {
				body: JSON.stringify({ index: i }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
		)
		const results = await Promise.all(promises)

		for (let i = 0; i < 5; i++) {
			expect(results[i].status).toBe(201)
			const data = JSON.parse(results[i].body) as Record<string, unknown> as Record<string, number>
			expect(data.index).toBe(i)
		}
	})
})

/* ══════════════════════════════════════════════
 * CONTENT-TYPE MISMATCH ON OUTPUT
 * ══════════════════════════════════════════════ */

describe("bug-hunt-5: output content-type mismatch detection", () => {
	it("handler declares json output but returns text → 500", async () => {
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
		app.outputValidation("always")
		app
			.get("/api")
			.output({ "application/json": { ok: okSchema() } })
			.handler((ctx) =>
				ctx.res.raw(new Response("plain text", { headers: { "content-type": "text/plain" }, status: 200 })),
			)

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(500)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("output_content_type_mismatch")
	})
})

/* ══════════════════════════════════════════════
 * DEFAULTERRORS — applied across all routes
 * ══════════════════════════════════════════════ */

describe("bug-hunt-5: defaultErrors propagation", () => {
	it("defaultErrors keys available on all routes", async () => {
		const errors = defineErrors({
			auth_failed: "unauthorized",
			not_found: "not_found",
		})

		const app = honey<{}>().errorFactory(errors).defaultErrors("auth_failed")

		/* route only declares not_found, but auth_failed is a default */
		app
			.get("/item")
			.errors("not_found")
			.handler(() => {
				/* throw auth_failed — should be allowed because it's a default */
				throw errors.auth_failed()
			})

		const res = await app.fetch(new Request("http://localhost/item"), {})
		/* auth_failed is in defaultErrors, so should be allowed (not wrapped) */
		expect(res.status).toBe(401)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("auth_failed")
	})
})

/* ══════════════════════════════════════════════
 * BODYLIMT + CONTENT-LENGTH FAST PATH
 * ══════════════════════════════════════════════ */

describe("bug-hunt-5: bodyLimit content-length fast path", () => {
	it("content-length > maxSize → 413 without reading body", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 10 }))
		app.post("/upload").handler((ctx) => ctx.res.json("created", {}))

		const res = await app.fetch(
			new Request("http://localhost/upload", {
				body: "x".repeat(100),
				headers: { "content-length": "100" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(413)
	})

	it("content-length <= maxSize → body processed normally", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 100 }))
		app.post("/upload").handler(async (ctx) => {
			const text = await ctx.req.text()
			return ctx.res.text("ok", text)
		})

		const body = "hello"
		const res = await app.fetch(
			new Request("http://localhost/upload", {
				body,
				headers: { "content-length": String(body.length) },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("hello")
	})
})
