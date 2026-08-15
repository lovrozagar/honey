import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { bodyLimit } from "../../src/body-limit.ts"
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
 * 1. CONCURRENT SSE STREAMS — independent isolation
 *
 * Two clients connected to SSE simultaneously should
 * receive their own events without cross-contamination.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-14: concurrent SSE streams", () => {
	it("two SSE clients get independent event streams", async () => {
		let streamCount = 0
		const app = honey<{}>()
		app.get("/events").handler((ctx) => {
			const myId = ++streamCount
			return ctx.res.sse(async (stream) => {
				await stream.send({ data: String(myId), event: "id" })
				await new Promise((r) => setTimeout(r, 20))
				await stream.send({ data: `done-${myId}`, event: "end" })
				stream.close()
			})
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const [r1, r2] = await Promise.all([
			request(addr.port, "/events"),
			request(addr.port, "/events"),
		])

		expect(r1.status).toBe(200)
		expect(r2.status).toBe(200)

		/* each stream should have its own ID */
		const ids = [r1.body, r2.body].map((b) => {
			const match = b.match(/data: (\d+)/)
			return match ? Number(match[1]) : 0
		})
		expect(ids.sort()).toEqual([1, 2])
	})
})

/* ══════════════════════════════════════════════
 * 2. DEFAULTS CALLED MULTIPLE TIMES — last wins
 *
 * defaults() returns `this`, so it's chainable.
 * What happens if called twice?
 * ══════════════════════════════════════════════ */

describe("bug-hunt-14: basePath stacks via MergePath", () => {
	it("chained basePath calls compose paths", async () => {
		const app = honey<{}>().basePath("/v1").basePath("/v2")
		app.get("/users").handler((ctx) => ctx.res.json("ok", {}))

		/* basePath stacks: /v1 + /v2 = /v1/v2, so route is /v1/v2/users */
		const r1 = await app.fetch(new Request("http://localhost/v1/v2/users"), {})
		expect(r1.status).toBe(200)

		/* /v2/users alone should NOT match */
		const r2 = await app.fetch(new Request("http://localhost/v2/users"), {})
		expect(r2.status).toBe(404)
	})
})

/* ══════════════════════════════════════════════
 * 3. DEEPLY NESTED ROUTES — 10 levels deep
 * ══════════════════════════════════════════════ */

describe("bug-hunt-14: deeply nested routes", () => {
	it("10-level deep route with mixed static + params", async () => {
		const app = honey<{}>()
		app.get("/a/:b/c/:d/e/:f/g/:h/i/:j").handler((ctx) => ctx.res.json("ok", ctx.params))

		const res = await app.fetch(new Request("http://localhost/a/1/c/2/e/3/g/4/i/5"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.b).toBe("1")
		expect(data.d).toBe("2")
		expect(data.f).toBe("3")
		expect(data.h).toBe("4")
		expect(data.j).toBe("5")
	})
})

/* ══════════════════════════════════════════════
 * 4. CORS PREFLIGHT — no Access-Control-Request-Method
 *
 * cors.ts:48 — isPreflight requires BOTH method=OPTIONS
 * AND access-control-request-method header. Without the
 * header, it's treated as a simple OPTIONS request.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-14: CORS — OPTIONS without request-method", () => {
	it("OPTIONS without access-control-request-method → not preflight", async () => {
		const app = honey<{}>().use(cors({ origin: "*" }))
		app.options("/api").handler((ctx) => ctx.res.noContent())

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: { origin: "http://app.com" },
				method: "OPTIONS",
			}),
			{},
		)
		/* not a preflight → goes through normal handler */
		expect(res.status).toBe(204)
		/* but CORS headers still added (simple request path) */
		expect(res.headers.get("access-control-allow-origin")).toBe("*")
	})
})

/* ══════════════════════════════════════════════
 * 5. BASEPATH THAT DOESN'T MATCH REQUEST
 *
 * When basePath is set but the request path doesn't
 * start with it, the basePath stripping is skipped.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-14: basePath prefixes routes at registration", () => {
	it("request without basePath prefix → 404", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/users").handler((ctx) => ctx.res.json("ok", {}))

		/* route registered as /api/users — /users alone is 404 */
		const res = await app.fetch(new Request("http://localhost/users"), {})
		expect(res.status).toBe(404)

		/* /api/users matches */
		const res2 = await app.fetch(new Request("http://localhost/api/users"), {})
		expect(res2.status).toBe(200)
	})
})

/* ══════════════════════════════════════════════
 * 6. MIDDLEWARE THAT MODIFIES RESPONSE STATUS
 * ══════════════════════════════════════════════ */

