import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { bodyLimit } from "../../src/body-limit.ts"
import { cors } from "../../src/cors.ts"
import { HoneyError } from "../../src/error.ts"
import { defineErrors } from "../../src/errors.ts"
import { etag } from "../../src/etag.ts"
import { honey } from "../../src/index.ts"
import { createMiddleware } from "../../src/middleware.ts"
import { type HoneyServer, serve } from "../../src/node.ts"
import { requestId } from "../../src/request-id.ts"
import { serverTiming } from "../../src/server-timing.ts"
import { otelAdapter } from "../../src/telemetry/otel.ts"
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
 * 1. PRODUCTION-LIKE APP — all features combined
 *
 * CORS + CSRF + bodyLimit + etag + requestId +
 * serverTiming + secureHeaders + otel telemetry +
 * error factory + defaultErrors + i18n +
 * custom onError + input/output validation +
 * chain + route middleware.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-21: production-like app — everything combined", () => {
	function okSchema() {
		return {
			"~standard": {
				validate: (data: unknown) => ({ value: data }),
				vendor: "test",
				version: 1,
			},
		}
	}

	function mockTracer() {
		const spans: Array<{ ended: boolean; name: string }> = []
		return {
			spans,
			startSpan(name: string) {
				const span = {
					addEvent() {},
					attributes: {} as Record<string, unknown>,
					end() {
						span.ended = true
					},
					ended: false,
					name,
					setAttribute() {},
				}
				spans.push(span)
				return span
			},
		}
	}

	it("full production stack — happy path", async () => {
		const { secureHeaders } = await import("../../src/secure-headers.ts")
		const tracer = mockTracer()
		const errors = defineErrors({
			item_not_found: "not_found",
			rate_limited: "too_many_requests",
		})

		const authMw = createMiddleware(async (ctx, next) => {
			const req = (ctx as { req: Request }).req
			const token = req.headers.get("authorization")
			if (!token) throw new HoneyError({ errorKey: "unauthorized", status: "unauthorized" })
			return next({ userId: "u-1" })
		})

		const app = honey<{}>()
			.errorFactory(errors)
			.defaultErrors("rate_limited")
			.use(cors({ credentials: true, origin: "http://app.com" }))
			.use(bodyLimit({ maxSize: 50000 }))
			.use(etag())
			.use(requestId())
			.use(serverTiming())
			.use(secureHeaders())
			.basePath("/api")

		app.outputValidation("always")
		app.telemetry(otelAdapter({ tracer }))
		app.errorI18n({
			errors: { en: { item_not_found: "Item not found" } },
			resolveLocale: () => "en",
		})
		app.onError((_err, ctx) => {
			if (_err instanceof HoneyError && _err.errorKey === "unauthorized") {
				return ctx.jsonFromError(_err)
			}
			return undefined
		})
		/* public route */
		app.get("/health").handler((ctx) => ctx.res.text("ok", "healthy"))

		/* authed routes */
		const authed = app.use(authMw)
		authed
			.get("/items")
			.output({ "application/json": { ok: okSchema() } })
			.handler((ctx) => {
				ctx.timing.start("db")
				ctx.timing.end("db")
				return ctx.res.json("ok", [{ id: 1, name: "Widget" }])
			})

		authed
			.post("/items")
			.input({ json: okSchema() })
			.output({ "application/json": { created: okSchema() } })
			.errors("item_not_found")
			.handler((ctx) => ctx.res.json("created", { input: ctx.input, userId: ctx.userId }))

		authed
			.get("/items/:id")
			.errors("item_not_found")
			.handler((ctx) => {
				if (ctx.params.id === "0") throw errors.item_not_found()
				return ctx.res.json("ok", { id: ctx.params.id })
			})

		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* 1. Health check — no auth needed */
		const healthRes = await request(addr.port, "/api/health")
		expect(healthRes.status).toBe(200)
		expect(healthRes.body).toBe("healthy")
		expect(healthRes.headers["x-request-id"]).toBeTruthy()
		expect(healthRes.headers["x-content-type-options"]).toBe("nosniff")

		/* 2. List items — with auth + CORS */
		const listRes = await request(addr.port, "/api/items", {
			headers: {
				authorization: "Bearer tok-123",
				origin: "http://app.com",
			},
		})
		expect(listRes.status).toBe(200)
		expect(listRes.headers["access-control-allow-origin"]).toBe("http://app.com")
		expect(listRes.headers["access-control-allow-credentials"]).toBe("true")
		expect(listRes.headers.etag).toBeTruthy()
		expect(listRes.headers["server-timing"]).toBeTruthy()
		expect(listRes.headers["server-timing"]).toContain("db")
		const items = JSON.parse(listRes.body) as Array<{ name: string }>
		expect(items[0].name).toBe("Widget")

		/* 3. Conditional GET — ETag match → 304 */
		const condRes = await request(addr.port, "/api/items", {
			headers: {
				authorization: "Bearer tok-123",
				"if-none-match": listRes.headers.etag as string,
				origin: "http://app.com",
			},
		})
		expect(condRes.status).toBe(304)
		expect(condRes.headers["access-control-allow-origin"]).toBe("http://app.com")

		/* 4. Create item — POST with JSON body */
		const createRes = await request(addr.port, "/api/items", {
			body: JSON.stringify({ name: "Gadget" }),
			headers: {
				authorization: "Bearer tok-123",
				"content-type": "application/json",
				origin: "http://app.com",
			},
			method: "POST",
		})
		expect(createRes.status).toBe(201)

		/* 5. Get item — not found → 404 with i18n */
		const notFoundRes = await request(addr.port, "/api/items/0", {
			headers: { authorization: "Bearer tok-123" },
		})
		expect(notFoundRes.status).toBe(404)
		const nfData = JSON.parse(notFoundRes.body) as Record<string, string>
		expect(nfData.message).toBe("Item not found")

		/* 6. No auth → 401 */
		const unauthRes = await request(addr.port, "/api/items")
		expect(unauthRes.status).toBe(401)

		/* 7. 405 → method not allowed */
		const mnaRes = await request(addr.port, "/api/items", { method: "PATCH" })
		expect(mnaRes.status).toBe(405)
		expect(mnaRes.headers.allow).toBeTruthy()

		/* 8. CORS preflight */
		const preflightRes = await request(addr.port, "/api/items", {
			headers: {
				"access-control-request-headers": "content-type, authorization",
				"access-control-request-method": "POST",
				origin: "http://app.com",
			},
			method: "OPTIONS",
		})
		expect(preflightRes.status).toBe(204)
		expect(preflightRes.headers["access-control-allow-headers"]).toContain("content-type")

		/* 9. Telemetry spans fired */
		expect(tracer.spans.length).toBeGreaterThan(0)
		const requestSpans = tracer.spans.filter((s) => s.name === "http.request")
		expect(requestSpans.length).toBeGreaterThan(0)
	})
})

