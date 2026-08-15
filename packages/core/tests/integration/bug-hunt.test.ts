import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { bodyLimit } from "../../src/body-limit.ts"
import { cors } from "../../src/cors.ts"
import { csrf } from "../../src/csrf.ts"
import { etag } from "../../src/etag.ts"
import { honey } from "../../src/index.ts"
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

/* ──────────────────────────────────────────────
 * HUNCH 1: ETag 304 response missing ETag header
 *
 * The etag middleware computes etagValue, checks If-None-Match,
 * and if matched returns 304 with `response.headers` — but
 * the ETag header is set AFTER the 304 return path.
 * Per RFC 7232 §4.1, a 304 MUST include ETag.
 * ────────────────────────────────────────────── */

describe("bug-hunt: ETag 304 must include ETag header (RFC 7232 §4.1)", () => {
	it("304 response includes ETag header", async () => {
		const app = honey<{}>().use(etag())
		app.get("/data").handler((ctx) => ctx.res.json("ok", { stable: true }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* first request → get the ETag */
		const first = await request(addr.port, "/data")
		expect(first.status).toBe(200)
		const etagVal = first.headers.etag as string
		expect(etagVal).toBeTruthy()

		/* conditional request → 304 */
		const second = await request(addr.port, "/data", {
			headers: { "if-none-match": etagVal },
		})
		expect(second.status).toBe(304)

		/* RFC 7232 §4.1: 304 MUST include ETag */
		expect(second.headers.etag).toBe(etagVal)
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 2: ETag If-None-Match: * wildcard not handled
 *
 * RFC 7232 §3.2: "If the field value is '*', the condition
 * is false if the origin server has a current representation
 * for the target resource."
 * The code only does string comparison, never checks for *.
 * ────────────────────────────────────────────── */

describe("bug-hunt: ETag If-None-Match: * wildcard (RFC 7232 §3.2)", () => {
	it("If-None-Match: * returns 304 for any existing resource", async () => {
		const app = honey<{}>().use(etag())
		app.get("/data").handler((ctx) => ctx.res.json("ok", { exists: true }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* wildcard should match any ETag */
		const res = await request(addr.port, "/data", {
			headers: { "if-none-match": "*" },
		})
		expect(res.status).toBe(304)
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 3: CSRF blocks non-browser mutation requests
 *
 * When Content-Type is absent, csrf.ts defaults to "text/plain"
 * which matches formContentTypeRe. If sec-fetch-site and origin
 * are also absent (server-to-server, curl), the request is blocked.
 * DELETE/POST without Content-Type is common for API clients.
 * ────────────────────────────────────────────── */

describe("bug-hunt: CSRF blocks API calls without Content-Type", () => {
	it("DELETE with no Content-Type, no browser headers → should not be 403", async () => {
		const app = honey<{}>().use(csrf({ origin: "http://app.com" }))
		app.delete("/resource/:id").handler((ctx) => ctx.res.noContent())
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* simulate curl/API client: no content-type, no sec-fetch-site, no origin */
		const res = await request(addr.port, "/resource/42", { method: "DELETE" })
		/* API clients shouldn't be blocked by CSRF */
		expect(res.status).toBe(204)
	})

	it("POST with application/json and no sec-fetch-site → should pass", async () => {
		const app = honey<{}>().use(csrf({ origin: "http://app.com" }))
		app.post("/api").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, string>
			return ctx.res.json("ok", body)
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* JSON content-type not a "form" → should bypass CSRF */
		const res = await request(addr.port, "/api", {
			body: JSON.stringify({ name: "test" }),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		expect(res.status).toBe(200)
	})

	it("POST with no Content-Type from API client → should not be 403", async () => {
		const app = honey<{}>().use(csrf({ origin: "http://app.com" }))
		app.post("/webhook").handler((ctx) => ctx.res.json("ok", { received: true }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* webhook callback with no content-type, no browser headers */
		const res = await request(addr.port, "/webhook", {
			method: "POST",
		})
		expect(res.status).toBe(200)
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 4: body limit + input validation double body read
 *
 * Input validation is prepended to middleware chain, runs FIRST.
 * It calls req.json() consuming the body stream.
 * Body limit runs AFTER, tries to read req.body stream → already consumed.
 * Both use the same Request object.
 * ────────────────────────────────────────────── */

describe("bug-hunt: bodyLimit + input validation double body consumption", () => {
	function okSchema() {
		return {
			"~standard": {
				validate: (data: unknown) => ({ value: data }),
				vendor: "test",
				version: 1,
			},
		}
	}

	it("bodyLimit + .input({ json }) on same route → should work", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 10000 }))
		app
			.post("/users")
			.input({ json: okSchema() })
			.handler((ctx) => ctx.res.json("created", { input: ctx.input }))

		const res = await app.fetch(
			new Request("http://localhost/users", {
				body: JSON.stringify({ email: "test@test.com", name: "Alice" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
		const data = (await res.json()) as Record<string, unknown>
		const input = data.input as Record<string, unknown>
		const json = input.json as Record<string, string>
		expect(json.name).toBe("Alice")
		expect(json.email).toBe("test@test.com")
	})

	it("bodyLimit + .input({ json }) over HTTP → should work", async () => {
		const schema = okSchema()
		const app = honey<{}>().use(bodyLimit({ maxSize: 10000 }))
		app
			.post("/users")
			.input({ json: schema })
			.handler((ctx) => ctx.res.json("created", ctx.input))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/users", {
			body: JSON.stringify({ name: "Bob" }),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		expect(res.status).toBe(201)
		const data = JSON.parse(res.body) as Record<string, unknown>
		expect((data.json as Record<string, string>).name).toBe("Bob")
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 5: CORS preflight doesn't echo Access-Control-Request-Headers
 *
 * Browsers send preflight with Access-Control-Request-Headers.
 * If CORS has no `headers` option, the preflight response omits
 * Access-Control-Allow-Headers, causing browser to block request.
 * ────────────────────────────────────────────── */

describe("bug-hunt: CORS preflight should handle requested headers", () => {
	it("preflight with Access-Control-Request-Headers → should echo allowed headers", async () => {
		const app = honey<{}>().use(cors({ origin: "http://app.com" }))
		app.post("/api").handler((ctx) => ctx.res.json("ok", {}))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/api", {
			headers: {
				"access-control-request-headers": "content-type, authorization",
				"access-control-request-method": "POST",
				origin: "http://app.com",
			},
			method: "OPTIONS",
		})
		expect(res.status).toBe(204)
		expect(res.headers["access-control-allow-origin"]).toBe("http://app.com")

		/* browser will block if allowed headers not present */
		const allowHeaders = res.headers["access-control-allow-headers"]
		expect(allowHeaders).toBeTruthy()
		expect(allowHeaders).toContain("content-type")
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 6: ETag empty body after arrayBuffer consumption
 *
 * The etag middleware calls response.arrayBuffer() to hash body.
 * Then creates new Response(body, ...) with the buffer.
 * But if response was a streaming response that already piped,
 * arrayBuffer() might resolve to empty. More importantly,
 * what happens with a response that has status 200 but empty body?
 * ────────────────────────────────────────────── */

describe("bug-hunt: ETag middleware body reconstruction", () => {
	it("etag + response with cookies → cookies preserved after reconstruction", async () => {
		const app = honey<{}>().use(etag())
		app.get("/data").handler((ctx) =>
			ctx.res.json(
				"ok",
				{ id: 1 },
				{
					cookies: {
						session: { httpOnly: true, path: "/", value: "tok-abc" },
					},
				},
			),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/data")
		expect(res.status).toBe(200)
		expect(res.headers.etag).toBeTruthy()
		/* cookies must survive the response reconstruction */
		const cookies = res.headers["set-cookie"]
		expect(cookies).toBeTruthy()
		const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : String(cookies)
		expect(cookieStr).toContain("session=tok-abc")
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 7: route matching with encoded characters in path
 *
 * The router splits on "/" and calls decode() on param segments.
 * But what about %2F (encoded slash) in a param?
 * /users/john%2Fdoe should match /users/:name with name="john/doe"
 * ────────────────────────────────────────────── */

describe("bug-hunt: route param with encoded characters", () => {
	it("encoded slash %2F in param → decoded correctly", async () => {
		const app = honey<{}>()
		app.get("/files/:path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		/* %2F is encoded slash — the URL parser splits on real / but param
		   segment should contain the encoded version decoded */
		const res = await app.fetch(new Request("http://localhost/files/docs%2Freadme.md"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.path).toBe("docs/readme.md")
	})

	it("encoded space %20 in param → decoded correctly", async () => {
		const app = honey<{}>()
		app.get("/search/:query").handler((ctx) => ctx.res.json("ok", { query: ctx.params.query }))

		const res = await app.fetch(new Request("http://localhost/search/hello%20world"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.query).toBe("hello world")
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 8: secure-headers mutates response headers in place
 *
 * secureHeaders does response.headers.set() on the original response.
 * In some environments, Response headers are immutable.
 * But more importantly: if the handler returns ctx.res.redirect(),
 * the redirect response's headers might not be mutable.
 * ────────────────────────────────────────────── */

describe("bug-hunt: secure-headers + various response types", () => {
	it("secure-headers applied to redirect response", async () => {
		const { secureHeaders } = await import("../../src/secure-headers.ts")
		const app = honey<{}>().use(secureHeaders())
		app.get("/old").handler((ctx) => ctx.res.redirect("/new"))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await new Promise<{ headers: http.IncomingHttpHeaders; status: number }>(
			(resolve, reject) => {
				const req = http.request(
					{ hostname: "127.0.0.1", method: "GET", path: "/old", port: addr.port },
					(r) => {
						resolve({ headers: r.headers, status: r.statusCode ?? 0 })
						r.resume()
					},
				)
				req.on("error", reject)
				req.end()
			},
		)
		expect(res.status).toBe(302)
		expect(res.headers.location).toBe("/new")
		/* secure headers should still be applied to redirects */
		expect(res.headers["x-content-type-options"]).toBe("nosniff")
	})

	it("secure-headers applied to 204 no-content response", async () => {
		const { secureHeaders } = await import("../../src/secure-headers.ts")
		const app = honey<{}>().use(secureHeaders())
		app.delete("/item").handler((ctx) => ctx.res.noContent())
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/item", { method: "DELETE" })
		expect(res.status).toBe(204)
		expect(res.headers["x-content-type-options"]).toBe("nosniff")
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 9: cookie parsing edge cases
 *
 * Cookies with = in value, empty value, quoted values
 * ────────────────────────────────────────────── */

describe("bug-hunt: cookie parsing edge cases", () => {
	it("cookie with = in value → full value preserved", async () => {
		const app = honey<{}>()
		app.get("/read").handler((ctx) => ctx.res.json("ok", { token: ctx.cookies.token }))

		const res = await app.fetch(
			new Request("http://localhost/read", {
				headers: { cookie: "token=abc=def=ghi" },
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.token).toBe("abc=def=ghi")
	})

	it("cookie with empty value → empty string", async () => {
		const app = honey<{}>()
		app.get("/read").handler((ctx) => ctx.res.json("ok", { val: ctx.cookies.empty }))

		const res = await app.fetch(
			new Request("http://localhost/read", {
				headers: { cookie: "empty=; other=val" },
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.val).toBe("")
	})

	it("cookie with no = sign → skipped", async () => {
		const app = honey<{}>()
		app.get("/read").handler((ctx) =>
			ctx.res.json("ok", {
				count: Object.keys(ctx.cookies).length,
				valid: ctx.cookies.valid,
			}),
		)

		const res = await app.fetch(
			new Request("http://localhost/read", {
				headers: { cookie: "malformed; valid=yes; also_bad" },
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.valid).toBe("yes")
		expect(data.count).toBe(1)
	})
})

/* ──────────────────────────────────────────────
 * HUNCH 10: basePath + 405 interaction
 *
 * When basePath is set and a route exists at the stripped path
 * but with a different method, does 405 still work correctly?
 * ────────────────────────────────────────────── */

describe("bug-hunt: basePath + method not allowed", () => {
	it("basePath + wrong method → 405 with Allow header", async () => {
		const app = honey<{}>().basePath("/api/v1")
		app.get("/users").handler((ctx) => ctx.res.json("ok", { users: [] }))
		app.post("/users").handler((ctx) => ctx.res.json("created", { id: 1 }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/api/v1/users", { method: "DELETE" })
		expect(res.status).toBe(405)
		expect(res.headers.allow).toBeTruthy()
		const allowed = (res.headers.allow as string).split(",").map((s) => s.trim())
		expect(allowed).toContain("GET")
		expect(allowed).toContain("POST")
	})
})