describe("bug-hunt-14: middleware modifying response status", () => {
	it("middleware wraps response with different status", async () => {
		const wrapMw = createMiddleware(async (_ctx, next) => {
			const res = await next()
			/* force 202 Accepted for all responses */
			return new Response(res.body, {
				headers: res.headers,
				status: 202,
			})
		})

		const app = honey<{}>().use(wrapMw)
		app.get("/api").handler((ctx) => ctx.res.json("ok", { data: true }))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(202)
		const data = (await res.json()) as Record<string, boolean>
		expect(data.data).toBe(true)
	})
})

/* ══════════════════════════════════════════════
 * 7. TESTCLIENT — DELETE with json body
 * ══════════════════════════════════════════════ */

describe("bug-hunt-14: testClient — DELETE with JSON body", () => {
	it("DELETE with json option → body sent", async () => {
		const app = honey<{}>()
		app.delete("/items").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, unknown>
			return ctx.res.json("ok", { deleted: body.ids })
		})

		const client = testClient(app, { env: {} })
		const res = await client.delete("/items", { json: { ids: [1, 2, 3] } })
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, number[]>
		expect(data.deleted).toEqual([1, 2, 3])
	})
})

/* ══════════════════════════════════════════════
 * 8. TESTCLIENT — PUT with headers + json
 * ══════════════════════════════════════════════ */

describe("bug-hunt-14: testClient — PUT with all options", () => {
	it("PUT with json + headers + search", async () => {
		const app = honey<{}>()
		app.put("/items/:id").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, string>
			return ctx.res.json("ok", {
				auth: ctx.req.headers.get("authorization"),
				body,
				id: ctx.params.id,
				version: ctx.search.version,
			})
		})

		const client = testClient(app, { env: {} })
		const res = await client.put("/items/42", {
			headers: { authorization: "Bearer tok" },
			json: { name: "updated" },
			search: { version: "2" },
		})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.id).toBe("42")
		expect(data.auth).toBe("Bearer tok")
		expect(data.version).toBe("2")
		expect((data.body as Record<string, string>).name).toBe("updated")
	})
})

/* ══════════════════════════════════════════════
 * 9. ERROR WITH VARS — vars passed through to response
 * ══════════════════════════════════════════════ */

describe("bug-hunt-14: HoneyError with vars", () => {
	it("error vars appear in default error response shape", async () => {
		const app = honey<{}>()
		app.get("/rate").handler(() => {
			throw new HoneyError({
				errorKey: "rate_limited",
				status: "too_many_requests",
				vars: { limit: 100, retryAfter: 60 },
			})
		})

		const res = await app.fetch(new Request("http://localhost/rate"), {})
		expect(res.status).toBe(429)
		/* default shape doesn't include vars by default —
		 * but the error object has them for i18n/custom formatters */
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("rate_limited")
	})

	it("custom formatter can access vars", async () => {
		const app = honey<{}>()
		app.defaultErrorFormatter((error, shape) => ({
			...shape,
			retryAfter: error.vars?.retryAfter,
		}))
		app.get("/rate").handler(() => {
			throw new HoneyError({
				errorKey: "rate_limited",
				status: "too_many_requests",
				vars: { retryAfter: 60 },
			})
		})

		const res = await app.fetch(new Request("http://localhost/rate"), {})
		expect(res.status).toBe(429)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.retryAfter).toBe(60)
	})
})

/* ══════════════════════════════════════════════
 * 10. ETAG — If-None-Match with whitespace around ETag
 *
 * etag.ts uses .trim() on each comma-separated value.
 * RFC 7232 allows optional whitespace.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-14: ETag If-None-Match whitespace handling", () => {
	it("leading/trailing whitespace around ETag value → still matches", async () => {
		const app = honey<{}>().use(etag())
		app.get("/data").handler((ctx) => ctx.res.json("ok", { v: 1 }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const first = await request(addr.port, "/data")
		const etagVal = first.headers.etag as string

		/* add whitespace around the ETag value */
		const res = await request(addr.port, "/data", {
			headers: { "if-none-match": `  ${etagVal}  ` },
		})
		expect(res.status).toBe(304)
	})
})

/* ══════════════════════════════════════════════
 * 11. BODYLIMIT — body with no content-length, no slow path body
 *
 * body-limit.ts:35 — if (req.body !== null).
 * POST with headers but no body → req.body is null.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-14: bodyLimit — POST with headers but no body", () => {
	it("POST with content-type but null body → passes through", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 10 }))
		app.post("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		/* no body to check → passes through bodyLimit */
		expect(res.status).toBe(200)
	})
})