/* ══════════════════════════════════════════════
 * 2. TESTCLIENT — production-like workflow
 * ══════════════════════════════════════════════ */

describe("bug-hunt-21: testClient — production workflow", () => {
	it("auth flow with cookie jar + error handling", async () => {
		const errors = defineErrors({
			invalid_credentials: "unauthorized",
			session_expired: "unauthorized",
		})

		const app = honey<{}>().errorFactory(errors)

		app.post("/auth/login").handler(async (ctx) => {
			const body = (await ctx.req.json()) as { password: string; username: string }
			if (body.username !== "admin" || body.password !== "secret") {
				throw errors.invalid_credentials()
			}
			return ctx.res.json(
				"ok",
				{ user: body.username },
				{ cookies: { token: { httpOnly: true, path: "/", value: "valid-token" } } },
			)
		})

		app.get("/dashboard").handler((ctx) => {
			if (ctx.cookies.token !== "valid-token") {
				throw errors.session_expired()
			}
			return ctx.res.json("ok", { dashboard: true })
		})

		app
			.post("/auth/logout")
			.handler((ctx) =>
				ctx.res.json("ok", {}, { cookies: { token: { maxAge: 0, path: "/", value: "" } } }),
			)

		const client = testClient(app, { cookies: true, env: {} })

		/* wrong password → 401 */
		const badLogin = await client.post("/auth/login", {
			json: { password: "wrong", username: "admin" },
		})
		expect(badLogin.status).toBe(401)

		/* dashboard without login → 401 */
		const noAuth = await client.get("/dashboard")
		expect(noAuth.status).toBe(401)

		/* correct login → 200 + cookie set */
		const login = await client.post("/auth/login", {
			json: { password: "secret", username: "admin" },
		})
		expect(login.status).toBe(200)

		/* dashboard with cookie → 200 */
		const dash = await client.get("/dashboard")
		expect(dash.status).toBe(200)
		const dashData = (await dash.json()) as Record<string, boolean>
		expect(dashData.dashboard).toBe(true)

		/* logout → clears cookie */
		const logout = await client.post("/auth/logout")
		expect(logout.status).toBe(200)
	})
})

/* ══════════════════════════════════════════════
 * 3. STRESS TEST — 200 concurrent requests with mixed methods
 * ══════════════════════════════════════════════ */

describe("bug-hunt-21: stress test — 50 concurrent mixed requests", () => {
	it("50 parallel GET+POST → all isolated and correct", async () => {
		const app = honey<{}>().use(cors({ origin: "*" }))
		app.get("/echo/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id, method: "GET" }))
		app.post("/echo/:id").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, unknown>
			return ctx.res.json("created", { body, id: ctx.params.id, method: "POST" })
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* 50 concurrent — avoids ECONNRESET from OS socket limits in CI */
		const promises = Array.from({ length: 50 }, (_, i) =>
			i % 2 === 0
				? request(addr.port, `/echo/${i}`, {
						headers: { origin: "http://app.com" },
					})
				: request(addr.port, `/echo/${i}`, {
						body: JSON.stringify({ n: i }),
						headers: {
							"content-type": "application/json",
							origin: "http://app.com",
						},
						method: "POST",
					}),
		)
		const results = await Promise.all(promises)

		for (let i = 0; i < 50; i++) {
			const data = JSON.parse(results[i].body) as Record<string, unknown>
			expect(data.id).toBe(String(i))
			if (i % 2 === 0) {
				expect(results[i].status).toBe(200)
				expect(data.method).toBe("GET")
			} else {
				expect(results[i].status).toBe(201)
				expect(data.method).toBe("POST")
				expect((data.body as Record<string, number>).n).toBe(i)
			}
			/* CORS on every response */
			expect(results[i].headers["access-control-allow-origin"]).toBe("*")
		}
	})
})