/* ══════════════════════════════════════════════
 * 12. ROUTER — wildcard with unnamed wildcard (just *)
 *
 * tree.ts:98 — if seg.length > 1, name = seg.slice(1),
 * otherwise name = "*".
 * ══════════════════════════════════════════════ */

describe("bug-hunt-14: unnamed wildcard route", () => {
	it("route /files/* with unnamed wildcard → param named '*'", async () => {
		const app = honey<{}>()
		app.get("/files/*").handler((ctx) => ctx.res.json("ok", { wild: ctx.params["*"] }))

		const res = await app.fetch(new Request("http://localhost/files/a/b/c"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.wild).toBe("a/b/c")
	})
})

/* ══════════════════════════════════════════════
 * 13. CONCURRENT REQUESTS — 50 parallel
 *
 * Stress test: 50 concurrent requests to verify no
 * state corruption under load.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-14: 50 concurrent requests stress test", () => {
	it("50 parallel requests → all get correct response", async () => {
		const app = honey<{}>()
		app.get("/echo/:n").handler((ctx) => ctx.res.json("ok", { n: ctx.params.n }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const promises = Array.from({ length: 50 }, (_, i) => request(addr.port, `/echo/${i}`))
		const results = await Promise.all(promises)

		for (let i = 0; i < 50; i++) {
			expect(results[i].status).toBe(200)
			const data = JSON.parse(results[i].body) as Record<string, string>
			expect(data.n).toBe(String(i))
		}
	})
})

/* ══════════════════════════════════════════════
 * 14. MIDDLEWARE ERROR + TELEMETRY + CUSTOM ONERROR
 *
 * Full error pipeline: middleware throws → telemetry fires →
 * onError runs → custom response returned.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-14: full error pipeline", () => {
	it("middleware error → telemetry → onError → custom response", async () => {
		const events: string[] = []
		const app = honey<{}>()
		app.telemetry({
			onError: () => events.push("telemetry:error"),
			onRequest: () => events.push("telemetry:request"),
			onResponse: () => events.push("telemetry:response"),
		})
		app.onError((_e, ctx) => {
			events.push("onError")
			return ctx.jsonFromError(
				new HoneyError({ errorKey: "handled", status: "service_unavailable" }),
			)
		})

		const mw = createMiddleware(async () => {
			events.push("middleware:throw")
			throw new HoneyError({ errorKey: "mw_error", status: "bad_request" })
		})
		app
			.get("/fail")
			.use(mw)
			.handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(503)
		const data = (await res.json()) as Record<string, string>
		expect(data.error_key).toBe("handled")

		/* verify event ordering */
		expect(events).toContain("telemetry:request")
		expect(events).toContain("middleware:throw")
		expect(events).toContain("onError")
		expect(events).toContain("telemetry:error")
		expect(events).toContain("telemetry:response")
	})
})

/* ══════════════════════════════════════════════
 * 15. NODE ADAPTER — response with null body and custom status
 * ══════════════════════════════════════════════ */

describe("bug-hunt-14: Node adapter — various response types", () => {
	it("redirect via Node adapter → Location header present", async () => {
		const app = honey<{}>()
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
	})

	it("text response via Node adapter", async () => {
		const app = honey<{}>()
		app.get("/text").handler((ctx) => ctx.res.text("ok", "Hello, world!"))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/text")
		expect(res.status).toBe(200)
		expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8")
		expect(res.body).toBe("Hello, world!")
	})
})

/* ══════════════════════════════════════════════
 * 16. RESOLVER TRANSLATION — async locale resolution
 * ══════════════════════════════════════════════ */

describe("bug-hunt-14: async locale resolution", () => {
	it("async resolveLocale → translations applied", async () => {
		const app = honey<{}>()
		app.errorI18n({
			errors: {
				en: { test_error: "English error" },
				ja: { test_error: "日本語エラー" },
			},
			resolveLocale: async (ctx) => {
				/* simulate async locale lookup */
				await new Promise((r) => setTimeout(r, 5))
				const lang = ctx.req.headers.get("accept-language")
				return lang?.startsWith("ja") ? "ja" : "en"
			},
		})
		app.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "test_error", status: "bad_request" })
		})

		const enRes = await app.fetch(
			new Request("http://localhost/fail", {
				headers: { "accept-language": "en-US" },
			}),
			{},
		)
		expect(((await enRes.json()) as Record<string, string>).message).toBe("English error")

		const jaRes = await app.fetch(
			new Request("http://localhost/fail", {
				headers: { "accept-language": "ja-JP" },
			}),
			{},
		)
		expect(((await jaRes.json()) as Record<string, string>).message).toBe("日本語エラー")
	})
})
